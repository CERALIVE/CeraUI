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

/**
 * The band verbs, over mmcli.
 *
 * WHY mmcli AND NOT THE D-BUS PORT. `@ceralive/modem-control` carries the real
 * `Modem.SetCurrentBands` wrapper, and CeraUI's own D-Bus transport
 * (`cellular/dbus-audit-transport.ts`) is FAIL-CLOSED and refuses every write
 * member by name — that refusal is precisely what makes it safe to point the
 * fleet default at the daemon mmcli is already driving. So a band WRITE cannot
 * travel that transport, and opening it would remove the reason the D-Bus
 * default is safe. mmcli is a client of the SAME ModemManager daemon and is the
 * live production path for every other modem mutation on this device
 * (`mmSetNetworkTypes`, the SIM PIN submits), so this is that path, not a new
 * one.
 *
 * Every parse here is pure and exported, so the fleet-modem fixtures assert on
 * real board-shaped `-K` output rather than on a mock's idea of it.
 */

import { BAND_ANY, BAND_NAME_RE } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";

import { MODEM_PATH_RE, mmcliBinary, mmcliParseSep } from "./mmcli.ts";

export const SUPPORTED_BANDS_KEY = "modem.generic.supported-bands";
export const CURRENT_BANDS_KEY = "modem.generic.current-bands";
export const STATE_KEY = "modem.generic.state";

/**
 * The states in which the radio is attached to a network. `connected` counts:
 * a modem carrying a bearer is registered by construction, and a band change
 * that landed while a bearer was up must not be reported as a lost registration.
 */
const REGISTERED_STATES: ReadonlySet<string> = new Set([
	"registered",
	"connected",
]);

export type BandRead =
	| {
			readonly ok: true;
			readonly supported: readonly string[];
			readonly current: readonly string[];
	  }
	| { readonly ok: false; readonly reason: "unknown_modem" | "read_failed" };

/**
 * Pull the two band lists out of parsed `-K` output.
 *
 * A member that is not a well-formed band token is DROPPED rather than passed
 * through: these strings become argv on the way back in, and the shape check is
 * what keeps a malformed one from ever getting there. mmcli prints `--` for an
 * empty list, which `mmcliParseSep` already skips, so an absent key and an empty
 * list are the same reading here — both mean "this modem advertises none".
 */
export function extractBands(parsed: Record<string, string | string[]>): {
	readonly supported: readonly string[];
	readonly current: readonly string[];
} {
	const read = (key: string): readonly string[] => {
		const value = parsed[key];
		if (!Array.isArray(value)) return [];
		return value.filter((band) => BAND_NAME_RE.test(band));
	};
	return {
		supported: read(SUPPORTED_BANDS_KEY),
		current: read(CURRENT_BANDS_KEY),
	};
}

/** Whether the radio is attached to a network, per mmcli's own state string. */
export function isRegisteredState(state: string | undefined): boolean {
	return state !== undefined && REGISTERED_STATES.has(state);
}

export function extractState(
	parsed: Record<string, string | string[]>,
): string | undefined {
	const value = parsed[STATE_KEY];
	return typeof value === "string" ? value : undefined;
}

/** mmcli's confirmation line for `--set-current-bands`. */
const SET_BANDS_OK_RE = /successfully set current bands in the modem/;

export function parseSetBandsSuccess(stdout: string): boolean {
	return SET_BANDS_OK_RE.test(stdout);
}

export interface BandMmcliDeps {
	readModem(device: string): Promise<string>;
	setBands(device: string, spec: string): Promise<string>;
}

export const defaultBandMmcliDeps: BandMmcliDeps = {
	readModem: (device) => run(mmcliBinary, ["-K", "-m", device]),
	setBands: (device, spec) =>
		run(mmcliBinary, ["-m", device, `--set-current-bands=${spec}`]),
};

let activeDeps: BandMmcliDeps = defaultBandMmcliDeps;

export function setBandMmcliDeps(deps: Partial<BandMmcliDeps>): void {
	activeDeps = { ...defaultBandMmcliDeps, ...deps };
}

export function resetBandMmcliDeps(): void {
	activeDeps = defaultBandMmcliDeps;
}

/**
 * The device selector is re-validated HERE, not only at the RPC boundary, for
 * the same reason `sim-pin2.ts` does it: this is the last point before the value
 * becomes an mmcli argument, and a leading `-` would otherwise parse as a flag.
 */
function isValidDevice(device: string): boolean {
	return MODEM_PATH_RE.test(device);
}

export async function readModemBands(
	device: string,
	deps: BandMmcliDeps = activeDeps,
): Promise<BandRead> {
	if (!isValidDevice(device)) return { ok: false, reason: "unknown_modem" };
	try {
		const parsed = mmcliParseSep(await deps.readModem(device));
		return { ok: true, ...extractBands(parsed) };
	} catch (err) {
		logger.warn("reading modem bands failed", {
			module: "modems",
			device,
			err,
		});
		return { ok: false, reason: "read_failed" };
	}
}

export async function readRegistrationState(
	device: string,
	deps: BandMmcliDeps = activeDeps,
): Promise<string | undefined> {
	if (!isValidDevice(device)) return undefined;
	try {
		return extractState(mmcliParseSep(await deps.readModem(device)));
	} catch {
		return undefined;
	}
}

/**
 * Ask the modem for a band selection. `false` means mmcli did not confirm.
 *
 * The whole selection is validated before ANY of it reaches argv — one
 * malformed token refuses the request rather than silently narrowing it, which
 * is the same fail-closed-as-a-whole rule `encodeBandList` applies one layer
 * down in `@ceralive/modem-control`. A partial band set is a DIFFERENT lock
 * from the one that was asked for.
 */
export async function writeModemBands(
	device: string,
	bands: readonly string[],
	deps: BandMmcliDeps = activeDeps,
): Promise<boolean> {
	if (!isValidDevice(device)) return false;
	if (bands.length === 0) return false;
	if (!bands.every((band) => BAND_NAME_RE.test(band))) return false;
	try {
		return parseSetBandsSuccess(await deps.setBands(device, bands.join(",")));
	} catch (err) {
		logger.warn("setting modem bands failed", {
			module: "modems",
			device,
			err,
		});
		return false;
	}
}

/** True when a selection is exactly the reset value. */
export function isUnlockedSelection(bands: readonly string[]): boolean {
	return bands.length === 1 && bands[0] === BAND_ANY;
}
