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
  mmcli helpers
*/
import { logger } from "../../helpers/logger.ts";
import { ALLOWED, run } from "../../helpers/run.ts";
import {
	handleMmcliCommand,
	shouldMockModems,
} from "../../mocks/providers/modems.ts";

import { setup } from "../setup.ts";
import {
	describeCliError,
	logParseError,
	type ParseResult,
	parseFail,
	parseOk,
} from "../system/cli-parse.ts";

export type ModemId = number;

export type NetworkType = {
	allowed: string;
	preferred: string;
};

export type ModemInfo = {
	"modem.generic.sim": string;
	"modem.generic.state": string;
	"modem.generic.ports": string;
	"modem.generic.model": string;
	"modem.generic.current-modes": string;
	"modem.generic.supported-modes": Array<string>;
	"modem.generic.equipment-identifier": string;
	"modem.generic.device-identifier": string;
	"modem.generic.access-technologies": Array<string>;
	"modem.generic.signal-quality.value": number;
	"modem.3gpp.operator-name"?: string;
	"modem.3gpp.registration-state"?: string;
};

export type SimInfo = {
	"sim.properties.iccid": string;
	"sim.properties.operator-code"?: string;
	"sim.properties.operator-name"?: string;
};

type NetworkTypeWithLabel = NetworkType & {
	label: string;
};

const mmcliBinary = setup.mmcli_binary ?? "mmcli";

// Allowlist the operator-pinned mmcli path (config-sourced, NOT RPC input) so
// run()'s allowlist gate accepts it; default "mmcli" is already present.
ALLOWED.add(mmcliBinary);

const mmcliKeyPattern = /\.length$/;
const mmcliValuePattern = /\.value\[\d+]$/;

/**
 * Valid ModemManager mode tokens accepted by `--set-allowed-modes` /
 * `--set-preferred-mode`. The `allowed` value may be a pipe-joined combination
 * (e.g. "4g|5g"), so it is validated token-by-token; `preferred` is a single
 * token and may additionally be "none".
 */
export const VALID_MODES: ReadonlySet<string> = new Set<string>([
	"any",
	"2g",
	"3g",
	"4g",
	"5g",
	"none",
]);

/**
 * Validate a mode spec built from RPC input before it becomes an mmcli flag
 * value. Splits pipe-joined combinations and checks each token against
 * {@link VALID_MODES}. Throws on any unknown token — this rejects argument
 * injection such as "--help; rm -rf /" outright.
 */
export function validateModeSpec(value: string): string {
	for (const token of value.split("|")) {
		if (!VALID_MODES.has(token)) {
			throw new Error(`invalid mode: ${value}`);
		}
	}
	return value;
}

export function mmcliParseSep(input: string) {
	const output: Record<string, string | Array<string>> = {};
	for (let line of input.split("\n")) {
		line = line.replace(/\\\d+/g, ""); // strips special escaped characters
		if (!line) {
			continue;
		}

		const kv = line.split(/:(.*)/); // splits on the first ':' only
		if (kv.length !== 3) {
			logger.warn(`mmcliParseSep: error parsing line ${line}`);
			continue;
		}
		let key = kv[0]?.trim();
		const value = kv[1]?.trim();
		if (key === undefined || value === undefined) {
			logger.warn(`mmcliParseSep: error parsing line ${line}`);
			continue;
		}

		// skip empty values
		if (value === "--") {
			continue;
		}

		// Parse mmcli arrays
		if (key.match(mmcliKeyPattern)) {
			key = key.replace(mmcliKeyPattern, "");
			output[key] = [];
		} else if (key.match(mmcliValuePattern)) {
			key = key.replace(mmcliValuePattern, "");
			output[key] ??= [];

			const target = output[key];
			if (Array.isArray(target)) {
				target.push(value);
			} else {
				logger.warn(`mmcliParseSep: mixed array and non-array for key ${key}`);
			}
		} else {
			output[key] = value;
		}
	}

	return output;
}

/**
 * Pure, version-tolerant extractor for a modem's model/manufacturer from
 * `mmcli -m <id> -J` output. Accepts either the raw JSON string or an
 * already-parsed object.
 *
 * ModemManager nests these fields under `modem.generic`; some versions also
 * (or instead) expose a `modem.hardware` block. We surface the RAW strings —
 * no normalization, no vendor-name guessing. On any unexpected/missing/
 * malformed input the function returns `{}` (or a partial result) and never
 * throws.
 */
export function parseMmcliModel(raw: string | object): {
	model?: string;
	manufacturer?: string;
} {
	let data: unknown = raw;

	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (!trimmed) return {};
		try {
			data = JSON.parse(trimmed);
		} catch {
			return {};
		}
	}

	if (data === null || typeof data !== "object") return {};

	const modem = (data as Record<string, unknown>).modem;
	if (modem === null || typeof modem !== "object") return {};

	const result: { model?: string; manufacturer?: string } = {};

	const pick = (value: unknown): string | undefined => {
		// mmcli emits "--" for empty fields — treat those as absent.
		if (typeof value !== "string") return undefined;
		const trimmed = value.trim();
		if (!trimmed || trimmed === "--") return undefined;
		return trimmed;
	};

	for (const blockName of ["generic", "hardware"] as const) {
		const block = (modem as Record<string, unknown>)[blockName];
		if (block === null || typeof block !== "object") continue;
		const fields = block as Record<string, unknown>;

		result.model ??= pick(fields.model);
		result.manufacturer ??= pick(fields.manufacturer);
	}

	if (result.model === undefined) delete result.model;
	if (result.manufacturer === undefined) delete result.manufacturer;

	return result;
}

export function mmConvertNetworkType(mmType: string): NetworkTypeWithLabel {
	const typeMatch = mmType.match(/^allowed: (.+); preferred: (.+)$/) as
		| [string, string, string]
		| null;
	if (typeMatch === null)
		throw new Error(`mmConvertNetworkType: invalid type ${mmType}`);

	const label = typeMatch[1].split(/,? /).sort().reverse().join("");
	const allowed = typeMatch[1].replace(/,? /g, "|");
	const preferred = typeMatch[2];
	return { label, allowed, preferred };
}

export function mmConvertNetworkTypes(mmTypes: Array<string>) {
	const types: Record<string, NetworkType> = {};
	for (const mmType of mmTypes) {
		const type = mmConvertNetworkType(mmType);
		const data = types[type.label];
		if (!data || data.preferred === "none" || data.preferred < type.preferred) {
			types[type.label] = { allowed: type.allowed, preferred: type.preferred };
		}
	}
	return types;
}

const accessTechToGen = {
	gsm: "2G",
	umts: "3G",
	hsdpa: "3G+",
	hsupa: "3G+",
	lte: "4G",
	"5gnr": "5G",
} as const;

const isAccessTech = (tech: string): tech is keyof typeof accessTechToGen =>
	tech in accessTechToGen;

export function mmConvertAccessTech(accessTechs?: Array<string>): string {
	if (!accessTechs || accessTechs.length === 0) {
		return "";
	}

	// Return the highest gen for situations such as 5G NSA, which will report "lte, 5gnr"
	let gen = "";
	for (const t of accessTechs) {
		if (!isAccessTech(t)) {
			logger.warn(`mmConvertAccessTech: unknown access tech ${t}`);
			continue;
		}

		const tech = accessTechToGen[t];
		if (tech > gen) {
			gen = tech;
		}
	}

	// If we only encountered unknown access techs, simply return the first one
	if (!gen) return accessTechs[0] ?? "";
	return gen;
}

// Regex: a ModemManager modem object path `…/Modem/<index>`.
const MODEM_PATH_INDEX_RE = /\/org\/freedesktop\/ModemManager1\/Modem\/(\d+)/;

/**
 * Extract modem indices from a parsed `mmcli -K -L` record. A MISSING
 * `modem-list` key is drift (mmcli always emits it, empty when no modems); a
 * non-empty list matching NO path is drift (path grammar changed). Both fail
 * loud instead of returning a silently-empty list that hides every modem.
 */
export function parseModemList(
	parsed: Record<string, string | Array<string>>,
): ParseResult<ModemId[]> {
	const raw = parsed["modem-list"];
	if (raw === undefined) {
		return parseFail(
			"parseModemList",
			"missing modem-list key",
			Object.keys(parsed).join(", "),
		);
	}
	const entries = Array.isArray(raw) ? raw : [raw];
	const list: ModemId[] = [];
	for (const m of entries) {
		const id = m.match(MODEM_PATH_INDEX_RE);
		if (id?.[1] !== undefined) {
			list.push(Number.parseInt(id[1], 10));
		}
	}
	if (entries.length > 0 && list.length === 0) {
		return parseFail(
			"parseModemList",
			"no modem indices matched the ModemManager path grammar",
			entries.join("; "),
		);
	}
	return parseOk(list);
}

export async function mmList() {
	try {
		// Check for mock mode
		if (shouldMockModems()) {
			const mockOutput = handleMmcliCommand(["-K", "-L"]);
			if (mockOutput) {
				const parsed = parseModemList(mmcliParseSep(mockOutput));
				if (!parsed.ok) {
					logParseError(parsed);
					return;
				}
				return parsed.value;
			}
		}

		const stdout = await run(mmcliBinary, ["-K", "-L"]);
		const parsed = parseModemList(mmcliParseSep(stdout));
		if (!parsed.ok) {
			logParseError(parsed);
			return;
		}
		return parsed.value;
	} catch (err) {
		logger.error(`mmList err: ${describeCliError(err)}`);
	}
}

export async function mmGetModem(id: ModemId) {
	try {
		// Check for mock mode
		if (shouldMockModems()) {
			const mockOutput = handleMmcliCommand(["-K", "-m", String(id)]);
			if (mockOutput) {
				return mmcliParseSep(mockOutput) as unknown as ModemInfo;
			}
		}

		const stdout = await run(mmcliBinary, ["-K", "-m", String(id)]);
		return mmcliParseSep(stdout) as unknown as ModemInfo;
	} catch (err) {
		logger.error(`mmGetModem err: ${describeCliError(err)}`);
	}
}

export async function mmGetSim(id: number) {
	try {
		// Check for mock mode
		if (shouldMockModems()) {
			const mockOutput = handleMmcliCommand(["-K", "-i", String(id)]);
			if (mockOutput) {
				return mmcliParseSep(mockOutput) as unknown as SimInfo;
			}
		}

		const stdout = await run(mmcliBinary, ["-K", "-i", String(id)]);
		return mmcliParseSep(stdout) as unknown as SimInfo;
	} catch (err) {
		logger.error(`mmGetSim err: ${describeCliError(err)}`);
	}
}

// Regex: mmcli's confirmation line for `--set-allowed-modes` / `--set-preferred-mode`.
const SET_MODES_OK_RE = /successfully set current modes in the modem/;

/** True when mmcli confirmed the mode change; false on any other output. */
export function parseSetModesSuccess(stdout: string): boolean {
	return SET_MODES_OK_RE.test(stdout);
}

export async function mmSetNetworkTypes(
	id: ModemId,
	allowed: string,
	preferred: string,
) {
	try {
		validateModeSpec(allowed);
		validateModeSpec(preferred);
		const args = ["-m", String(id), `--set-allowed-modes=${allowed}`];
		if (preferred !== "none") {
			args.push(`--set-preferred-mode=${preferred}`);
		}
		const stdout = await run(mmcliBinary, args);
		return parseSetModesSuccess(stdout);
	} catch (err) {
		logger.error(`mmSetNetworkTypes err: ${describeCliError(err)}`);
	}
}

export type NetworkScanResult = {
	"operator-code": string;
	"operator-name": string;
	availability?:
		| "unavailable"
		| "available"
		| "current"
		| "unknown"
		| "forbidden";
};

// ─────────────────────────────────────────────────────────────────────────────
// SIM PIN unlock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Modem path grammar accepted by `mmcli -m <path>`: either a bare numeric index
 * ("0") or a full ModemManager DBus object path. RPC input is matched against
 * this BEFORE it becomes an mmcli argument, so a hostile `modemPath` can never
 * smuggle a flag (leading `-`) or shell/argv metacharacter past run()'s
 * argv-only boundary.
 */
export const MODEM_PATH_RE: RegExp =
	/^(?:\/org\/freedesktop\/ModemManager1\/Modem\/\d+|\d+)$/;

/** Lock states ModemManager reports under `modem.generic.unlock-required`. */
export type SimLockRequired =
	| "none"
	| "sim-pin"
	| "sim-pin2"
	| "sim-puk"
	| "sim-puk2"
	| "unknown";

export type ModemUnlockInfo = {
	/** What ModemManager currently requires to unlock the SIM. */
	required: SimLockRequired;
	/** Remaining attempts per lock kind, e.g. `{ "sim-pin": 3 }`. */
	retries: Record<string, number>;
};

const KNOWN_LOCKS: ReadonlySet<string> = new Set<string>([
	"none",
	"sim-pin",
	"sim-pin2",
	"sim-puk",
	"sim-puk2",
]);

const UNLOCK_RETRY_PATTERN = /^([a-z0-9-]+)\s*\((\d+)\)$/i;

/**
 * Pure extractor for the lock-relevant fields of an already-`mmcliParseSep`'d
 * modem record. No I/O, never throws: an unknown / missing `unlock-required`
 * collapses to `"unknown"`. `unlock-retries` entries arrive as `"sim-pin (3)"`.
 */
export function parseModemUnlockInfo(
	parsed: Record<string, string | Array<string>>,
): ModemUnlockInfo {
	const requiredRaw = parsed["modem.generic.unlock-required"];
	const required: SimLockRequired =
		typeof requiredRaw === "string" && KNOWN_LOCKS.has(requiredRaw)
			? (requiredRaw as SimLockRequired)
			: "unknown";

	const retries: Record<string, number> = {};
	const retriesRaw = parsed["modem.generic.unlock-retries"];
	const entries = Array.isArray(retriesRaw)
		? retriesRaw
		: typeof retriesRaw === "string"
			? [retriesRaw]
			: [];
	for (const entry of entries) {
		const m = entry.match(UNLOCK_RETRY_PATTERN);
		if (m?.[1] !== undefined && m[2] !== undefined) {
			retries[m[1]] = Number.parseInt(m[2], 10);
		}
	}

	return { required, retries };
}

/**
 * Read a modem's SIM lock state via `mmcli -K -m <path>`. Returns `undefined`
 * on any mmcli failure (the caller maps that to an `"error"` terminal state).
 * This is a pure READ — it never registers/connects the modem, so it is safe to
 * call before the PIN submit to gate it.
 */
export async function mmGetModemUnlockInfo(
	modemPath: string,
): Promise<ModemUnlockInfo | undefined> {
	try {
		const stdout = await run(mmcliBinary, ["-K", "-m", modemPath]);
		return parseModemUnlockInfo(mmcliParseSep(stdout));
	} catch (err) {
		logger.error(`mmGetModemUnlockInfo err: ${describeCliError(err)}`);
		return undefined;
	}
}

/**
 * Submit a SIM PIN to a modem via `mmcli -m <path> --pin <pin>`.
 *
 * The PIN is passed as its OWN argv token (`["--pin", pin]`, NOT `--pin=<pin>`)
 * so run()'s redactArgs() — keyed on the preceding `--pin` flag — masks it to
 * `***` in the debug log. Rejects (via run/execFileP) on a non-zero exit, which
 * is how a wrong PIN surfaces to the caller.
 *
 * NOTE: execFileP's rejection `.message` embeds the full argv (PIN included), so
 * callers MUST NOT log that message verbatim. {@link unlockSimPin} only logs a
 * PIN-free summary.
 */
export async function mmSendSimPin(
	modemPath: string,
	pin: string,
): Promise<void> {
	await run(mmcliBinary, ["-m", modemPath, "--pin", pin]);
}

/**
 * Terminal result of a SIM PIN unlock attempt. Mirrors `simUnlockOutputSchema`
 * in `@ceraui/rpc`; kept as a local union so this low-level module carries no
 * dependency on the RPC schema layer.
 */
export type SimUnlockResult =
	| { state: "success" }
	| { state: "wrong-pin"; remainingAttempts?: number }
	| { state: "puk-required" }
	| { state: "no-locked-modem" }
	| { state: "error" };

/**
 * Submit a SIM PIN to a PIN-locked modem and classify the outcome.
 *
 * Ordering is the whole point: the lock state is READ first and the PIN is
 * submitted BEFORE the modem update loop is allowed to (re)register the modem —
 * callers run this under `withModemUpdateLock` so a registration poll cannot
 * race the unlock. The PIN is submitted EXACTLY ONCE; on failure we re-read the
 * lock state only to report remaining attempts and NEVER resubmit (a blind
 * resubmit walks the SIM toward an irreversible PUK lockout). The PIN is never
 * logged in plaintext.
 */
export async function unlockSimPin(
	modemPath: string,
	pin: string,
): Promise<SimUnlockResult> {
	// Defense in depth: the RPC schema already constrains both, but this is an
	// exported helper — reject anything that could escape the argv boundary.
	if (!MODEM_PATH_RE.test(modemPath) || !/^\d{4,8}$/.test(pin)) {
		logger.warn("unlockSimPin: rejected invalid modem path / pin shape");
		return { state: "error" };
	}

	const before = await mmGetModemUnlockInfo(modemPath);
	if (!before) {
		return { state: "error" };
	}

	// A PUK lock cannot be cleared with a PIN — surface it, never submit.
	if (before.required === "sim-puk" || before.required === "sim-puk2") {
		return { state: "puk-required" };
	}

	// Only a pending SIM-PIN actually blocks bonding. Anything else (none /
	// pin2 / unknown) means there is nothing for this RPC to unlock.
	if (before.required !== "sim-pin") {
		return { state: "no-locked-modem" };
	}

	try {
		// Submit ONCE, before any registration attempt.
		await mmSendSimPin(modemPath, pin);
		return { state: "success" };
	} catch {
		// Deliberately PIN-free: execFileP's error message embeds the argv
		// (PIN included), so we never log it. mmcli's stderr is also omitted.
		logger.warn(
			`SIM PIN unlock rejected for modem ${modemPath} (re-checking lock state)`,
		);

		// Re-read to classify: did the wrong PIN trip the SIM into PUK, and how
		// many PIN attempts remain? We do NOT resubmit.
		const after = await mmGetModemUnlockInfo(modemPath);
		if (after) {
			if (after.required === "sim-puk" || after.required === "sim-puk2") {
				return { state: "puk-required" };
			}
			const remainingAttempts = after.retries["sim-pin"];
			if (remainingAttempts !== undefined) {
				return { state: "wrong-pin", remainingAttempts };
			}
		}
		return { state: "wrong-pin" };
	}
}

/**
 * Submit a PUK + new PIN to a modem via
 * `mmcli -m <path> --puk <puk> --pin <newpin>`.
 *
 * Both secrets are passed as their own argv tokens so run()'s redactArgs() —
 * keyed on the preceding `--puk` / `--pin` flags — masks them to `***` in the
 * debug log. Rejects (via run/execFileP) on a non-zero exit, which is how a
 * wrong PUK surfaces to the caller.
 *
 * NOTE: execFileP's rejection `.message` embeds the full argv (both secrets), so
 * callers MUST NOT log that message verbatim.
 */
export async function mmSendSimPuk(
	modemPath: string,
	puk: string,
	newPin: string,
): Promise<void> {
	await run(mmcliBinary, ["-m", modemPath, "--puk", puk, "--pin", newPin]);
}

/**
 * Terminal result of a SIM PUK unlock attempt. Mirrors `simPukUnlockOutputSchema`
 * in `@ceraui/rpc`; kept as a local union so this low-level module carries no
 * dependency on the RPC schema layer.
 */
export type SimPukUnlockResult =
	| { success: true }
	| { success: false; error: "wrong-puk"; remainingAttempts?: number }
	| { success: false; error: "locked"; remainingAttempts: 0 }
	| { success: false; error: "no-locked-modem" }
	| { success: false; error: "error" };

/**
 * Submit a SIM PUK + new PIN to a PUK-locked modem and classify the outcome.
 *
 * Like {@link unlockSimPin}, the lock state is READ before the PUK is submitted
 * and the submit happens EXACTLY ONCE — a PUK has its own (typically 10) attempt
 * budget and exhausting it bricks the SIM permanently, so a blind resubmit is
 * never performed. On a wrong PUK the lock state is re-read only to report the
 * remaining PUK attempts; when those reach 0 the SIM is permanently `locked`.
 * Neither the PUK nor the new PIN is ever logged in plaintext.
 */
export async function unlockSimPuk(
	modemPath: string,
	puk: string,
	newPin: string,
): Promise<SimPukUnlockResult> {
	// Defense in depth: the RPC schema already constrains all three, but this is
	// an exported helper — reject anything that could escape the argv boundary.
	if (
		!MODEM_PATH_RE.test(modemPath) ||
		!/^\d{8}$/.test(puk) ||
		!/^\d{4,8}$/.test(newPin)
	) {
		logger.warn("unlockSimPuk: rejected invalid modem path / puk / pin shape");
		return { success: false, error: "error" };
	}

	const before = await mmGetModemUnlockInfo(modemPath);
	if (!before) {
		return { success: false, error: "error" };
	}

	// Only a pending SIM-PUK (or PUK2) is recoverable with a PUK; anything else
	// (none / pin / pin2 / unknown) means there is nothing for this RPC to do.
	if (before.required !== "sim-puk" && before.required !== "sim-puk2") {
		return { success: false, error: "no-locked-modem" };
	}

	const pukKind = before.required;

	try {
		await mmSendSimPuk(modemPath, puk, newPin);
		return { success: true };
	} catch {
		// Deliberately secret-free: execFileP's error message embeds the argv
		// (PUK + PIN included), so we never log it. mmcli's stderr is also omitted.
		logger.warn(
			`SIM PUK unlock rejected for modem ${modemPath} (re-checking lock state)`,
		);

		// Re-read to classify: how many PUK attempts remain? Zero means the SIM is
		// now permanently locked. We do NOT resubmit.
		const after = await mmGetModemUnlockInfo(modemPath);
		const remainingAttempts = after?.retries[pukKind];
		if (remainingAttempts === 0) {
			return { success: false, error: "locked", remainingAttempts: 0 };
		}
		if (remainingAttempts !== undefined) {
			return { success: false, error: "wrong-puk", remainingAttempts };
		}
		return { success: false, error: "wrong-puk" };
	}
}

/**
 * Parse the `modem.3gpp.scan-networks` entries of a parsed `--3gpp-scan` record
 * into {@link NetworkScanResult}s. A missing key means "no networks found" (a
 * valid empty scan). An entry that carries neither operator field is drift in
 * the `key: value, …` grammar and fails loud rather than yielding a junk row.
 */
export function parseNetworkScanResults(
	parsed: Record<string, string | Array<string>>,
): ParseResult<NetworkScanResult[]> {
	const raw = parsed["modem.3gpp.scan-networks"];
	if (raw === undefined) return parseOk([]);

	const entries = Array.isArray(raw) ? raw : [raw];
	const results: NetworkScanResult[] = [];
	for (const n of entries) {
		const fields: Record<string, string> = {};
		for (const entry of n.split(/, */)) {
			const kv = entry.split(/: */);
			const key = kv[0]?.trim();
			if (key) fields[key] = kv[1]?.trim() ?? "";
		}
		if (
			fields["operator-code"] === undefined &&
			fields["operator-name"] === undefined
		) {
			return parseFail(
				"parseNetworkScanResults",
				"scan entry missing both operator-code and operator-name",
				n,
			);
		}
		results.push(fields as NetworkScanResult);
	}
	return parseOk(results);
}

export async function mmNetworkScan(id: ModemId, timeout = 240) {
	try {
		// Check for mock mode
		if (shouldMockModems()) {
			const mockOutput = handleMmcliCommand([
				"-K",
				"-m",
				String(id),
				"--3gpp-scan",
			]);
			if (mockOutput) {
				const parsed = parseNetworkScanResults(mmcliParseSep(mockOutput));
				if (!parsed.ok) {
					logParseError(parsed);
					return;
				}
				return parsed.value;
			}
		}

		const stdout = await run(mmcliBinary, [
			`--timeout=${timeout}`,
			"-K",
			"-m",
			String(id),
			"--3gpp-scan",
		]);
		const parsed = parseNetworkScanResults(mmcliParseSep(stdout));
		if (!parsed.ok) {
			logParseError(parsed);
			return;
		}
		return parsed.value;
	} catch (err) {
		logger.error(`mmNetworkScan err: ${describeCliError(err)}`);
	}
}
