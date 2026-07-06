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
 * Remote Control Plane v2.0 — device-side active-profile reporter
 * (remote-relay-support spec §8, cloud Todo 15).
 *
 * The platform pushes a RESOLVED SRT-receive profile via `device.setProfile`
 * (`set-profile.ts`) and needs to know the EFFECTIVE profile the device actually
 * streams under so it can surface per-device DRIFT (`lib/profiles/reconcile.ts`).
 * This module is that report: it reads the ACTUALLY-applied StreamConfig — the
 * persisted `config.json` fields the device streams with, NOT the last pushed
 * command payload — and emits it up the control channel as a `device.activeProfile`
 * status frame through the standard `broadcastMsg` relay path.
 *
 * Wire shape (verified against ceralive-platform `StreamConfigSchema` /
 * `ActiveProfilePayloadSchema`): the payload NESTS the four StreamConfig fields
 * under a `config` key — `{ config: { presetId, latencyMs, fecEnabled,
 * recoveryMode } }`. A bare-config payload (no nesting) or `profileId` instead of
 * `presetId` is silently ignored platform-side (drift never fires), so the shape
 * is pinned by the emitter test.
 *
 * De-dup contract (spec §8, no spam): a report is emitted only when the config
 * DIFFERS from the last one emitted — a config-change or apply that leaves the
 * four fields unchanged emits nothing. A (re)connect forces a re-emit (the hub
 * loses the snapshot on disconnect) via `force`. Every effectful collaborator is
 * injected ({@link ActiveProfileReporterDeps}) so the report is unit-testable
 * without disk, config, or a live channel — mirroring `set-profile.ts`.
 */

import type { StreamRecoveryPreference } from "@ceraui/rpc/schemas";

import { ACTIVE_PROFILE_STATUS } from "./protocol.ts";

/**
 * The four StreamConfig fields the device reports as its EFFECTIVE active profile.
 * Field names + types mirror the platform's `StreamConfigSchema` exactly:
 * `presetId` (non-empty string, incl. `'custom'`), `latencyMs` (non-negative int),
 * `fecEnabled` (boolean), `recoveryMode` (`'standard' | 'bandwidth-saver'`).
 */
export interface ActiveProfileReport {
	presetId: string;
	latencyMs: number;
	fecEnabled: boolean;
	recoveryMode: StreamRecoveryPreference;
}

/** Injected collaborators so the report runs without config/channel in tests. */
export interface ActiveProfileReporterDeps {
	/**
	 * Read the StreamConfig the device is ACTUALLY streaming under — projected from
	 * the persisted runtime config (never the last pushed command payload).
	 */
	readActiveProfile: () => ActiveProfileReport;
	/**
	 * Emit a status broadcast (local clients + control-channel relay). Defaults to
	 * an inert no-op until {@link wireActiveProfileReporter} binds `broadcastMsg`.
	 */
	broadcast: (type: string, data: unknown) => void;
}

interface ReporterState {
	deps: ActiveProfileReporterDeps;
	/** The last config emitted, so an unchanged report is a no-op (no spam). */
	last: ActiveProfileReport | null;
}

function defaultDeps(): ActiveProfileReporterDeps {
	return {
		readActiveProfile: () => ({
			presetId: "custom",
			latencyMs: 0,
			fecEnabled: false,
			recoveryMode: "standard",
		}),
		broadcast: () => {
			/* no-op default; real deps injected by wireActiveProfileReporter() */
		},
	};
}

let state: ReporterState = { deps: defaultDeps(), last: null };

/** Whether two reports carry the same four StreamConfig fields (de-dup key). */
function sameProfile(a: ActiveProfileReport, b: ActiveProfileReport): boolean {
	return (
		a.presetId === b.presetId &&
		a.latencyMs === b.latencyMs &&
		a.fecEnabled === b.fecEnabled &&
		a.recoveryMode === b.recoveryMode
	);
}

/**
 * Read the device's EFFECTIVE active StreamConfig and emit a `device.activeProfile`
 * status frame (nested under `payload.config`) — but only when it DIFFERS from the
 * last report, so an unchanged config never spams the hub. `force` bypasses the
 * de-dup for a (re)connect, where the hub has lost the snapshot and MUST be
 * re-seeded even though the config did not change. Returns whether a frame was
 * emitted.
 */
export function reportActiveProfile(
	options: { force?: boolean } = {},
): boolean {
	const config = state.deps.readActiveProfile();
	if (
		options.force !== true &&
		state.last !== null &&
		sameProfile(state.last, config)
	) {
		return false;
	}
	state.last = config;
	state.deps.broadcast(ACTIVE_PROFILE_STATUS, { config });
	return true;
}

/** Bind (or override) the injected collaborators. */
export function configureActiveProfileReporter(
	overrides: Partial<ActiveProfileReporterDeps>,
): void {
	state.deps = { ...state.deps, ...overrides };
}

/** Test seam: reset deps + the de-dup cache to a clean floor. */
export function resetActiveProfileReporter(): void {
	state = { deps: defaultDeps(), last: null };
}
