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
 * Network-ingest desired-state + service control (Task 6).
 *
 * The operator can enable/disable the baked-in LAN RTMP/SRT ingest gateways from
 * Settings. The desired state persists to config.json's `network_ingest` key
 * through the LIVE config singleton (getConfig/saveConfig) — NEVER a parallel
 * atomic-file-writer path, which would diverge from the in-memory singleton and
 * be silently overwritten by the next saveConfig() from any other module.
 *
 * Two topologies must be honored (B2 fleet transition):
 *   - NEW: ONE shared MediaMTX unit (`ceralive-rtmp-gateway.service`) serves BOTH
 *     protocols, so it stops only when BOTH are disabled and runs when ANY is
 *     enabled. Keyed off the `mediamtxSrt` config marker (file truth, valid even
 *     when the units are STOPPED — which is exactly why resolveSrtTopology, an
 *     ACTIVE-unit availability merge, cannot be reused here).
 *   - OLD: the rtmp unit ↔ rtmp and the standalone `ceralive-srt-gateway.service`
 *     ↔ srt, independently. Keyed off the `srtUnitPresent` unit-file marker.
 *
 * All privileged effects (systemctl, file/marker reads, config persistence,
 * broadcasts) are injected via {@link NetworkIngestControlDeps} so the resolver
 * and pipelines are unit-tested without hardware. Units are only ever
 * started/stopped — NEVER masked (masking is the crash-loop discriminator's
 * exclusive tool).
 */

import type { RequiresGateway } from "@ceraui/rpc/schemas";

import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import { type ExecResult, execFileP } from "../../helpers/exec.ts";
import { logger } from "../../helpers/logger.ts";
import { getConfig, saveConfig } from "../config.ts";
import { broadcastSources } from "../streaming/sources.ts";
import { isRealDevice as defaultIsRealDevice } from "../system/device-detection.ts";
import {
	RTMP_GATEWAY_UNIT,
	readMediamtxSrtEnabled,
	refreshAndBroadcastNetworkIngest,
	SRT_GATEWAY_UNIT,
} from "./network-ingest.ts";

/** Operator desired state: which ingest gateways should be running. */
export type IngestDesiredState = { rtmp: boolean; srt: boolean };

/** Topology discriminators the pure resolver keys its plan off (unit-independent). */
export type IngestTopologyMarkers = {
	/** NEW topology: MediaMTX binds SRT — file truth, valid when units are stopped. */
	mediamtxSrt: boolean;
	/** OLD topology: the standalone srt-live-transmit unit-file exists on disk. */
	srtUnitPresent: boolean;
};

/** The units to `systemctl start` / `stop` to reach the desired state. */
export interface IngestUnitActions {
	start: string[];
	stop: string[];
}

/** Read desired state from config, defaulting a missing key to both-enabled. */
export function readIngestDesired(config: RuntimeConfig): IngestDesiredState {
	const ni = config.network_ingest;
	return {
		rtmp: ni?.rtmp_enabled ?? true,
		srt: ni?.srt_enabled ?? true,
	};
}

/**
 * PURE topology-aware resolver: the target unit state for `desired`, given the
 * topology markers. NOT reusing resolveSrtTopology — that merges ACTIVE-unit
 * signals and cannot tell NEW from OLD once the shared unit is stopped.
 *
 * NEW topology (mediamtxSrt): the shared rtmp unit runs when ANY protocol is
 * enabled, stops only when BOTH are disabled; the srt unit is never touched.
 * OLD topology: rtmp unit ↔ rtmp; the standalone srt unit ↔ srt, independently.
 */
export function planIngestUnitActions(
	desired: IngestDesiredState,
	markers: IngestTopologyMarkers,
): IngestUnitActions {
	const start: string[] = [];
	const stop: string[] = [];

	if (markers.mediamtxSrt) {
		if (desired.rtmp || desired.srt) start.push(RTMP_GATEWAY_UNIT);
		else stop.push(RTMP_GATEWAY_UNIT);
		return { start, stop };
	}

	if (desired.rtmp) start.push(RTMP_GATEWAY_UNIT);
	else stop.push(RTMP_GATEWAY_UNIT);

	if (markers.srtUnitPresent) {
		if (desired.srt) start.push(SRT_GATEWAY_UNIT);
		else stop.push(SRT_GATEWAY_UNIT);
	}

	return { start, stop };
}

/**
 * Effectful collaborators, injected so the gate + pipelines are testable without
 * hardware. Persistence is ONLY through the injected config singleton — the
 * module writes no files of its own (never `/etc/mediamtx.yml`).
 */
export interface NetworkIngestControlDeps {
	getConfig: () => RuntimeConfig;
	saveConfig: () => void;
	isRealDevice: () => Promise<boolean>;
	/** argv-only `systemctl <args>` runner (start/stop), like kiosk.ts. */
	systemctl: (args: string[]) => Promise<ExecResult>;
	/** `systemctl is-active <unit>` → true when active (idempotency gate). */
	isActive: (unit: string) => Promise<boolean>;
	/** NEW-topology marker: MediaMTX config binds SRT (file truth). */
	readMediamtxSrt: () => Promise<boolean>;
	/** OLD-topology marker: the standalone srt unit-file exists. */
	srtUnitPresent: () => Promise<boolean>;
	/** Refresh + broadcast the `status.network_ingest` snapshot on change. */
	refreshAndBroadcast: () => Promise<unknown>;
	/** Re-emit the unified `sources` snapshot so SourceSection rows update live. */
	broadcastSources: () => void;
	log: (msg: string) => void;
}

/** argv-only `systemctl is-active <unit>` → true iff the unit reports "active". */
async function probeIsActive(unit: string): Promise<boolean> {
	try {
		const { stdout } = await execFileP("systemctl", ["is-active", unit]);
		return stdout.trim() === "active";
	} catch (err) {
		const stdout = (err as { stdout?: string } | null)?.stdout ?? "";
		return stdout.trim() === "active";
	}
}

/** Whether the standalone srt unit-file exists (unit-file presence, NOT is-active). */
async function probeSrtUnitPresent(): Promise<boolean> {
	try {
		const { stdout } = await execFileP("systemctl", [
			"list-unit-files",
			SRT_GATEWAY_UNIT,
		]);
		return stdout.includes(SRT_GATEWAY_UNIT);
	} catch {
		return false;
	}
}

export const defaultNetworkIngestControlDeps: NetworkIngestControlDeps = {
	getConfig,
	saveConfig,
	isRealDevice: () => defaultIsRealDevice(),
	systemctl: (args) => execFileP("systemctl", args),
	isActive: probeIsActive,
	readMediamtxSrt: () => readMediamtxSrtEnabled(),
	srtUnitPresent: probeSrtUnitPresent,
	refreshAndBroadcast: () => refreshAndBroadcastNetworkIngest(),
	broadcastSources,
	log: (msg) => logger.info(msg),
};

/**
 * Persist the operator's toggle into config.json's `network_ingest` key via the
 * LIVE singleton (mutate `getConfig().network_ingest` + `saveConfig()`). This is
 * the SOLE persistence path — no parallel file writer.
 */
export function persistIngestDesired(
	protocol: RequiresGateway,
	enabled: boolean,
	deps: NetworkIngestControlDeps = defaultNetworkIngestControlDeps,
): void {
	const config = deps.getConfig();
	const current = readIngestDesired(config);
	const next = { ...current, [protocol]: enabled };
	config.network_ingest = { rtmp_enabled: next.rtmp, srt_enabled: next.srt };
	deps.saveConfig();
}

/**
 * Reconcile the running units to the persisted desired state. Reads the topology
 * markers, resolves the target unit set, and issues a start/stop ONLY for a unit
 * whose current is-active differs from the target — so a re-run against an
 * already-reconciled host spawns nothing (idempotent).
 */
async function applyIngestDesiredState(
	deps: NetworkIngestControlDeps,
): Promise<void> {
	const desired = readIngestDesired(deps.getConfig());
	const [mediamtxSrt, srtUnitPresent] = await Promise.all([
		deps.readMediamtxSrt(),
		deps.srtUnitPresent(),
	]);
	const actions = planIngestUnitActions(desired, {
		mediamtxSrt,
		srtUnitPresent,
	});

	for (const unit of actions.start) {
		if (!(await deps.isActive(unit))) await deps.systemctl(["start", unit]);
	}
	for (const unit of actions.stop) {
		if (await deps.isActive(unit)) await deps.systemctl(["stop", unit]);
	}
}

/**
 * Apply an operator toggle: persist the desired state FIRST (config singleton),
 * then reconcile the units, then refresh both the `status.network_ingest` and the
 * unified `sources` broadcasts. Only reached on the real-device path — the RPC
 * handler owns the mock/emulated gating.
 */
export async function setIngestEnabled(
	protocol: RequiresGateway,
	enabled: boolean,
	deps: NetworkIngestControlDeps = defaultNetworkIngestControlDeps,
): Promise<{
	success: true;
	applied: { protocol: RequiresGateway; enabled: boolean };
}> {
	persistIngestDesired(protocol, enabled, deps);
	try {
		await applyIngestDesiredState(deps);
	} catch (err) {
		deps.log(
			`network-ingest-control: apply failed for ${protocol}=${enabled}: ${String(err)}`,
		);
	}
	await deps.refreshAndBroadcast();
	deps.broadcastSources();
	return { success: true, applied: { protocol, enabled } };
}

let reconcileInFlight = false;

/**
 * Fire-and-forget boot reconcile of the persisted desired state. NEVER throws
 * (add-ons/gateways must never gate boot), self-serialises (a concurrent call is
 * a no-op), and no-ops on a dev/emulated host. Mirrors the addon reconciler.
 */
export async function reconcileIngestDesiredState(
	deps: NetworkIngestControlDeps = defaultNetworkIngestControlDeps,
): Promise<void> {
	if (reconcileInFlight) return;
	reconcileInFlight = true;
	try {
		if (!(await deps.isRealDevice())) {
			deps.log(
				"network-ingest-control: reconcile skipped (emulated / not a real device)",
			);
			return;
		}
		await applyIngestDesiredState(deps);
		await deps.refreshAndBroadcast();
		deps.broadcastSources();
	} catch (err) {
		deps.log(
			`network-ingest-control: reconcile aborted (non-fatal): ${String(err)}`,
		);
	} finally {
		reconcileInFlight = false;
	}
}
