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

/* Kiosk toggle state machine (DC-2 — docs/KIOSK_STATE_MACHINE.md) */
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";

import {
	type AddonDescriptor,
	AddonDescriptorSchema,
	KIOSK_CRASH_LOOP_RESTART_THRESHOLD,
	KIOSK_POLL_INTERVAL_MS,
	type KioskConfigureInput,
	type KioskState,
	type KioskStatus,
} from "@ceraui/rpc/schemas";

import { type ExecResult, execFileP } from "../../helpers/exec.ts";
import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import {
	createMockKioskDeps,
	type MockKioskHarness,
} from "../../mocks/providers/kiosk.ts";
import {
	type AddonOpResult,
	disableAddon as managerDisableAddon,
	enableAddon as managerEnableAddon,
} from "../addons/manager.ts";
import { getConfig, saveConfig } from "../config.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";

// Real-device detection (T4). Re-exported here so kiosk callers (and T13's RPC
// gate) get the detector from the kiosk module surface. Detection only — the
// handlers are NOT gated on it yet.
export {
	type DeviceDetectionDeps,
	defaultDeviceDetectionDeps,
	isRealDevice,
} from "./device-detection.ts";

// The systemd unit the DC-2 failure-observation poll loop watches for live
// state. Its lifecycle is driven by the cog-display add-on (DC-1: the image owns
// the chassis); the backend never starts cage by any other path.
const KIOSK_SERVICE = "kiosk.service";

// The on-device display engine ships as the managed `cog-display` add-on; the
// add-on manager owns its sysext lifecycle. The DC-2 state machine wraps that
// with the 5-state poll loop, crash-loop auto-disable, display/touch/motion/
// performance profiles, and OSK.
const COG_DISPLAY_ADDON_ID = "cog-display";

// Image-baked descriptor (T37) defining the display engine's units + signed
// sysext artifact. Read + schema-validated at toggle time; only reached on a
// real device, since the kiosk RPC handlers gate on isRealDevice() first (G6).
const COG_DISPLAY_DESCRIPTOR_PATH =
	"/usr/share/ceralive/addons/cog-display.json";

// tmpfs marker written by the unit's OnFailure handler when cage exits because
// no DRM output was found. Distinguishes display-unplug from a crash-loop.
const KIOSK_NO_DISPLAY_MARKER = "/run/kiosk-no-display";

// The on-screen keyboard process CeraUI signals. wvkbd shows on SIGUSR2 and
// hides on SIGUSR1 (its documented signal convention); the mapping lives here
// so the convention is never inlined in the RPC layer or the UI.
const KIOSK_OSK_PROCESS = "wvkbd-mobintl";

export type OskSignal = "SIGUSR1" | "SIGUSR2";

/**
 * Injectable systemd/marker probe surface. Defaults talk to the real OS
 * (argv-only systemctl, tmpfs marker, real broadcast). Tests inject
 * deterministic stand-ins and spies. Mirrors `SshStatusDeps` in ssh.ts.
 */
export type KioskDeps = {
	/** Run `systemctl <args>` argv-only; rejects on non-zero exit. */
	systemctl: (args: string[]) => Promise<ExecResult>;
	/** `systemctl is-failed kiosk.service` — true when the unit is failed. */
	isFailed: () => Promise<boolean>;
	/** `systemctl is-active kiosk.service` — true when active (running). */
	isActive: () => Promise<boolean>;
	/** `NRestarts` from `systemctl show` — crash-loop discriminator. */
	getNRestarts: () => Promise<number>;
	/** Whether the `/run/kiosk-no-display` marker exists. */
	noDisplayMarkerExists: () => Promise<boolean>;
	/** Delete the display-failure marker (best-effort). */
	removeNoDisplayMarker: () => Promise<void>;
	/** Signal the on-screen keyboard process (wvkbd) to show/hide. */
	oskSignal: (signal: OskSignal) => Promise<void>;
	/** Emit the current kiosk status to all clients. */
	broadcast: (status: KioskStatus) => void;
	/** Read + schema-validate the baked cog-display descriptor; null if absent. */
	loadCogDescriptor: () => AddonDescriptor | null;
	/** Enable the cog-display add-on via the add-on manager (T28). */
	enableAddon: (descriptor: AddonDescriptor) => Promise<AddonOpResult>;
	/** Disable the cog-display add-on via the add-on manager (T28). */
	disableAddon: (descriptor: AddonDescriptor) => Promise<AddonOpResult>;
};

// Synchronous (not Bun.file().text()) so the manager enable/disable call is
// issued in the same tick as the persisted-state commit — the RPC handler fires
// kioskStart/kioskStop fire-and-forget. Returns null instead of throwing so a
// missing/malformed descriptor degrades the toggle rather than crashing it.
function loadCogDescriptorFromDisk(): AddonDescriptor | null {
	try {
		const raw = JSON.parse(readFileSync(COG_DISPLAY_DESCRIPTOR_PATH, "utf8"));
		const descriptor = AddonDescriptorSchema.parse(raw);
		if (descriptor.id !== COG_DISPLAY_ADDON_ID) {
			logger.error(
				`kiosk: descriptor id mismatch: expected ${COG_DISPLAY_ADDON_ID}, got ${descriptor.id}`,
			);
			return null;
		}
		return descriptor;
	} catch (err) {
		logger.error(
			`kiosk: failed to load ${COG_DISPLAY_DESCRIPTOR_PATH}: ${err}`,
		);
		return null;
	}
}

/** Resolve whether the kiosk unit is active, swallowing the non-zero exit. */
async function probeIsActive(): Promise<boolean> {
	try {
		const { stdout } = await execFileP("systemctl", [
			"is-active",
			KIOSK_SERVICE,
		]);
		return stdout.trim() === "active";
	} catch (err) {
		// `is-active` exits non-zero for inactive/failed/unknown; read the stdout
		// off the rejection (mirrors ssh.ts probeSshActive).
		const stdout = (err as { stdout?: string } | null)?.stdout ?? "";
		return stdout.trim() === "active";
	}
}

/** `systemctl is-failed` exits 0 when the unit is in the failed state. */
async function probeIsFailed(): Promise<boolean> {
	try {
		await execFileP("systemctl", ["is-failed", KIOSK_SERVICE]);
		return true;
	} catch {
		return false;
	}
}

/** Parse `NRestarts=<n>` out of `systemctl show`; 0 when unavailable. */
async function probeNRestarts(): Promise<number> {
	try {
		const { stdout } = await execFileP("systemctl", [
			"show",
			KIOSK_SERVICE,
			"--property=NRestarts",
		]);
		const match = stdout.match(/NRestarts=(\d+)/);
		return match?.[1] ? Number.parseInt(match[1], 10) : 0;
	} catch {
		return 0;
	}
}

const defaultKioskDeps: KioskDeps = {
	systemctl: (args) => execFileP("systemctl", args),
	isFailed: probeIsFailed,
	isActive: probeIsActive,
	getNRestarts: probeNRestarts,
	noDisplayMarkerExists: () => Bun.file(KIOSK_NO_DISPLAY_MARKER).exists(),
	removeNoDisplayMarker: async () => {
		await rm(KIOSK_NO_DISPLAY_MARKER, { force: true });
	},
	oskSignal: async (signal) => {
		await execFileP("pkill", ["--signal", signal, "-x", KIOSK_OSK_PROCESS]);
	},
	broadcast: (status) => broadcastMsg("kiosk", status),
	loadCogDescriptor: loadCogDescriptorFromDisk,
	enableAddon: (descriptor) => managerEnableAddon(descriptor),
	disableAddon: (descriptor) => managerDisableAddon(descriptor),
};

let activeDeps: KioskDeps = defaultKioskDeps;

/** Override the systemd/marker probe surface (DI for the poll loop + RPC). */
export function setKioskDeps(deps: Partial<KioskDeps>): void {
	activeDeps = { ...defaultKioskDeps, ...deps };
}

/** Restore the real-OS probe surface and drop any dev mock harness. */
export function resetKioskDeps(): void {
	activeDeps = defaultKioskDeps;
	mockKioskHarness = null;
}

// ─── dev mock harness (shouldUseMocks) — T6 ──────────────────────────────────

/**
 * The dev in-memory kiosk harness, lazily built on the first dev-mode toggle and
 * reused so the faked unit state + recorded broadcasts persist across a
 * start→stop pair within a session. NEVER constructed on a production path —
 * {@link resolveActiveKioskDeps} only builds it under {@link shouldUseMocks}.
 * Mirrors the add-on manager's mock seam (modules/addons/manager.ts).
 */
let mockKioskHarness: MockKioskHarness | null = null;

/** The current dev kiosk harness WITHOUT building one (null until the first dev op). */
export function peekMockKioskHarness(): MockKioskHarness | null {
	return mockKioskHarness;
}

/**
 * Resolve the deps a kiosk toggle handler runs against when invoked from the RPC
 * layer: the dev in-memory harness under {@link shouldUseMocks} (so the kiosk
 * flows are exercisable on a dev box with no board / systemctl / systemd-sysext),
 * else the real systemd/marker probe surface. The real-path branch NEVER
 * constructs a mock double.
 */
export function resolveActiveKioskDeps(): KioskDeps {
	if (shouldUseMocks()) {
		mockKioskHarness ??= createMockKioskDeps();
		return mockKioskHarness.deps;
	}
	return activeDeps;
}

let kioskLiveState: KioskState = "disabled";
let pollTimer: ReturnType<typeof setInterval> | undefined;
let pollInFlight = false;

export function getKioskLiveState(): KioskState {
	return kioskLiveState;
}

/** Compose the wire status from the persisted config + live polled state. */
export function getKioskStatus(): KioskStatus {
	const config = getConfig();
	return {
		enabled: config.kiosk_enabled ?? false,
		state: kioskLiveState,
		display: config.kiosk_display ?? "lcd",
		touch: config.kiosk_touch ?? true,
		motion: config.kiosk_motion ?? true,
		performance: config.kiosk_performance ?? "balanced",
	};
}

/**
 * Pure classifier: map the three failure-observation signals onto a state.
 * Both crash-loop and single-shot failures surface as `enabled-failed`; the
 * auto-disable decision (T5) is made separately via {@link isCrashLoop}.
 */
export function classifyKioskState(signals: {
	enabled: boolean;
	isFailed: boolean;
	isActive: boolean;
	nRestarts: number;
	noDisplayMarker: boolean;
}): KioskState {
	if (!signals.enabled) return "disabled";
	if (signals.isFailed) {
		return signals.noDisplayMarker ? "failed-no-display" : "enabled-failed";
	}
	if (signals.isActive) return "enabled-running";
	return "enabled-stopped";
}

/**
 * A failed unit is a crash-loop (→ auto-disable T5) only when it is NOT a
 * display-unplug and the restart count reached the StartLimitBurst threshold.
 */
export function isCrashLoop(signals: {
	isFailed: boolean;
	noDisplayMarker: boolean;
	nRestarts: number;
}): boolean {
	return (
		signals.isFailed &&
		!signals.noDisplayMarker &&
		signals.nRestarts >= KIOSK_CRASH_LOOP_RESTART_THRESHOLD
	);
}

/** Commit a new live state: persist `kiosk_last_state` + broadcast on change. */
function applyState(state: KioskState, deps: KioskDeps): KioskState {
	if (state !== kioskLiveState) {
		kioskLiveState = state;
		getConfig().kiosk_last_state = state;
		saveConfig();
		deps.broadcast(getKioskStatus());
	}
	return state;
}

/**
 * T5 — auto-disable after a crash-loop. Persist the toggle off, mask the unit
 * so it cannot restart by accident, broadcast `disabled`, and stop polling.
 * Keeps the LAN browser UI reachable even if cage/Chromium is crash-looping.
 */
async function autoDisableKiosk(deps: KioskDeps): Promise<void> {
	const config = getConfig();
	config.kiosk_enabled = false;
	kioskLiveState = "disabled";
	config.kiosk_last_state = "disabled";
	saveConfig();
	try {
		await deps.systemctl(["mask", KIOSK_SERVICE]);
	} catch (err) {
		logger.error(
			`kiosk: failed to mask ${KIOSK_SERVICE} on auto-disable: ${err}`,
		);
	}
	deps.broadcast(getKioskStatus());
	stopKioskPolling();
}

/**
 * One failure-observation iteration. Gathers the three signals, classifies the
 * state, and — when the failure is a crash-loop — applies the auto-disable rule
 * before returning. Returns the resolved live state.
 */
export async function pollKioskOnce(
	deps: KioskDeps = activeDeps,
): Promise<KioskState> {
	if (!getConfig().kiosk_enabled) {
		return applyState("disabled", deps);
	}

	const [isFailed, isActive, noDisplayMarker] = await Promise.all([
		deps.isFailed(),
		deps.isActive(),
		deps.noDisplayMarkerExists(),
	]);
	const nRestarts = isFailed ? await deps.getNRestarts() : 0;

	const signals = {
		enabled: true,
		isFailed,
		isActive,
		nRestarts,
		noDisplayMarker,
	};
	const state = classifyKioskState(signals);

	if (state === "enabled-failed" && isCrashLoop(signals)) {
		await autoDisableKiosk(deps);
		return kioskLiveState;
	}

	return applyState(state, deps);
}

/** Start the 2 s failure-observation poll loop (no-op if already running). */
export function startKioskPolling(deps: KioskDeps = activeDeps): void {
	stopKioskPolling();
	pollTimer = setInterval(() => {
		if (pollInFlight) return;
		pollInFlight = true;
		pollKioskOnce(deps)
			.catch((err) => logger.error(`kiosk: poll iteration failed: ${err}`))
			.finally(() => {
				pollInFlight = false;
			});
	}, KIOSK_POLL_INTERVAL_MS);
	pollTimer.unref?.();
}

export function stopKioskPolling(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = undefined;
	}
}

/**
 * T1 — toggle-on. Synchronously (before the first await) persist
 * `kiosk_enabled = true` and snap to `enabled-stopped`, then enable the
 * cog-display add-on (manager owns the sysext + unit lifecycle) and begin
 * polling. The synchronous prelude lets RPC handlers read the committed state
 * immediately without blocking on the add-on materialisation.
 */
export async function kioskStart(
	deps: KioskDeps = activeDeps,
): Promise<KioskStatus> {
	getConfig().kiosk_enabled = true;
	applyState("enabled-stopped", deps);

	const descriptor = deps.loadCogDescriptor();
	if (descriptor) {
		const result = await deps.enableAddon(descriptor);
		if (!result.success) {
			logger.error(`kiosk: cog-display enable failed: ${result.error}`);
		}
	} else {
		logger.error("kiosk: cog-display descriptor unavailable; cannot enable");
	}

	startKioskPolling(deps);
	return getKioskStatus();
}

/**
 * T3 — toggle-off. Synchronously persist the toggle off + `disabled` and stop
 * polling, then disable the cog-display add-on (manager stops + masks the units
 * and tears down the sysext) and delete the display-failure marker. Valid from
 * `enabled-running` and from `failed-no-display`.
 */
export async function kioskStop(
	deps: KioskDeps = activeDeps,
): Promise<KioskStatus> {
	getConfig().kiosk_enabled = false;
	applyState("disabled", deps);
	stopKioskPolling();

	const descriptor = deps.loadCogDescriptor();
	if (descriptor) {
		const result = await deps.disableAddon(descriptor);
		if (!result.success) {
			logger.error(`kiosk: cog-display disable failed: ${result.error}`);
		}
	} else {
		logger.error("kiosk: cog-display descriptor unavailable; cannot disable");
	}
	try {
		await deps.removeNoDisplayMarker();
	} catch (err) {
		logger.error(`kiosk: failed to remove ${KIOSK_NO_DISPLAY_MARKER}: ${err}`);
	}

	return getKioskStatus();
}

/** Persist the kiosk display profile (display + touch + motion + performance). */
export function kioskConfigure(
	input: KioskConfigureInput,
	deps: KioskDeps = activeDeps,
): KioskConfigureInput {
	const config = getConfig();
	config.kiosk_display = input.display;
	config.kiosk_touch = input.touch;
	config.kiosk_motion = input.motion;
	config.kiosk_performance = input.performance;
	saveConfig();
	deps.broadcast(getKioskStatus());

	return {
		display: config.kiosk_display,
		touch: config.kiosk_touch,
		motion: config.kiosk_motion,
		performance: config.kiosk_performance,
	};
}

/**
 * Show or hide the on-device on-screen keyboard. `visible = true` signals
 * SIGUSR2 (show), `false` signals SIGUSR1 (hide) — the wvkbd convention. A
 * failure (e.g. wvkbd not running) is logged, never thrown, so toggling the
 * keyboard from the LAN browser can never crash the RPC.
 */
export async function kioskOsk(
	visible: boolean,
	deps: KioskDeps = activeDeps,
): Promise<void> {
	try {
		await deps.oskSignal(visible ? "SIGUSR2" : "SIGUSR1");
	} catch (err) {
		logger.error(`kiosk: failed to signal ${KIOSK_OSK_PROCESS}: ${err}`);
	}
}

/**
 * Restore live state on backend startup. Seeds from `kiosk_last_state` for an
 * instant UI render, but never trusts it: when the toggle is on it kicks an
 * immediate confirmation poll and starts the 2 s loop.
 */
export function initKiosk(deps: KioskDeps = activeDeps): void {
	const config = getConfig();
	if (config.kiosk_enabled) {
		kioskLiveState = config.kiosk_last_state ?? "enabled-stopped";
		startKioskPolling(deps);
		void pollKioskOnce(deps);
	} else {
		kioskLiveState = "disabled";
	}
}
