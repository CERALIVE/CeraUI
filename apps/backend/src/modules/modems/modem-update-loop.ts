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

import { resetGsmConnections } from "./gsm-connections.ts";
import { type ModemId } from "./mmcli.ts";
import {
	mmListWithRetry,
	refreshModemStatus,
	registerModemSafe,
} from "./modem-registration.ts";
import { broadcastModems } from "./modem-status.ts";
import { getModem, getModemIds, removeModem } from "./modems-state.ts";
import {
	type ModemDiffEntry,
	onGsmConnectionsReset,
	onModemsChange,
	setModemsState,
	triggerGsmConnectionsReset,
} from "./state/modems-state-cache.ts";

// Retained status poll cadence. Reduced from the old 10s self-recursive loop:
// signal/status only, no presence detection, no gsm reset.
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

	// If any modems were removed, delete them
	for (const m in modems) {
		if (modems[m]?.removed) {
			logger.warn(`Modem ${m} removed`);
			removeModem(Number(m));
		}
	}

	broadcastModems(newModems);

	setTimeout(updateModems, modemUpdateInterval);
}
