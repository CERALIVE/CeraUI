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
 * Runtime enablement of the Bluetooth services (a) and the boot reconciler (b2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OPERATOR DISABLE IS PERSISTENT-SYMMETRIC — `disable --now`, never stop-only
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Enable is `systemctl enable --now`; disable is `systemctl disable --now`, and
 * the symmetry is the whole point. A stop-only disable leaves the unit ENABLED,
 * so the operator's "Bluetooth off" survives exactly until the next reboot and
 * then silently reverses itself — with `bluealsad` holding a headset's SCO leg
 * on a device whose UI says Bluetooth is off. Do NOT "simplify" either direction
 * to `start`/`stop`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BOOT RECONCILER IS THE BELT; THE IMAGE POLICY IS THE SUSPENDERS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Todo 5 removed `bluetooth.service` from the device image's disable loop, so a
 * NEWLY-FLASHED image comes up with the unit in its packaged enable state. That
 * does nothing for the boards already in the field, which were flashed under the
 * OLD policy and still carry a disabled `bluetooth.service` in their `/etc`.
 * {@link reconcileBluetoothServices} is the belt for those: on every backend
 * start it re-applies the persisted preference in BOTH directions — enabling
 * when the operator had Bluetooth on, disabling when they had it off — so an
 * already-flashed board converges without a reflash, and a board whose image
 * ships Bluetooth enabled still honours an operator who turned it off.
 *
 * It works on BOTH kernels (D3) because it touches only systemd units: nothing
 * on this path reads a device tree, a driver name, or a kernel version.
 *
 * S6 fail-soft: the reconciler NEVER throws. Bluetooth is not on the boot
 * critical path, so every failure degrades to a logged, typed outcome and boot
 * continues. S1: every spawn is bounded. S2: every read goes through a named
 * parser. S4: nothing is caught silently.
 */

import { execFileP } from "../../helpers/exec.ts";
import { logger } from "../../helpers/logger.ts";
import { spawnWithTimeout } from "../../helpers/spawn-policy.ts";
import { isRealDevice as defaultIsRealDevice } from "../system/device-detection.ts";
import {
	type BluetoothAudioProvider,
	detectBluetoothAudioProvider,
} from "./bluetooth-audio-provider.ts";
import { type BtUnavailable, btUnavailable } from "./bluetooth-availability.ts";
import {
	BLUEALSA_BINARIES,
	BLUEALSA_DROPIN_DIR,
	BLUEALSA_DROPIN_PATH,
	BLUEALSA_MSBC_CODEC,
	BLUEALSA_PROBE_TIMEOUT_MS,
	BLUEALSA_PROFILES,
	BLUEALSA_UNIT,
	BLUETOOTH_UNIT,
	BLUETOOTH_UNITS,
	SYSTEMCTL_TIMEOUT_MS,
} from "./bluetooth-constants.ts";
import {
	isPersistentlyEnabled,
	isRunning,
	parseBluealsaHelp,
	parseUnitActiveState,
	parseUnitEnabledState,
} from "./bluetooth-parsers.ts";
import {
	type BluetoothPreference,
	type BluetoothPreferenceStore,
	defaultBluetoothPreferenceStore,
} from "./bluetooth-preference.ts";

/** What a single unit's apply did, so the caller can report it honestly. */
export interface UnitApplyRecord {
	readonly unit: string;
	/** `true` when the unit was already in the target state (idempotent no-op). */
	readonly alreadyApplied: boolean;
	/** `false` when systemd refused — the unit is missing or the apply failed. */
	readonly applied: boolean;
	readonly detail?: string;
}

export interface BluetoothServicesApplied {
	readonly ok: true;
	readonly enabled: boolean;
	readonly audioProvider: BluetoothAudioProvider;
	readonly units: readonly UnitApplyRecord[];
	/** The BlueALSA argument drop-in state after this apply. */
	readonly bluealsa: BluealsaDropInOutcome;
}

export type BluetoothServicesOutcome = BluetoothServicesApplied | BtUnavailable;

export interface BluealsaDropInOutcome {
	/** `undefined` when no BlueALSA daemon binary is installed. */
	readonly binary: string | undefined;
	/** Whether the build advertises wideband speech. PROBED, never assumed. */
	readonly msbc: boolean;
	/** Whether the drop-in was (re)written on this pass. */
	readonly written: boolean;
	readonly contents: string | undefined;
}

/** Minimal command result — captures stderr AND the exit code (S2). */
export interface CommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface BluetoothServicesDeps {
	isRealDevice: () => Promise<boolean>;
	/** argv-only, BOUNDED `systemctl <args>`. Never throws; reports exit codes. */
	systemctl: (args: readonly string[]) => Promise<CommandResult>;
	/** BOUNDED `<binary> --help`. Never throws; reports exit codes. */
	probeHelp: (binary: string) => Promise<CommandResult>;
	fileExists: (path: string) => Promise<boolean>;
	readFile: (path: string) => Promise<string | undefined>;
	writeDropIn: (dir: string, path: string, contents: string) => Promise<void>;
	preference: BluetoothPreferenceStore;
	log: (msg: string) => void;
	warn: (msg: string) => void;
}

/** BOUNDED systemctl that never throws — a non-zero exit IS the answer here. */
async function runSystemctl(args: readonly string[]): Promise<CommandResult> {
	try {
		const { stdout, stderr } = await execFileP("systemctl", [...args], {
			timeout: SYSTEMCTL_TIMEOUT_MS,
		});
		return { exitCode: 0, stdout, stderr };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; code?: number } | null;
		return {
			exitCode: typeof e?.code === "number" ? e.code : 1,
			stdout: e?.stdout ?? "",
			stderr: e?.stderr ?? String(err),
		};
	}
}

async function runHelpProbe(binary: string): Promise<CommandResult> {
	try {
		const res = await spawnWithTimeout([binary, "--help"], {
			timeoutMs: BLUEALSA_PROBE_TIMEOUT_MS,
		});
		return res;
	} catch (err) {
		logger.debug(`bluetooth: ${binary} --help probe failed: ${String(err)}`);
		return { exitCode: 1, stdout: "", stderr: String(err) };
	}
}

export const defaultBluetoothServicesDeps: BluetoothServicesDeps = {
	isRealDevice: () => defaultIsRealDevice(),
	systemctl: runSystemctl,
	probeHelp: runHelpProbe,
	fileExists: (p) => Bun.file(p).exists(),
	readFile: async (p) => {
		try {
			return await Bun.file(p).text();
		} catch (err) {
			logger.debug(`bluetooth: could not read ${p}: ${String(err)}`);
			return undefined;
		}
	},
	writeDropIn: async (dir, file, contents) => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(dir, { recursive: true });
		await Bun.write(file, contents);
	},
	preference: defaultBluetoothPreferenceStore,
	log: (msg) => logger.info(msg),
	warn: (msg) => logger.warn(msg),
};

// ─── BlueALSA drop-in ─────────────────────────────────────────────────────────

/**
 * The systemd drop-in body that gives BlueALSA its HFP-AG profile.
 *
 * PURE. The leading empty `ExecStart=` is REQUIRED: systemd treats `ExecStart`
 * as an additive list, so without the reset the drop-in appends a second command
 * to the distro's and the unit fails to start with "only one ExecStart is
 * allowed for Type=dbus/simple services".
 *
 * `-c msbc` is appended ONLY when the probe positively reported wideband
 * support. A build without it rejects the flag at startup, which turns a working
 * narrowband microphone into a unit that never comes up.
 */
export function buildBluealsaDropIn(
	binary: string,
	caps: { readonly msbc: boolean; readonly codecFlag: boolean },
): string {
	const args = BLUEALSA_PROFILES.flatMap((p) => ["-p", p]);
	if (caps.msbc && caps.codecFlag) args.push("-c", BLUEALSA_MSBC_CODEC);
	return [
		"# Managed by CeraUI (bluetooth foundation). Do not edit by hand.",
		"[Service]",
		"ExecStart=",
		`ExecStart=${binary} ${args.join(" ")}`,
		"",
	].join("\n");
}

/** The first installed BlueALSA daemon binary, or `undefined` when none is. */
export async function resolveBluealsaBinary(
	deps: BluetoothServicesDeps,
): Promise<string | undefined> {
	for (const candidate of BLUEALSA_BINARIES) {
		if (await deps.fileExists(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Ensure the BlueALSA drop-in matches what this build wants, writing it only on
 * a real difference so a reconcile on an already-converged host writes nothing.
 */
export async function ensureBluealsaDropIn(
	deps: BluetoothServicesDeps,
): Promise<BluealsaDropInOutcome> {
	const binary = await resolveBluealsaBinary(deps);
	if (binary === undefined) {
		deps.warn(
			`bluetooth: no BlueALSA daemon found at ${BLUEALSA_BINARIES.join(" or ")}; leaving ${BLUEALSA_UNIT} arguments alone`,
		);
		return {
			binary: undefined,
			msbc: false,
			written: false,
			contents: undefined,
		};
	}

	const probe = await deps.probeHelp(binary);
	const parsed = parseBluealsaHelp([probe.stdout, probe.stderr].join("\n"));
	if (!parsed.ok) {
		// S2/S4: an unreadable help text is reported, never guessed past. The
		// drop-in is still written — WITHOUT a codec flag, which is the shape
		// every bluez-alsa release accepts.
		deps.warn(
			`bluetooth: could not read ${binary} --help (${parsed.kind}: ${parsed.detail}); shipping BlueALSA profiles with no codec flag`,
		);
	}
	const caps = parsed.ok ? parsed.value : { msbc: false, codecFlag: false };

	const contents = buildBluealsaDropIn(binary, caps);
	const existing = await deps.readFile(BLUEALSA_DROPIN_PATH);
	if (existing === contents) {
		return { binary, msbc: caps.msbc, written: false, contents };
	}

	try {
		await deps.writeDropIn(BLUEALSA_DROPIN_DIR, BLUEALSA_DROPIN_PATH, contents);
	} catch (err) {
		deps.warn(
			`bluetooth: could not write the BlueALSA drop-in: ${String(err)}`,
		);
		return { binary, msbc: caps.msbc, written: false, contents };
	}

	// A changed drop-in is inert until systemd re-reads it.
	const reload = await deps.systemctl(["daemon-reload"]);
	if (reload.exitCode !== 0) {
		deps.warn(
			`bluetooth: systemctl daemon-reload failed after writing the BlueALSA drop-in: ${reload.stderr.trim()}`,
		);
	}
	return { binary, msbc: caps.msbc, written: true, contents };
}

// ─── Unit apply ───────────────────────────────────────────────────────────────

/** Whether `unit` is already in the target enable+active state (idempotency). */
async function unitAlreadyApplied(
	deps: BluetoothServicesDeps,
	unit: string,
	enabled: boolean,
): Promise<{ readonly settled: boolean; readonly missing: boolean }> {
	const enabledRead = await deps.systemctl(["is-enabled", unit]);
	const enabledParsed = parseUnitEnabledState(enabledRead.stdout);
	if (!enabledParsed.ok) {
		// EMPTY output is systemd saying it cannot find the unit at all — the
		// `bluealsad.service` typo class. Report it; never read it as "disabled".
		if (enabledParsed.kind === "empty-output") {
			deps.warn(
				`bluetooth: systemd knows no unit ${unit} (${enabledRead.stderr.trim() || "no stderr"})`,
			);
			return { settled: false, missing: true };
		}
		deps.warn(
			`bluetooth: unreadable is-enabled for ${unit} (${enabledParsed.kind}: ${enabledParsed.detail})`,
		);
		return { settled: false, missing: false };
	}

	const activeRead = await deps.systemctl(["is-active", unit]);
	const activeParsed = parseUnitActiveState(activeRead.stdout);
	if (!activeParsed.ok) {
		deps.warn(
			`bluetooth: unreadable is-active for ${unit} (${activeParsed.kind}: ${activeParsed.detail})`,
		);
		return { settled: false, missing: false };
	}

	const persistent = isPersistentlyEnabled(enabledParsed.value);
	const running = isRunning(activeParsed.value);
	return {
		settled: persistent === enabled && running === enabled,
		missing: false,
	};
}

/**
 * Apply ONE unit to the target state.
 *
 * `enable --now` / `disable --now` — both directions persistent, both idempotent
 * by construction, and skipped entirely when the unit already reads as settled
 * so a converged host issues no mutation at all.
 */
async function applyUnit(
	deps: BluetoothServicesDeps,
	unit: string,
	enabled: boolean,
): Promise<UnitApplyRecord> {
	const state = await unitAlreadyApplied(deps, unit, enabled);
	if (state.missing) {
		return {
			unit,
			alreadyApplied: false,
			applied: false,
			detail: "unit_missing",
		};
	}
	if (state.settled) {
		return { unit, alreadyApplied: true, applied: true };
	}

	const verb = enabled ? "enable" : "disable";
	const res = await deps.systemctl([verb, "--now", unit]);
	if (res.exitCode !== 0) {
		deps.warn(
			`bluetooth: systemctl ${verb} --now ${unit} failed (exit ${res.exitCode}): ${res.stderr.trim()}`,
		);
		return {
			unit,
			alreadyApplied: false,
			applied: false,
			detail: res.stderr.trim().slice(0, 200),
		};
	}
	deps.log(`bluetooth: systemctl ${verb} --now ${unit}`);
	return { unit, alreadyApplied: false, applied: true };
}

/**
 * Apply the operator's Bluetooth preference to the host.
 *
 * Persists FIRST (the operator's intent is the truth; the units are reconciled
 * toward it), then applies. A dev/emulated host is refused BEFORE anything is
 * persisted or spawned, with the typed `bt_unavailable` / `emulated` outcome.
 */
export async function setBluetoothEnabled(
	enabled: boolean,
	deps: BluetoothServicesDeps = defaultBluetoothServicesDeps,
): Promise<BluetoothServicesOutcome> {
	if (!(await deps.isRealDevice())) {
		return btUnavailable(
			"emulated",
			"bluetooth service control is unavailable on a dev/emulated host",
		);
	}

	deps.preference.write({ enabled });
	return applyPreference({ enabled }, deps);
}

/** Apply a preference to the host units. Shared by the operator and boot paths. */
async function applyPreference(
	preference: BluetoothPreference,
	deps: BluetoothServicesDeps,
): Promise<BluetoothServicesApplied> {
	const audioProvider = await detectBluetoothAudioProvider(deps);
	// The drop-in is written BEFORE `bluealsa.service` is started, so the very
	// first start already carries the HFP-AG profile rather than needing a
	// second restart to pick it up.
	const bluealsa =
		preference.enabled && audioProvider === "bluealsa"
			? await ensureBluealsaDropIn(deps)
			: { binary: undefined, msbc: false, written: false, contents: undefined };

	const units: UnitApplyRecord[] = [];
	const governedUnits =
		audioProvider === "bluealsa" ? BLUETOOTH_UNITS : [BLUETOOTH_UNIT];
	for (const unit of governedUnits) {
		units.push(await applyUnit(deps, unit, preference.enabled));
	}

	return {
		ok: true,
		enabled: preference.enabled,
		audioProvider,
		units,
		bluealsa,
	};
}

// ─── Boot reconciler (b2) ─────────────────────────────────────────────────────

let reconcileInFlight = false;

/**
 * Re-apply the persisted preference at backend start, in BOTH directions.
 *
 * NEVER throws (S6 — Bluetooth must not gate boot), self-serialises, and is a
 * no-op on a dev/emulated host and on a device whose operator has never
 * expressed a preference (see `bluetooth-preference.ts`: absent is not `false`).
 */
export async function reconcileBluetoothServices(
	deps: BluetoothServicesDeps = defaultBluetoothServicesDeps,
): Promise<BluetoothServicesOutcome> {
	if (reconcileInFlight) {
		return btUnavailable("emulated", "reconcile already in flight");
	}
	reconcileInFlight = true;
	try {
		if (!(await deps.isRealDevice())) {
			deps.log(
				"bluetooth: service reconcile skipped (emulated / not a real device)",
			);
			return btUnavailable("emulated", "not a real device");
		}

		const preference = deps.preference.read();
		if (preference === undefined) {
			deps.log(
				"bluetooth: no persisted preference; leaving the image's unit state alone",
			);
			return {
				ok: true,
				enabled: false,
				audioProvider: "unavailable",
				units: [],
				bluealsa: {
					binary: undefined,
					msbc: false,
					written: false,
					contents: undefined,
				},
			};
		}

		deps.log(
			`bluetooth: reconciling ${BLUETOOTH_UNIT} + ${BLUEALSA_UNIT} to the persisted preference (enabled=${preference.enabled})`,
		);
		return await applyPreference(preference, deps);
	} catch (err) {
		deps.warn(
			`bluetooth: service reconcile aborted (non-fatal): ${String(err)}`,
		);
		return btUnavailable("unit_missing", String(err));
	} finally {
		reconcileInFlight = false;
	}
}

/** Test isolation seam — clears the reconciler's self-serialisation latch. */
export function resetBluetoothServiceReconcileForTest(): void {
	reconcileInFlight = false;
}
