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
 * Add-on manager — the runtime state machine that materialises, enables and
 * disables optional sysext add-ons on the device (T28). It is the orchestration
 * layer over three lower trust tiers:
 *
 *   - the privileged `ceralive-addon-helper` root binary (T27, via
 *     helpers/addon-helper.ts) — the ONLY component that mutates the sysext
 *     scan dir / drives systemd units / re-verifies sig + sha256 (G-trust);
 *   - the per-add-on runtime state persisted under config.json's `addons` key
 *     (T23 setAddonState/removeAddonState, atomic E3 writes);
 *   - the descriptor + state Zod schemas (T22, @ceraui/rpc/schemas).
 *
 * It mirrors the kiosk state machine (modules/system/kiosk.ts) deliberately:
 *   - every OS-touching primitive is injected through {@link AddonManagerDeps}
 *     so the whole machine is unit-testable without a board, sudo, or network;
 *   - the SAME crash-loop discriminator (NRestarts >= threshold → mask +
 *     auto-disable) keeps a crash-looping add-on from wedging the device;
 *   - EVERY mutating op gates on `isRealDevice()` FIRST (G6) and returns
 *     {@link ADDON_UNAVAILABLE_ERROR} in dev/emulated mode, never touching
 *     systemd/sysext/the network.
 *
 * The manager tracks a richer lifecycle than the persisted `AddonState.phase`
 * enum exposes; {@link toAddonState}/{@link phaseFromState} losslessly map the
 * manager's {@link AddonManagerPhase} onto a schema-valid `AddonState` so the
 * config file always parses (the persisted phase + `enabled` + `autoDisabled`
 * triple encodes the manager phase).
 */

import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type {
	AddonDescriptor,
	AddonPhase,
	AddonState,
} from "@ceraui/rpc/schemas";

import {
	ADDON_UNAVAILABLE_ERROR,
	addonDisable,
	addonEnable,
} from "../../helpers/addon-helper.ts";
import { type ExecResult, execFileP } from "../../helpers/exec.ts";
import { logger } from "../../helpers/logger.ts";
import { getAddons, removeAddonState, setAddonState } from "../config.ts";
import { getEffectiveHardware as getEffectiveHardwareImpl } from "../streaming/pipelines.ts";
import { isRealDevice } from "../system/device-detection.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";

// Re-export the helper's emulated-mode error so callers resolve the single
// source from the manager surface (mirrors kiosk re-exporting isRealDevice).
export { ADDON_UNAVAILABLE_ERROR };

/** Returned when `/data` cannot fit the materialised add-on plus headroom. */
export const ADDON_INSUFFICIENT_SPACE_ERROR = "addon_insufficient_space";
/** A step in the enable pipeline threw — the add-on is parked in `failed`. */
export const ADDON_ENABLE_FAILED_ERROR = "addon_enable_failed";
/** A step in the disable pipeline threw. */
export const ADDON_DISABLE_FAILED_ERROR = "addon_disable_failed";
/** The post-enable validation probe failed — the add-on was auto-disabled. */
export const ADDON_VALIDATION_FAILED_ERROR = "addon_validation_failed";
/** lastError reason persisted when a crash-loop triggers the auto-disable. */
export const ADDON_CRASH_LOOP_REASON = "addon_crash_loop";

/** Install/enable refused (T23): the effective board is not in `compatibleHardware`. */
export const ADDON_INCOMPATIBLE_HARDWARE_ERROR = "addon_incompatible_hardware";
/** Install/enable refused (T23): a required `deps[]` add-on is not enabled. */
export const ADDON_DEPENDENCY_MISSING_ERROR = "addon_dependency_missing";
/** Install/enable refused (T23): a `conflicts[]` add-on is currently enabled. */
export const ADDON_CONFLICT_ERROR = "addon_conflict";

/** Broadcast channel for per-add-on state pushes. */
export const ADDON_EVENT = "addons";

/** The /data filesystem add-ons are staged on. */
const DATA_MOUNT = "/data";
/** Atomic download landing zone (renamed into the scan dir on verify). */
const DATA_TMP_DIR = "/data/tmp";
/** systemd-sysext scan dir — where a materialised `.raw` is activated from. */
const DATA_EXT_DIR = "/data/extensions";

/** 512 MiB of slack kept free on /data beyond the materialised payload (E1). */
export const ADDON_FREE_SPACE_HEADROOM_BYTES = 512 * 1024 * 1024;

/**
 * NRestarts at/above which a failing unit is treated as a crash-loop and the
 * add-on is masked + auto-disabled. Matches the kiosk threshold (3).
 */
export const ADDON_CRASH_LOOP_RESTART_THRESHOLD = 3;

/** Fallback validation-probe timeout when the descriptor omits `validate.timeout`. */
const DEFAULT_VALIDATE_TIMEOUT_MS = 10_000;

/** Descriptor `units` sub-shape (unmask/enable/start lists), all optional. */
type AddonUnits = NonNullable<AddonDescriptor["units"]>;

/** The board values an add-on may declare in `compatibleHardware` (schema-derived). */
export type AddonHardware = NonNullable<
	AddonDescriptor["compatibleHardware"]
>[number];

/**
 * Manager-level lifecycle phase. Richer than the persisted `AddonState.phase`
 * enum: it distinguishes the user-intent + in-flight transitions the UI shows.
 *
 *   disabled  ── enable ──▶ enabling ──▶ enabled
 *   enabled   ── disable ─▶ disabling ─▶ disabled
 *   enabling/enabled ── failure ─▶ failed | auto_disabled
 *   pending   = enable intended, not yet materialised (restored from config)
 */
export type AddonManagerPhase =
	| "disabled"
	| "pending"
	| "enabling"
	| "enabled"
	| "disabling"
	| "failed"
	| "auto_disabled";

export const ADDON_MANAGER_PHASES: readonly AddonManagerPhase[] = [
	"disabled",
	"pending",
	"enabling",
	"enabled",
	"disabling",
	"failed",
	"auto_disabled",
];

/** Outcome of an enable/disable op (mirrors the RPC setter `{success,...}` shape). */
export type AddonOpResult =
	| { success: true; phase: AddonManagerPhase }
	| { success: false; error: string };

// ─── pure phase encoding (manager phase ⇄ schema-valid AddonState) ───────────

type PhaseEncoding = {
	enabled: boolean;
	phase: AddonPhase;
	autoDisabled: boolean;
};

/**
 * The lossless encoding of each manager phase onto the persisted triple. Chosen
 * so {@link phaseFromState} is an exact inverse — no two manager phases collide.
 */
const PHASE_ENCODING: Record<AddonManagerPhase, PhaseEncoding> = {
	disabled: { enabled: false, phase: "idle", autoDisabled: false },
	pending: { enabled: true, phase: "idle", autoDisabled: false },
	enabling: { enabled: true, phase: "installing", autoDisabled: false },
	enabled: { enabled: true, phase: "active", autoDisabled: false },
	disabling: { enabled: false, phase: "disabling", autoDisabled: false },
	failed: { enabled: true, phase: "error", autoDisabled: false },
	auto_disabled: { enabled: false, phase: "error", autoDisabled: true },
};

/** Project a manager phase (+ optional metadata) onto a schema-valid AddonState. */
export function toAddonState(
	phase: AddonManagerPhase,
	extra: {
		versionMaterialized?: string;
		userConfig?: Record<string, unknown>;
		lastError?: string;
	} = {},
): AddonState {
	const enc = PHASE_ENCODING[phase];
	const state: AddonState = {
		enabled: enc.enabled,
		phase: enc.phase,
		autoDisabled: enc.autoDisabled,
	};
	// exactOptionalPropertyTypes: only attach optionals when actually present.
	if (extra.versionMaterialized !== undefined) {
		state.versionMaterialized = extra.versionMaterialized;
	}
	if (extra.userConfig !== undefined) state.userConfig = extra.userConfig;
	if (extra.lastError !== undefined) state.lastError = extra.lastError;
	return state;
}

// Inverse of toAddonState. `default` (not an explicit idle case) keeps this total
// as the persisted AddonPhase enum grows (e.g. the reconciler's `pending`, T29):
// an enabled add-on in any idle/pending-like phase → `pending`, disabled → `disabled`.
export function phaseFromState(state: AddonState): AddonManagerPhase {
	if (state.autoDisabled) return "auto_disabled";
	switch (state.phase) {
		case "active":
			return "enabled";
		case "installing":
			return "enabling";
		case "disabling":
			return "disabling";
		case "error":
			return "failed";
		default:
			return state.enabled ? "pending" : "disabled";
	}
}

// ─── compatibility gate (hardware ∩ deps ∩ conflicts) — T23 ──────────────────

/** An add-on counts as "enabled" for deps/conflicts only once fully active. */
export function isAddonEnabledState(state: AddonState | undefined): boolean {
	return state !== undefined && phaseFromState(state) === "enabled";
}

/**
 * The server-side install/enable gate. Returns the structured error code that
 * must reject the install, or `null` when the add-on may proceed:
 *   - `compatibleHardware` present but excluding the effective board → incompatible;
 *   - any `deps[]` add-on not currently enabled → dependency missing;
 *   - any `conflicts[]` add-on currently enabled → conflict.
 * An absent `compatibleHardware` means all-hardware and is never rejected.
 */
export function addonCompatibilityError(
	descriptor: AddonDescriptor,
	effectiveHardware: AddonHardware,
	getState: (id: string) => AddonState | undefined,
): string | null {
	const compatible = descriptor.compatibleHardware;
	if (compatible !== undefined && !compatible.includes(effectiveHardware)) {
		return ADDON_INCOMPATIBLE_HARDWARE_ERROR;
	}
	for (const depId of descriptor.deps ?? []) {
		if (!isAddonEnabledState(getState(depId))) {
			return ADDON_DEPENDENCY_MISSING_ERROR;
		}
	}
	for (const conflictId of descriptor.conflicts ?? []) {
		if (isAddonEnabledState(getState(conflictId))) {
			return ADDON_CONFLICT_ERROR;
		}
	}
	return null;
}

// ─── pure helpers (free-space, crash-loop, paths, url, df) ───────────────────

/** Bytes that must be free on /data to enable: payload ×2 + 512 MiB headroom. */
export function requiredFreeBytes(sizeInstalled: number): number {
	return sizeInstalled * 2 + ADDON_FREE_SPACE_HEADROOM_BYTES;
}

/** E1 precheck: is there room for the materialised add-on plus headroom? */
export function hasSufficientSpace(
	freeBytes: number,
	sizeInstalled: number,
): boolean {
	return freeBytes > requiredFreeBytes(sizeInstalled);
}

/** A failing unit with this many restarts is a crash-loop (→ auto-disable). */
export function isAddonCrashLoop(nRestarts: number): boolean {
	return nRestarts >= ADDON_CRASH_LOOP_RESTART_THRESHOLD;
}

/** Atomic download target for an add-on id (renamed into the scan dir on verify). */
export function tmpArtifactPath(id: string): string {
	return `${DATA_TMP_DIR}/${id}.raw.tmp`;
}

/** Materialised sysext payload path for an add-on id. */
export function extArtifactPath(id: string): string {
	return `${DATA_EXT_DIR}/${id}.raw`;
}

/** Substitute the OS VERSION_ID into the descriptor's `{os_version}` template. */
export function resolveArtifactUrl(
	urlTemplate: string,
	osVersion: string,
): string {
	return urlTemplate.replace(/\{os_version\}/g, osVersion);
}

/** Parse the available-bytes column from `df -B1 --output=avail <mount>`. */
export function parseDfAvail(stdout: string): number | null {
	const lines = stdout.trim().split("\n");
	const data = lines[lines.length - 1];
	if (data === undefined) return null;
	const avail = Number.parseInt(data.trim().split(/\s+/)[0] ?? "", 10);
	return Number.isFinite(avail) ? avail : null;
}

/** All distinct unit names referenced by a descriptor (unmask ∪ enable ∪ start). */
function allUnits(units: AddonUnits | undefined): string[] {
	if (!units) return [];
	return [
		...new Set([
			...(units.unmask ?? []),
			...(units.start ?? []),
			...(units.enable ?? []),
		]),
	];
}

// ─── injectable I/O surface ──────────────────────────────────────────────────

/**
 * Every OS/network/persistence primitive the state machine touches. Defaults
 * talk to the real device (sudo helper, argv-only systemctl, df, fetch, atomic
 * fs ops, config writes). Tests inject deterministic spies. Mirrors `KioskDeps`.
 */
export type AddonManagerDeps = {
	/** G6 gate — true only on a real RK3588 board. */
	isRealDevice: () => Promise<boolean>;
	/** Effective board (resolves `generic`) for the compatibleHardware gate (T23). */
	getEffectiveHardware: () => AddonHardware;
	/** Free bytes on /data (E1 precheck input). */
	getDataFreeBytes: () => Promise<number>;
	/** OS VERSION_ID substituted into the artifact url template. */
	getOsVersion: () => Promise<string>;
	/** Download `url` → `destTmp` (an atomic temp under /data/tmp). */
	download: (url: string, destTmp: string) => Promise<void>;
	/** sha256 (+ GPG via the helper) verify the staged temp; reject on mismatch. */
	verify: (descriptor: AddonDescriptor, tmpPath: string) => Promise<void>;
	/** Atomic rename `tmpPath` → `destPath` in the sysext scan dir. */
	stage: (tmpPath: string, destPath: string) => Promise<void>;
	/** Privileged `ceralive-addon-helper enable <id>` (re-verifies + refreshes). */
	helperEnable: (id: string) => Promise<void>;
	/** Privileged `ceralive-addon-helper disable <id>`. */
	helperDisable: (id: string) => Promise<void>;
	/** argv-only `systemctl <args>` for unit unmask/start/stop/mask. */
	systemctl: (args: string[]) => Promise<ExecResult>;
	/** NRestarts for a unit — the crash-loop discriminator. */
	getNRestarts: (unit: string) => Promise<number>;
	/** Run `descriptor.validate.cmd`; resolve true on exit 0, false otherwise. */
	runValidate: (cmd: string, timeoutMs: number) => Promise<boolean>;
	/** Remove a staged/temp artifact (best-effort). */
	removeArtifact: (path: string) => Promise<void>;
	/** Current persisted state for an add-on id (to preserve userConfig/version). */
	getState: (id: string) => AddonState | undefined;
	/** Persist add-on state to config.json (T23, atomic E3 write). */
	setState: (id: string, state: AddonState) => void;
	/** Drop an add-on's persisted state (T23). */
	removeState: (id: string) => void;
	/** Push the add-on's state to connected clients. */
	broadcast: (id: string, state: AddonState) => void;
};

/** Parse `NRestarts=<n>` out of `systemctl show <unit>`; 0 when unavailable. */
async function probeNRestarts(unit: string): Promise<number> {
	try {
		const { stdout } = await execFileP("systemctl", [
			"show",
			unit,
			"--property=NRestarts",
		]);
		const match = stdout.match(/NRestarts=(\d+)/);
		return match?.[1] ? Number.parseInt(match[1], 10) : 0;
	} catch {
		return 0;
	}
}

/** Read available bytes on /data via `df -B1 --output=avail`. */
async function probeDataFreeBytes(): Promise<number> {
	const { stdout } = await execFileP("df", [
		"-B1",
		"--output=avail",
		DATA_MOUNT,
	]);
	const avail = parseDfAvail(stdout);
	if (avail === null) throw new Error("failed to parse df avail for /data");
	return avail;
}

/** Read VERSION_ID from /etc/os-release for the artifact url substitution. */
async function probeOsVersion(): Promise<string> {
	const text = await Bun.file("/etc/os-release").text();
	const match = text.match(/^VERSION_ID="?([^"\n]+)"?/m);
	if (!match?.[1]) throw new Error("VERSION_ID not found in /etc/os-release");
	return match[1];
}

/** Fetch `url` to a temp path (parent created), rejecting on a non-2xx status. */
async function downloadArtifact(url: string, destTmp: string): Promise<void> {
	await mkdir(dirname(destTmp), { recursive: true });
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`download failed: HTTP ${res.status} for ${url}`);
	}
	await Bun.write(destTmp, res);
}

/**
 * Local sha256 fast-fail pre-check. The privileged helper (step 6) is the
 * AUTHORITATIVE GPG + sha256 trust anchor; this cheap unprivileged hash rejects
 * a corrupted download before a sudo round-trip and an atomic rename.
 */
async function verifyArtifact(
	descriptor: AddonDescriptor,
	tmpPath: string,
): Promise<void> {
	const bytes = await Bun.file(tmpPath).bytes();
	const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	if (digest !== descriptor.artifact.sha256) {
		throw new Error(
			`sha256 mismatch for ${descriptor.id}: expected ${descriptor.artifact.sha256}, got ${digest}`,
		);
	}
}

/** Atomic rename into the scan dir (parent created). */
async function stageArtifact(tmpPath: string, destPath: string): Promise<void> {
	await mkdir(dirname(destPath), { recursive: true });
	await rename(tmpPath, destPath);
}

/**
 * Run the descriptor's validation command with a hard timeout. The command
 * string comes from the GPG-signed descriptor (G-trust root), so running it via
 * the device shell is sound; a hung probe is killed on the timeout → false.
 */
async function runValidateCmd(
	cmd: string,
	timeoutMs: number,
): Promise<boolean> {
	try {
		const proc = Bun.spawn(["sh", "-c", cmd], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		const timer = setTimeout(() => {
			try {
				proc.kill();
			} catch {}
		}, timeoutMs);
		const code = await proc.exited;
		clearTimeout(timer);
		return code === 0;
	} catch {
		return false;
	}
}

const defaultAddonManagerDeps: AddonManagerDeps = {
	isRealDevice: () => isRealDevice(),
	getEffectiveHardware: () => getEffectiveHardwareImpl(),
	getDataFreeBytes: probeDataFreeBytes,
	getOsVersion: probeOsVersion,
	download: downloadArtifact,
	verify: verifyArtifact,
	stage: stageArtifact,
	helperEnable: async (id) => {
		await addonEnable(id);
	},
	helperDisable: async (id) => {
		await addonDisable(id);
	},
	systemctl: (args) => execFileP("systemctl", args),
	getNRestarts: probeNRestarts,
	runValidate: runValidateCmd,
	removeArtifact: async (path) => {
		await rm(path, { force: true });
	},
	getState: (id) => getAddons()[id],
	setState: (id, state) => setAddonState(id, state),
	removeState: (id) => removeAddonState(id),
	broadcast: (id, state) => broadcastMsg(ADDON_EVENT, { [id]: state }),
};

let activeDeps: AddonManagerDeps = defaultAddonManagerDeps;

/** Override the injectable surface (DI for tests + the crash-loop poller). */
export function setAddonManagerDeps(deps: Partial<AddonManagerDeps>): void {
	activeDeps = { ...defaultAddonManagerDeps, ...deps };
}

/** Restore the real-device primitives. */
export function resetAddonManagerDeps(): void {
	activeDeps = defaultAddonManagerDeps;
}

// ─── live state map ──────────────────────────────────────────────────────────

const livePhases = new Map<string, AddonManagerPhase>();

/** Current in-memory manager phase for an add-on (`disabled` when unknown). */
export function getAddonPhase(id: string): AddonManagerPhase {
	return livePhases.get(id) ?? "disabled";
}

/**
 * Commit a phase transition: persist a schema-valid AddonState (preserving the
 * add-on's userConfig + materialised version across transitions), update the
 * live map, and broadcast. `lastError` is set only when supplied — so it clears
 * on every successful transition.
 */
function transition(
	id: string,
	phase: AddonManagerPhase,
	deps: AddonManagerDeps,
	extra: { versionMaterialized?: string; lastError?: string } = {},
): AddonState {
	const prev = deps.getState(id);
	const meta: {
		versionMaterialized?: string;
		userConfig?: Record<string, unknown>;
		lastError?: string;
	} = {};
	const version = extra.versionMaterialized ?? prev?.versionMaterialized;
	if (version !== undefined) meta.versionMaterialized = version;
	if (prev?.userConfig !== undefined) meta.userConfig = prev.userConfig;
	if (extra.lastError !== undefined) meta.lastError = extra.lastError;

	const state = toAddonState(phase, meta);
	livePhases.set(id, phase);
	deps.setState(id, state);
	deps.broadcast(id, state);
	return state;
}

// ─── lifecycle ops ───────────────────────────────────────────────────────────

/** Unmask then start the descriptor's units (step 7 of the enable pipeline). */
async function startUnits(
	units: AddonUnits | undefined,
	deps: AddonManagerDeps,
): Promise<void> {
	for (const unit of units?.unmask ?? []) {
		await deps.systemctl(["unmask", unit]);
	}
	for (const unit of units?.start ?? []) {
		await deps.systemctl(["start", unit]);
	}
}

/**
 * Safety stop for a materialised-but-unhealthy add-on (crash-loop or a failed
 * validation probe). Mask every unit so it cannot restart, then park the add-on
 * in `auto_disabled` with the reason — mirrors the kiosk auto-disable rule.
 */
async function autoDisableAddon(
	descriptor: AddonDescriptor,
	deps: AddonManagerDeps,
	reason: string,
): Promise<void> {
	for (const unit of allUnits(descriptor.units)) {
		try {
			await deps.systemctl(["mask", unit]);
		} catch (err) {
			logger.error(
				`addon ${descriptor.id}: failed to mask ${unit} on auto-disable: ${err}`,
			);
		}
	}
	transition(descriptor.id, "auto_disabled", deps, { lastError: reason });
}

/**
 * Enable an add-on. Ordered pipeline, each step gated/atomic:
 *   1. isRealDevice() (G6)               5. atomic rename → scan dir
 *   2. free-space precheck (E1)          6. helper enable (privileged)
 *   3. download → /data/tmp temp         7. unmask + start descriptor units
 *   4. sha256 (+ helper GPG) verify      8. validation probe → auto-disable
 *
 * Any failure between steps 3–7 parks the add-on in `failed`; a failed
 * validation probe (step 8) auto-disables it. Both persist via setState.
 */
export async function enableAddon(
	descriptor: AddonDescriptor,
	deps: AddonManagerDeps = activeDeps,
): Promise<AddonOpResult> {
	const id = descriptor.id;

	// 1. G6 — never drive the host OS in dev/emulated mode.
	if (!(await deps.isRealDevice())) {
		return { success: false, error: ADDON_UNAVAILABLE_ERROR };
	}

	// 1b. T23 — hardware ∩ deps ∩ conflicts gate, before any state mutation.
	const compatError = addonCompatibilityError(
		descriptor,
		deps.getEffectiveHardware(),
		(id) => deps.getState(id),
	);
	if (compatError) {
		return { success: false, error: compatError };
	}

	// 2. E1 — free-space precheck BEFORE any download or state mutation.
	const freeBytes = await deps.getDataFreeBytes();
	if (!hasSufficientSpace(freeBytes, descriptor.artifact.sizeInstalled)) {
		return { success: false, error: ADDON_INSUFFICIENT_SPACE_ERROR };
	}

	transition(id, "enabling", deps);
	const tmpPath = tmpArtifactPath(id);
	try {
		// 3. download artifact → atomic temp under /data/tmp.
		const osVersion = await deps.getOsVersion();
		const url = resolveArtifactUrl(descriptor.artifact.urlTemplate, osVersion);
		await deps.download(url, tmpPath);

		// 4. verify (local sha256 fast-fail; helper is the authoritative gate).
		await deps.verify(descriptor, tmpPath);

		// 5. atomic rename into the sysext scan dir.
		await deps.stage(tmpPath, extArtifactPath(id));

		// 6. privileged activation — re-verifies sig + sha256, refreshes sysext.
		await deps.helperEnable(id);

		// 7. unmask + start the descriptor's units (idempotent).
		await startUnits(descriptor.units, deps);

		// 8. validation probe — auto-disable a materialised-but-unhealthy add-on.
		if (descriptor.validate) {
			const timeoutMs = descriptor.validate.timeout
				? descriptor.validate.timeout * 1000
				: DEFAULT_VALIDATE_TIMEOUT_MS;
			const healthy = await deps.runValidate(
				descriptor.validate.cmd,
				timeoutMs,
			);
			if (!healthy) {
				await autoDisableAddon(descriptor, deps, ADDON_VALIDATION_FAILED_ERROR);
				return { success: false, error: ADDON_VALIDATION_FAILED_ERROR };
			}
		}

		transition(id, "enabled", deps, {
			versionMaterialized: descriptor.version,
		});
		return { success: true, phase: "enabled" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.error(`addon ${id}: enable failed: ${message}`);
		transition(id, "failed", deps, { lastError: message });
		// Best-effort: drop the partial temp so a retry starts clean.
		await deps.removeArtifact(tmpPath).catch((cleanupErr) => {
			logger.debug(`addon ${id}: temp cleanup failed`, { err: cleanupErr });
		});
		return { success: false, error: ADDON_ENABLE_FAILED_ERROR };
	}
}

/**
 * Disable an add-on — the exact reverse of enable, idempotent: stop + mask the
 * descriptor units, privileged helper teardown, remove the staged artifact,
 * then drop the device-local state. Re-running on an already-disabled add-on is
 * a harmless no-op (every step is idempotent).
 */
export async function disableAddon(
	descriptor: AddonDescriptor,
	deps: AddonManagerDeps = activeDeps,
): Promise<AddonOpResult> {
	const id = descriptor.id;

	// G6 gate.
	if (!(await deps.isRealDevice())) {
		return { success: false, error: ADDON_UNAVAILABLE_ERROR };
	}

	transition(id, "disabling", deps);
	try {
		// stop + mask every descriptor unit (no-ops if already down).
		for (const unit of allUnits(descriptor.units)) {
			await deps.systemctl(["stop", unit]);
			await deps.systemctl(["mask", unit]);
		}
		// privileged teardown: helper stops/masks/disables, removes .raw, refresh.
		await deps.helperDisable(id);
		// remove the staged artifact (idempotent best-effort).
		await deps.removeArtifact(extArtifactPath(id));

		// drop device-local state and announce the disabled add-on.
		livePhases.set(id, "disabled");
		deps.broadcast(id, toAddonState("disabled"));
		deps.removeState(id);
		return { success: true, phase: "disabled" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.error(`addon ${id}: disable failed: ${message}`);
		transition(id, "failed", deps, { lastError: message });
		return { success: false, error: ADDON_DISABLE_FAILED_ERROR };
	}
}

/**
 * One crash-loop observation for an enabled add-on: read NRestarts across its
 * `start` units and, if any unit hit the threshold, mask + auto-disable. Gated
 * on isRealDevice() (G6) and a no-op unless the add-on is currently `enabled`.
 * Returns the resolved manager phase.
 */
export async function pollAddonCrashLoop(
	descriptor: AddonDescriptor,
	deps: AddonManagerDeps = activeDeps,
): Promise<AddonManagerPhase> {
	const id = descriptor.id;

	// G6 — never probe systemd off-device.
	if (!(await deps.isRealDevice())) return getAddonPhase(id);
	// Only a running add-on can crash-loop.
	if (getAddonPhase(id) !== "enabled") return getAddonPhase(id);

	let maxRestarts = 0;
	for (const unit of descriptor.units?.start ?? []) {
		maxRestarts = Math.max(maxRestarts, await deps.getNRestarts(unit));
	}

	if (isAddonCrashLoop(maxRestarts)) {
		await autoDisableAddon(descriptor, deps, ADDON_CRASH_LOOP_REASON);
		return "auto_disabled";
	}
	return getAddonPhase(id);
}

/**
 * Restore live phases from persisted config on backend startup — seeds the live
 * map so the UI renders instantly without re-probing every add-on. Never drives
 * the OS; an unhealthy add-on is reconciled lazily by {@link pollAddonCrashLoop}.
 */
export function initAddonManager(): void {
	livePhases.clear();
	for (const [id, state] of Object.entries(getAddons())) {
		livePhases.set(id, phaseFromState(state));
	}
}
