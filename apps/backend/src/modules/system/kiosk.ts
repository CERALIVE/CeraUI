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
import { rm } from "node:fs/promises";

import {
	KIOSK_CRASH_LOOP_RESTART_THRESHOLD,
	KIOSK_POLL_INTERVAL_MS,
	type KioskConfigureInput,
	type KioskState,
	type KioskStatus,
} from "@ceraui/rpc/schemas";

import { type ExecResult, execFileP } from "../../helpers/exec.ts";
import { logger } from "../../helpers/logger.ts";
import { getConfig, saveConfig } from "../config.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";

// The systemd unit CeraUI drives. Cage is NEVER started by any other path — the
// backend only ever toggles this unit (DC-1: the image owns the chassis).
const KIOSK_SERVICE = "kiosk.service";

// tmpfs marker written by the unit's OnFailure handler when cage exits because
// no DRM output was found. Distinguishes display-unplug from a crash-loop.
const KIOSK_NO_DISPLAY_MARKER = "/run/kiosk-no-display";

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
	/** Emit the current kiosk status to all clients. */
	broadcast: (status: KioskStatus) => void;
};

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
	broadcast: (status) => broadcastMsg("kiosk", status),
};

let activeDeps: KioskDeps = defaultKioskDeps;

/** Override the systemd/marker probe surface (DI for the poll loop + RPC). */
export function setKioskDeps(deps: Partial<KioskDeps>): void {
	activeDeps = { ...defaultKioskDeps, ...deps };
}

/** Restore the real-OS probe surface. */
export function resetKioskDeps(): void {
	activeDeps = defaultKioskDeps;
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
 * `kiosk_enabled = true` and snap to `enabled-stopped`, then unmask + enable
 * --now the unit and begin polling. The synchronous prelude lets RPC handlers
 * read the committed state immediately without blocking on systemd.
 */
export async function kioskStart(
	deps: KioskDeps = activeDeps,
): Promise<KioskStatus> {
	getConfig().kiosk_enabled = true;
	applyState("enabled-stopped", deps);

	try {
		await deps.systemctl(["unmask", KIOSK_SERVICE]);
		await deps.systemctl(["enable", "--now", KIOSK_SERVICE]);
	} catch (err) {
		logger.error(`kiosk: failed to enable --now ${KIOSK_SERVICE}: ${err}`);
	}

	startKioskPolling(deps);
	return getKioskStatus();
}

/**
 * T3 — toggle-off. Synchronously persist the toggle off + `disabled`, then
 * stop + disable + mask the unit, delete the display-failure marker, and stop
 * polling. Valid from `enabled-running` and from `failed-no-display`.
 */
export async function kioskStop(
	deps: KioskDeps = activeDeps,
): Promise<KioskStatus> {
	getConfig().kiosk_enabled = false;
	applyState("disabled", deps);
	stopKioskPolling();

	try {
		await deps.systemctl(["stop", KIOSK_SERVICE]);
		await deps.systemctl(["disable", KIOSK_SERVICE]);
		await deps.systemctl(["mask", KIOSK_SERVICE]);
	} catch (err) {
		logger.error(`kiosk: failed to stop ${KIOSK_SERVICE}: ${err}`);
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
