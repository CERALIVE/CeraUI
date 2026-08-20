/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
 * GNSS status, enable/disable, and the current fix, over the allowlisted mmcli
 * runner — the same daemon both cellular backends talk to, so this reads
 * identically under either selection.
 *
 * WHY THE FIX PARSER DOES NOT REUSE `mmcliParseSep`: that parser logs the
 * OFFENDING LINE VERBATIM on a split failure, and a `--location-get` line
 * carries the operator's coordinates. This is the same reasoning `mmcli-sms.ts`
 * records for message bodies, and it applies here for the same reason — a
 * content-free failure path is a property of the parser, not of its call sites.
 * `--location-status` DOES reuse it: that output is capability source names and
 * a refresh rate, and names no position.
 *
 * WHY `--location-set-enable-signal` is never sent: it makes ModemManager
 * broadcast the location over `PropertiesChanged`, which would put a position on
 * the system bus for every listener on the device. The fix is fetched by an
 * explicit `--location-get` instead, so coordinates only exist where somebody
 * asked for them.
 */

import type { GnssFix, GnssSource, ModemGpsRefusal } from "@ceraui/rpc/schemas";
import { GNSS_SOURCES } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import {
	handleMmcliCommand,
	shouldMockModems,
} from "../../mocks/providers/modems.ts";
import { describeCliError } from "../system/cli-parse.ts";
import { MODEM_PATH_RE, mmcliBinary, mmcliParseSep } from "./mmcli.ts";

export type LocationStatus = {
	readonly capabilities: readonly string[];
	readonly enabledSources: readonly string[];
	readonly gnssCapable: boolean;
	readonly gnssEnabled: boolean;
};

export type LocationStatusResult =
	| { ok: true; status: LocationStatus }
	| { ok: false; reason: ModemGpsRefusal };

export type LocationFixResult =
	| { ok: true; fix: GnssFix }
	| { ok: true; fix: undefined }
	| { ok: false; reason: ModemGpsRefusal };

export type LocationToggleResult =
	| { ok: true; status: LocationStatus }
	| { ok: false; reason: ModemGpsRefusal; detail?: string };

const CAPABILITIES_KEY = "modem.location.capabilities";
const ENABLED_KEY = "modem.location.enabled";

const GNSS_SOURCE_SET: ReadonlySet<string> = new Set<string>(GNSS_SOURCES);

/**
 * The mmcli flag that switches each source on. `gps-unmanaged` has no enable
 * flag of its own — ModemManager exposes it as raw-passthrough state rather than
 * something a client turns on — so it is deliberately absent and a request for
 * it is dropped rather than translated into a neighbouring flag.
 */
const ENABLE_FLAG: Readonly<Partial<Record<GnssSource, string>>> = {
	"gps-raw": "--location-enable-gps-raw",
	"gps-nmea": "--location-enable-gps-nmea",
	"agps-msa": "--location-enable-agps-msa",
	"agps-msb": "--location-enable-agps-msb",
};

const DISABLE_FLAG: Readonly<Partial<Record<GnssSource, string>>> = {
	"gps-raw": "--location-disable-gps-raw",
	"gps-nmea": "--location-disable-gps-nmea",
	"agps-msa": "--location-disable-agps-msa",
	"agps-msb": "--location-disable-agps-msb",
};

/** The sources this build asks for, strongest first. */
export const REQUESTED_GNSS_SOURCES: readonly GnssSource[] = [
	"gps-raw",
	"gps-nmea",
];

export function isGnssSource(value: string): value is GnssSource {
	return GNSS_SOURCE_SET.has(value);
}

export function hasGnssSource(sources: readonly string[]): boolean {
	return sources.some(isGnssSource);
}

/**
 * Classify an mmcli failure. The recognised strings are mmcli 1.24's own; a
 * failure none of them names stays `read_failed` rather than being guessed at.
 */
export function classifyLocationCliFailure(
	description: string,
): ModemGpsRefusal {
	if (/no location capabilities|not supported/i.test(description)) {
		return "unsupported";
	}
	if (/not enabled yet/i.test(description)) return "not_enabled";
	if (/couldn't find modem|cannot find modem/i.test(description)) {
		return "unknown_modem";
	}
	return "read_failed";
}

function asList(value: string | string[] | undefined): string[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

/**
 * Parse `mmcli -K -m <id> --location-status`.
 *
 * An ABSENT enabled key is a legitimate "nothing switched on" — mmcli prints
 * `--` for an empty list and `mmcliParseSep` drops it. An absent CAPABILITIES
 * key is different and fails loud: a modem with no location support at all is
 * reported by mmcli as an error, so reaching this parser with no capabilities
 * key means the output drifted, and answering "no GNSS" from it would hide a
 * working receiver.
 */
export function parseLocationStatus(raw: string): LocationStatusResult {
	const parsed = mmcliParseSep(raw);
	const capabilities = asList(parsed[CAPABILITIES_KEY]);
	if (capabilities.length === 0 && !raw.includes(CAPABILITIES_KEY)) {
		return { ok: false, reason: "read_failed" };
	}
	const enabledSources = asList(parsed[ENABLED_KEY]);
	return {
		ok: true,
		status: {
			capabilities,
			enabledSources,
			gnssCapable: hasGnssSource(capabilities),
			gnssEnabled: hasGnssSource(enabledSources),
		},
	};
}

const LAT_KEYS = ["modem.location.gps.latitude"] as const;
const LON_KEYS = ["modem.location.gps.longitude"] as const;
const ALT_KEYS = ["modem.location.gps.altitude"] as const;
const UTC_KEYS = ["modem.location.gps.utc"] as const;

function coordinate(
	value: string | undefined,
	limit: number,
): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseFloat(value);
	if (!Number.isFinite(parsed) || Math.abs(parsed) > limit) return undefined;
	return parsed;
}

/**
 * Parse one `mmcli -K -m <id> --location-get` record.
 *
 * CONTENT-FREE BY CONSTRUCTION, exactly like `parseSmsRecord`: it has its own
 * splitter and never puts a parsed line into a log or an error. Every line here
 * is a coordinate or is adjacent to one.
 *
 * A record present but carrying no usable pair is NOT a fix — MM populates the
 * keys as soon as the source is on, well before the receiver has locked, so
 * treating "the keys exist" as "we have a position" would render `0, 0`.
 */
export function parseLocationFix(
	raw: string,
	observedAt: number,
): GnssFix | undefined {
	const fields = new Map<string, string>();
	for (const line of raw.split("\n")) {
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		if (!key.startsWith("modem.location.") || value === "" || value === "--") {
			continue;
		}
		fields.set(key, value);
	}

	const pick = (keys: readonly string[]): string | undefined => {
		for (const key of keys) {
			const value = fields.get(key);
			if (value !== undefined) return value;
		}
		return undefined;
	};

	const latitude = coordinate(pick(LAT_KEYS), 90);
	const longitude = coordinate(pick(LON_KEYS), 180);
	if (latitude === undefined || longitude === undefined) return undefined;

	const altitude = coordinate(pick(ALT_KEYS), Number.POSITIVE_INFINITY);
	const utcTime = pick(UTC_KEYS);

	return {
		latitude,
		longitude,
		...(altitude === undefined ? {} : { altitude }),
		...(utcTime === undefined ? {} : { utcTime }),
		observedAt,
	};
}

export type LocationCliRunner = (args: string[]) => Promise<string>;

const defaultLocationRunner: LocationCliRunner = async (args) => {
	if (shouldMockModems()) {
		const mockOutput = handleMmcliCommand(args);
		if (mockOutput) return mockOutput;
	}
	return await run(mmcliBinary, args);
};

export async function readLocationStatus(
	modemPath: string,
	runCli: LocationCliRunner = defaultLocationRunner,
): Promise<LocationStatusResult> {
	if (!MODEM_PATH_RE.test(modemPath)) {
		logger.warn("readLocationStatus: rejected invalid modem path shape");
		return { ok: false, reason: "unknown_modem" };
	}
	let stdout: string;
	try {
		stdout = await runCli(["-K", "-m", modemPath, "--location-status"]);
	} catch (err) {
		const reason = classifyLocationCliFailure(describeCliError(err));
		logger.warn(
			`mmcli location status failed for modem ${modemPath}: ${reason}`,
		);
		return { ok: false, reason };
	}
	return parseLocationStatus(stdout);
}

/**
 * Read the current fix.
 *
 * `{ok: true, fix: undefined}` is a first-class success meaning the receiver
 * answered and has no position. It is never conflated with a refusal, because
 * "not locked on yet" and "this modem has no GNSS" call for different renders.
 */
export async function readLocationFix(
	modemPath: string,
	observedAt: number,
	runCli: LocationCliRunner = defaultLocationRunner,
): Promise<LocationFixResult> {
	if (!MODEM_PATH_RE.test(modemPath)) {
		return { ok: false, reason: "unknown_modem" };
	}
	let stdout: string;
	try {
		stdout = await runCli(["-K", "-m", modemPath, "--location-get"]);
	} catch (err) {
		// describeCliError is safe here: mmcli's failure text for a location read
		// names the modem and the missing capability, never a coordinate.
		const reason = classifyLocationCliFailure(describeCliError(err));
		logger.warn(`mmcli location get failed for modem ${modemPath}: ${reason}`);
		return { ok: false, reason };
	}
	return { ok: true, fix: parseLocationFix(stdout, observedAt) };
}

/**
 * Switch GNSS on or off, then re-read.
 *
 * Disable clears ONLY the GNSS flags. `3gpp-lac-ci` is the cell-info module's
 * source, and blanking it here would silently switch off a neighbouring feature
 * the operator never touched.
 *
 * The status is RE-READ afterwards rather than predicted, so the reply carries
 * what the modem reports and not what was asked for.
 */
export async function setLocationGnss(
	modemPath: string,
	enabled: boolean,
	runCli: LocationCliRunner = defaultLocationRunner,
): Promise<LocationToggleResult> {
	const before = await readLocationStatus(modemPath, runCli);
	if (!before.ok) return before;
	if (!before.status.gnssCapable) {
		return { ok: false, reason: "unsupported" };
	}

	const advertised = new Set(before.status.capabilities);
	const table = enabled ? ENABLE_FLAG : DISABLE_FLAG;
	const targets = enabled
		? REQUESTED_GNSS_SOURCES.filter((source) => advertised.has(source))
		: (before.status.enabledSources.filter(isGnssSource) as GnssSource[]);

	const flags = targets
		.map((source) => table[source])
		.filter((flag): flag is string => flag !== undefined);

	if (flags.length === 0) {
		// Disabling a modem with no GNSS source on is a no-op that already holds;
		// enabling one whose advertised sources this build cannot drive is not.
		return enabled
			? { ok: false, reason: "unsupported" }
			: { ok: true, status: before.status };
	}

	try {
		await runCli(["-m", modemPath, ...flags]);
	} catch (err) {
		const detail = describeCliError(err);
		logger.warn(`mmcli location ${enabled ? "enable" : "disable"} failed`, {
			module: "modems",
			modemPath,
		});
		return { ok: false, reason: classifyLocationCliFailure(detail), detail };
	}

	return readLocationStatus(modemPath, runCli);
}
