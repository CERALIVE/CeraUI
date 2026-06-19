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
  Modem update loop — event-driven presence + retained status poll (T17).

  HARD CUTOVER from the old always-on 10s self-recursive `setTimeout` loop:

  - Modem ADD / REMOVE + registration changes are driven by monitor events
    (`modem-added` / `modem-removed` / `device-state`) from the shared
    `IMonitorEmitter` (T12). The monitor has no historical replay, so the
    initial state (and every monitor restart via `onResync`) is reconciled by a
    one-shot `discoverModems()` poll.
  - A RETAINED poll runs ONLY for signal-strength / status refresh, at a reduced
    cadence (30s instead of the old 10s). It never re-lists / re-registers and
    never resets gsm connections.
  - `resetGsmConnections()` is wired exclusively through the T11
    `onGsmConnectionsReset` hook and fires ONLY on modem add/remove (and on
    config change, handled in modems.ts) — never on a status poll.
  - Re-entrancy is serialized via `withModemUpdateLock` (T13); transient `mmcli`
    failures are retried via `retryWithBackoff` (T7).
  - On removal we simply broadcast the cleaned-up state — no hot-plug recovery.

  The `modems` broadcast shape is unchanged: it is still produced by
  `broadcastModems` (modem-status.ts), keyed off the legacy `modemsState`
  record (modems-state.ts). The T11 cache (`modems-state-cache.ts`) sits on top
  as the diff engine that decides WHEN to broadcast and WHEN to reset gsm.

  The "describe a single modem" concern — registration, status building, NM
  connection profile resolution and the bounded `mmcli` retry wrappers — lives
  in the sibling `modem-registration.ts`. This file owns only the presence loop:
  the monitor wiring, the reconcile/snapshot/broadcast glue and the lifecycle.
*/

import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { createMonitorManager } from "../network/monitor/monitor-manager.ts";
import { withModemUpdateLock } from "../network/state/device-lock.ts";
import type {
	IMonitorEmitter,
	ModemsState,
	MonitorEvent,
	StateDiff,
} from "../network/state-types.ts";
import { applyJitter } from "../streaming/constants.ts";

import { resetGsmConnections } from "./gsm-connections.ts";
import type { ModemId } from "./mmcli.ts";
import {
	mmListWithRetry,
	refreshModemStatus,
	registerModemSafe,
} from "./modem-registration.ts";
import { broadcastModems } from "./modem-status.ts";
import { getModem, getModemIds, removeModem } from "./modems-state.ts";
import { maybeAutoUnlockSimPins } from "./sim-autounlock.ts";
import {
	type ModemDiffEntry,
	onGsmConnectionsReset,
	onModemsChange,
	setModemsState,
	triggerGsmConnectionsReset,
} from "./state/modems-state-cache.ts";

// Retained status poll cadence. Reduced from the old 10s self-recursive loop:
// signal/status only, no presence detection, no gsm reset.
/** Interval (ms) for retained modem status poll (signal/status refresh only). */
const STATUS_POLL_INTERVAL_MS = 30_000;

/**
 * Build a value-distinct snapshot of the legacy `modemsState` record, keyed by
 * numeric id, and publish it into the T11 cache. The cache reconciles it
 * against the previous snapshot and fires `onModemsChange` only on a non-empty
 * diff — which drives both the broadcast and (for add/remove) the gsm reset.
 */
function publishModemsSnapshot(): void {
	const snapshot: ModemsState = {};
	for (const id of getModemIds()) {
		const modem = getModem(id);
		if (modem) {
			snapshot[id] = modem;
		}
	}
	setModemsState(snapshot);
}

/**
 * Broadcast the `modems` message in response to a reconcile diff.
 *
 * Shape is preserved exactly from the legacy loop: in mock mode the FULL state
 * is sent (the mock frontend wholesale-replaces modemsState per `status`
 * message), otherwise only newly-added modems carry their full descriptor and
 * everything else is a status-only partial.
 */
function broadcastFromDiff(diff: StateDiff<ModemDiffEntry>): void {
	if (shouldUseMocks()) {
		broadcastModems(undefined);
		return;
	}
	const fullState: Record<number, true> = {};
	for (const entry of diff.added) {
		fullState[entry.id] = true;
	}
	broadcastModems(fullState);
}

function findModemIdByIfname(ifname: string): ModemId | undefined {
	for (const id of getModemIds()) {
		if (getModem(id)?.ifname === ifname) {
			return id;
		}
	}
	return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event-driven drivers
// ─────────────────────────────────────────────────────────────────────────────

/** A `modem-added` event: register (or refresh if already known) then publish. */
async function handleModemAdded(id: ModemId): Promise<void> {
	await withModemUpdateLock(async () => {
		if (getModem(id)) {
			// Already present (e.g. discovered at startup) — refresh, don't re-register.
			await refreshModemStatus(id);
		} else {
			await registerModemSafe(id);
		}
		// Publish: a freshly registered modem reconciles as `added`, which the
		// onModemsChange handler turns into a gsm reset + full broadcast.
		publishModemsSnapshot();
	});
}

/** A `modem-removed` event: drop the modem and publish the cleaned-up state. */
async function handleModemRemoved(id: ModemId): Promise<void> {
	await withModemUpdateLock(async () => {
		if (!getModem(id)) {
			return;
		}
		logger.warn(`Modem ${id} removed`);
		removeModem(id);
		// Publish: reconciles as `removed` → gsm reset + broadcast (no hot-plug recovery).
		publishModemsSnapshot();
	});
}

/** A `device-state` event for a modem's net interface: refresh that modem only. */
async function handleDeviceState(device: string): Promise<void> {
	await withModemUpdateLock(async () => {
		const id = findModemIdByIfname(device);
		if (id === undefined) {
			return;
		}
		await refreshModemStatus(id);
		publishModemsSnapshot();
	});
}

async function handleMonitorEvent(event: MonitorEvent): Promise<void> {
	switch (event.type) {
		case "modem-added":
			await handleModemAdded(Number.parseInt(event.id, 10));
			break;
		case "modem-removed":
			await handleModemRemoved(Number.parseInt(event.id, 10));
			break;
		case "device-state":
			await handleDeviceState(event.device);
			break;
		default:
			// connection-state and any other events are handled by other layers.
			break;
	}
}

/**
 * Full reconcile: list the modems currently present, register the new ones,
 * drop the gone ones, refresh the survivors, then publish. Used for the initial
 * startup state and on every monitor restart (`onResync`) — the monitor has no
 * historical replay, so a full poll is the only way to close the gap.
 *
 * This is NOT the retained status poll: it detects presence changes and so its
 * diff may carry add/remove entries (which reset gsm connections).
 */
export async function discoverModems(): Promise<void> {
	await withModemUpdateLock(async () => {
		const modemList = (await mmListWithRetry()) ?? [];
		const present = new Set<ModemId>(modemList);

		for (const id of getModemIds()) {
			if (!present.has(id)) {
				logger.warn(`Modem ${id} removed`);
				removeModem(id);
			}
		}

		for (const id of modemList) {
			if (getModem(id)) {
				await refreshModemStatus(id);
			} else {
				await registerModemSafe(id);
			}
		}

		publishModemsSnapshot();
	});
}

/**
 * Retained status poll: refresh signal/status of EVERY known modem at the
 * reduced cadence. Never lists/registers (presence is event-driven) and never
 * resets gsm connections — its diff only ever contains `changed` entries.
 */
export async function runModemStatusPoll(): Promise<void> {
	await withModemUpdateLock(async () => {
		for (const id of getModemIds()) {
			await refreshModemStatus(id);
		}
		publishModemsSnapshot();
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let initialized = false;
let monitorRef: IMonitorEmitter | null = null;
let monitorListener: ((event: MonitorEvent) => void) | null = null;
let statusPollTimer: ReturnType<typeof setTimeout> | null = null;
let unsubModemsChange: (() => void) | null = null;
let unsubGsmReset: (() => void) | null = null;

// Serializes async work kicked off by sync monitor callbacks so callers (and
// tests) can await the loop reaching a quiescent state.
let pendingWork: Promise<unknown> = Promise.resolve();

function trackWork(work: Promise<unknown>): void {
	pendingWork = pendingWork.then(
		() => work,
		() => work,
	);
}

/** Resolves once all in-flight monitor-driven modem updates have settled. */
export function whenModemUpdatesSettled(): Promise<unknown> {
	return pendingWork;
}

export interface InitModemUpdateLoopOptions {
	/** Inject an emitter (tests). Defaults to the env-selected monitor manager. */
	monitor?: IMonitorEmitter;
	/** Run the initial full discovery poll. Default true. */
	autoDiscover?: boolean;
	/** Boot SIM PIN auto-unlock after the initial discovery. Default true. */
	autoUnlock?: boolean;
	/** Start the retained 30s status poll. Default true. */
	startPoll?: boolean;
}

/**
 * Wire the event-driven modem presence + retained status poll. Replaces the old
 * always-on 10s self-recursive `updateModems()` loop.
 */
export async function initModemUpdateLoop(
	options: InitModemUpdateLoopOptions = {},
): Promise<void> {
	if (initialized) {
		return;
	}
	initialized = true;

	const { autoDiscover = true, autoUnlock = true, startPoll = true } = options;

	// `resetGsmConnections()` is wired EXCLUSIVELY through the T11 hook. It fires
	// on modem add/remove (triggered from the diff below) and on config change
	// (modems.ts) — never on a status poll.
	unsubGsmReset = onGsmConnectionsReset(() => {
		resetGsmConnections();
	});

	// Reconcile diffs drive everything observable: presence changes invalidate
	// the cached NM gsm connections, and every non-empty diff broadcasts.
	unsubModemsChange = onModemsChange((diff) => {
		for (const entry of [...diff.added, ...diff.removed]) {
			triggerGsmConnectionsReset(entry.id);
		}
		broadcastFromDiff(diff);
	});

	const monitor =
		options.monitor ??
		createMonitorManager(() => {
			// Monitor restarted — re-poll to close the no-replay gap.
			trackWork(discoverModems());
		});
	monitorRef = monitor;

	monitorListener = (event: MonitorEvent) => {
		trackWork(handleMonitorEvent(event));
	};
	monitor.on("monitor-event", monitorListener);
	monitor.start();

	if (autoDiscover) {
		await discoverModems();
	}

	if (autoUnlock) {
		await maybeAutoUnlockSimPins();
	}

	if (startPoll) {
		// Self-rescheduling jittered timeout (not setInterval) so a fleet of
		// devices de-correlates its 30s polls instead of all hitting mmcli — and,
		// downstream, the modems broadcast — on the same wall-clock boundary.
		const scheduleStatusPoll = (): void => {
			statusPollTimer = setTimeout(() => {
				trackWork(runModemStatusPoll());
				scheduleStatusPoll();
			}, applyJitter(STATUS_POLL_INTERVAL_MS));
		};
		scheduleStatusPoll();
	}
}

/** Tear down the loop: clear the poll timer, unsubscribe, and stop the monitor. */
export function stopModemUpdateLoop(): void {
	if (statusPollTimer !== null) {
		clearInterval(statusPollTimer);
		statusPollTimer = null;
	}
	if (monitorRef && monitorListener) {
		monitorRef.off("monitor-event", monitorListener);
		monitorRef.stop();
	}
	monitorRef = null;
	monitorListener = null;
	unsubModemsChange?.();
	unsubGsmReset?.();
	unsubModemsChange = null;
	unsubGsmReset = null;
	initialized = false;
}
