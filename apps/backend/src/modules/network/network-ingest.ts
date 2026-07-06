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
 * Network-ingest gateway status surface (Task 16).
 *
 * The device image bakes in local ingest gateways. RTMP is always MediaMTX
 * (`ceralive-rtmp-gateway.service`, listening on :1935 path `publish/live`).
 * SRT is served by ONE of two topologies during the B2 fleet transition:
 *   - OLD: a standalone `ceralive-srt-gateway.service` (srt-live-transmit) on
 *     :4001;
 *   - NEW: the SAME MediaMTX unit terminating SRT too (proved by `/etc/mediamtx.yml`
 *     top-level keys `srt: yes` + `srtAddress: :4001`, the marker Task 14 ships).
 *
 * SRT availability is a FAIL-CLOSED merge (see {@link resolveSrtTopology}): the OLD
 * unit active, OR MediaMTX active AND its config proves SRT is bound. "rtmp active"
 * alone NEVER implies SRT — an old image whose srt unit died must not false-positive.
 * A parse failure or absent config → NOT srt-capable. The serving topology is
 * recorded on `srt.gateway` (additive).
 *
 * Safety contract (mirrors policy-route-check.ts):
 *   - The systemctl spawn + config read are gated on `isRealDevice()`. On a
 *     dev/emulated host they NEVER run; the mock provider drives the signals.
 *   - A protocol the board's capability source kinds exclude is reported `null`
 *     (an N100 profile without the `srt` source → `srt: null`).
 *   - Every failure degrades to the last cached snapshot; the refresh never
 *     throws into the heartbeat loop.
 *
 * The cache is read SYNCHRONOUSLY by {@link getNetworkIngestInfo} (and the
 * streaming-gate `GatewayProbe`, Task 17) and refreshed asynchronously on the
 * heartbeat cadence — so the stream-start gate never blocks on a spawn.
 */

import {
	NETWORK_INGEST_NO_ADDRESS_REASON,
	type NetworkIngest,
	type RequiresGateway,
	type SrtGatewayTopology,
} from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks as defaultShouldUseMocks } from "../../mocks/mock-service.ts";
import { resolveMockNetworkIngestSignals } from "../../mocks/providers/network-ingest.ts";
import { getConfig } from "../config.ts";
import { getLastCapabilities } from "../streaming/capabilities.ts";
import type { GatewayProbe } from "../streaming/gateway-availability.ts";
import { isRealDevice as defaultIsRealDevice } from "../system/device-detection.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import {
	getNetworkInterfaces,
	NETIF_ERR_HOTSPOT,
} from "./network-interfaces.ts";

export const RTMP_GATEWAY_UNIT = "ceralive-rtmp-gateway.service";
export const SRT_GATEWAY_UNIT = "ceralive-srt-gateway.service";

export const RTMP_INGEST_PORT = 1935;
export const RTMP_INGEST_PATH = "publish/live";
export const SRT_INGEST_PORT = 4001;

export const MEDIAMTX_CONFIG_PATH = "/etc/mediamtx.yml";

/** The RTMP publish URL a same-LAN encoder targets (cerastream `RtmpLocalhost`). */
export function buildRtmpUrl(lanIp: string): string {
	return `rtmp://${lanIp}:${RTMP_INGEST_PORT}/${RTMP_INGEST_PATH}`;
}

/** The SRT listener URL a same-LAN encoder targets (srt-live-transmit). */
export function buildSrtUrl(lanIp: string): string {
	return `srt://${lanIp}:${SRT_INGEST_PORT}`;
}

/** The source kinds the board's capability contract offers (e.g. rtmp/srt/hdmi). */
export function capabilitySourceKinds(
	caps: { sources?: ReadonlyArray<{ id: string }> } | undefined,
): Set<string> {
	return new Set((caps?.sources ?? []).map((s) => s.id));
}

/** Raw per-refresh gateway signals feeding the fail-closed SRT merge. */
export type NetworkIngestGatewaySignals = {
	rtmpUnitActive: boolean;
	srtUnitActive: boolean;
	mediamtxSrt: boolean;
};

/**
 * Parse whether MediaMTX binds SRT on the pinned :4001 port from its top-level
 * YAML keys `srt: yes` + `srtAddress: :4001` (the marker Task 14 ships). A
 * targeted line-parse, not a YAML lib: only column-0 keys count, so a nested
 * `srt:` under another block never satisfies it. Fail-closed — any missing/false
 * key or wrong port returns false.
 */
export function parseMediamtxSrtEnabled(yaml: string): boolean {
	let srtEnabled = false;
	let srtAddressBound = false;
	for (const raw of yaml.split(/\r?\n/)) {
		if (raw.length === 0 || /^[\s#]/.test(raw)) continue;
		const match = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(raw);
		if (!match) continue;
		const key = match[1];
		const value = (match[2] ?? "")
			.replace(/\s+#.*$/, "")
			.trim()
			.replace(/^["']|["']$/g, "")
			.trim();
		if (key === "srt") {
			srtEnabled = /^(?:yes|true|on)$/i.test(value);
		} else if (key === "srtAddress") {
			srtAddressBound = value.endsWith(`:${SRT_INGEST_PORT}`);
		}
	}
	return srtEnabled && srtAddressBound;
}

/**
 * Read + parse `/etc/mediamtx.yml` for the NEW-topology SRT marker. Bounded and
 * fail-closed: a missing/unreadable file or parse error → false (NOT srt-capable).
 * Exported so the desired-state control module reuses the SAME file-truth marker
 * (valid even when the units are stopped) rather than duplicating the read.
 */
export async function readMediamtxSrtEnabled(
	path = MEDIAMTX_CONFIG_PATH,
): Promise<boolean> {
	try {
		const file = Bun.file(path);
		if (!(await file.exists())) return false;
		return parseMediamtxSrtEnabled(await file.text());
	} catch (err) {
		logger.debug("network-ingest: mediamtx.yml read failed", { err });
		return false;
	}
}

/**
 * Fail-closed dual-topology SRT merge: available iff the OLD standalone unit is
 * active, OR MediaMTX is active AND its config proves SRT is bound. "rtmp active"
 * alone NEVER implies SRT. Records which topology is serving it.
 */
export function resolveSrtTopology(signals: NetworkIngestGatewaySignals): {
	active: boolean;
	gateway?: SrtGatewayTopology;
} {
	if (signals.srtUnitActive) {
		return { active: true, gateway: "srt-live-transmit" };
	}
	if (signals.rtmpUnitActive && signals.mediamtxSrt) {
		return { active: true, gateway: "mediamtx" };
	}
	return { active: false };
}

type NetifLike = Record<
	string,
	{ ip?: string; enabled: boolean; error?: number } | undefined
>;

const LAN_PREFERRED_RE = /^(?:eth|en)/;
// Cellular/WWAN (usb-tethered + wwan/wwx) + virtual/loopback links are NEVER a
// valid publish target: the ingress firewall drops WAN/modem paths, so
// advertising one would be a lie. WiFi is handled separately (AP-mode included,
// station excluded) so `wl` is deliberately absent here.
const LAN_EXCLUDE_RE = /^(?:usb|ww|lo$|docker|veth|l4tbr|tun|tap)/;
const WIFI_RE = /^wl/;

function isHotspotIface(entry: { error?: number }): boolean {
	return ((entry.error ?? 0) & NETIF_ERR_HOTSPOT) !== 0;
}

/**
 * Resolve the address a same-network encoder reaches the gateways at, from
 * LAN/hotspot interfaces ONLY — NEVER a cellular/WWAN IP. Ranking:
 *   1. a wired ethernet link (`eth*`/`en*`);
 *   2. the device's own WiFi hotspot/AP (a `wl*` iface flagged NETIF_ERR_HOTSPOT,
 *      reachable by joined clients);
 *   3. any other non-cellular, non-virtual LAN link (e.g. a bridge).
 * A WiFi STATION link is skipped (a roaming/carrier-NAT'd client cannot reliably
 * reach the device there); cellular/WWAN/virtual links are excluded outright.
 */
export function resolvePrimaryLanIp(netif: NetifLike): string | undefined {
	let preferred: string | undefined;
	let hotspot: string | undefined;
	let fallback: string | undefined;
	for (const name in netif) {
		const entry = netif[name];
		if (!entry?.ip || !entry.enabled) continue;
		if (LAN_PREFERRED_RE.test(name)) {
			preferred ??= entry.ip;
			continue;
		}
		if (LAN_EXCLUDE_RE.test(name)) continue;
		if (WIFI_RE.test(name)) {
			if (isHotspotIface(entry)) hotspot ??= entry.ip;
			continue;
		}
		fallback ??= entry.ip;
	}
	return preferred ?? hotspot ?? fallback;
}

function buildProtocolInfo(
	kind: RequiresGateway,
	lanIp: string | undefined,
	active: boolean,
	sourceKinds: Set<string>,
	gateway?: SrtGatewayTopology,
	operatorDisabled = false,
): NetworkIngest["rtmp"] {
	if (!sourceKinds.has(kind)) return null;
	const gatewayField = gateway ? { gateway } : {};
	const operatorField = operatorDisabled ? { operator_disabled: true } : {};
	if (lanIp === undefined) {
		return {
			service_active: active,
			url: null,
			unavailable_reason: NETWORK_INGEST_NO_ADDRESS_REASON,
			...gatewayField,
			...operatorField,
		};
	}
	return {
		service_active: active,
		url: kind === "rtmp" ? buildRtmpUrl(lanIp) : buildSrtUrl(lanIp),
		...gatewayField,
		...operatorField,
	};
}

/** Per-protocol operator desired-disabled flags (from config `network_ingest`). */
export type OperatorDisabled = { rtmp: boolean; srt: boolean };

/** Assemble the `network_ingest` payload from the resolved facts (pure). */
export function deriveNetworkIngestInfo(params: {
	lanIp: string | undefined;
	rtmpActive: boolean;
	srtActive: boolean;
	srtGateway?: SrtGatewayTopology;
	sourceKinds: Set<string>;
	operatorDisabled?: OperatorDisabled;
}): NetworkIngest {
	const {
		lanIp,
		rtmpActive,
		srtActive,
		srtGateway,
		sourceKinds,
		operatorDisabled,
	} = params;
	return {
		rtmp: buildProtocolInfo(
			"rtmp",
			lanIp,
			rtmpActive,
			sourceKinds,
			undefined,
			operatorDisabled?.rtmp ?? false,
		),
		srt: buildProtocolInfo(
			"srt",
			lanIp,
			srtActive,
			sourceKinds,
			srtGateway,
			operatorDisabled?.srt ?? false,
		),
	};
}

/**
 * Effectful collaborators, injected so the gate + failure modes are testable
 * without hardware. Defaults talk to the real OS / live caches.
 */
export type NetworkIngestDeps = {
	isRealDevice: () => Promise<boolean>;
	shouldUseMocks: () => boolean;
	resolveMockSignals: () => NetworkIngestGatewaySignals;
	probeServiceActive: (unit: string) => Promise<boolean>;
	probeMediamtxSrt: () => Promise<boolean>;
	getNetif: () => NetifLike;
	getSourceKinds: () => Set<string>;
	/** Operator desired-disabled flags; omitted deps default to "not disabled". */
	getOperatorDisabled?: () => OperatorDisabled;
};

/** Argv-only `systemctl is-active <unit>` → true iff the unit reports "active". */
async function systemctlIsActive(unit: string): Promise<boolean> {
	const proc = Bun.spawn(["systemctl", "is-active", unit], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const stdout = (await new Response(proc.stdout).text()).trim();
	await proc.exited;
	return stdout === "active";
}

/**
 * Read the board's offered source kinds from the last resolved capability
 * snapshot. `getCapabilities()` populates it (post-login + pipeline init); a live
 * fetch is deliberately NOT triggered per refresh tick.
 */
function defaultSourceKinds(): Set<string> {
	return capabilitySourceKinds(getLastCapabilities());
}

/** Read the operator desired-disabled flags off the live config singleton. */
function defaultOperatorDisabled(): OperatorDisabled {
	const ni = getConfig().network_ingest;
	return { rtmp: ni?.rtmp_enabled === false, srt: ni?.srt_enabled === false };
}

export const defaultNetworkIngestDeps: NetworkIngestDeps = {
	isRealDevice: () => defaultIsRealDevice(),
	shouldUseMocks: defaultShouldUseMocks,
	resolveMockSignals: resolveMockNetworkIngestSignals,
	probeServiceActive: systemctlIsActive,
	probeMediamtxSrt: () => readMediamtxSrtEnabled(),
	getNetif: getNetworkInterfaces,
	getSourceKinds: defaultSourceKinds,
	getOperatorDisabled: defaultOperatorDisabled,
};

let cached: NetworkIngest = { rtmp: null, srt: null };

/** The last resolved network-ingest snapshot (synchronous read). */
export function getNetworkIngestInfo(): NetworkIngest {
	return cached;
}

async function computeNetworkIngestInfo(
	deps: NetworkIngestDeps,
): Promise<NetworkIngest> {
	const sourceKinds = deps.getSourceKinds();
	const lanIp = resolvePrimaryLanIp(deps.getNetif());
	const operatorDisabled = deps.getOperatorDisabled?.() ?? {
		rtmp: false,
		srt: false,
	};

	if (deps.shouldUseMocks()) {
		const signals = deps.resolveMockSignals();
		const srt = resolveSrtTopology(signals);
		return deriveNetworkIngestInfo({
			lanIp,
			rtmpActive: signals.rtmpUnitActive,
			srtActive: srt.active,
			sourceKinds,
			operatorDisabled,
			...(srt.gateway ? { srtGateway: srt.gateway } : {}),
		});
	}

	if (!(await deps.isRealDevice())) {
		return { rtmp: null, srt: null };
	}

	const [rtmpUnitActive, srtUnitActive, mediamtxSrt] = await Promise.all([
		deps.probeServiceActive(RTMP_GATEWAY_UNIT),
		deps.probeServiceActive(SRT_GATEWAY_UNIT),
		deps.probeMediamtxSrt(),
	]);
	const srt = resolveSrtTopology({
		rtmpUnitActive,
		srtUnitActive,
		mediamtxSrt,
	});
	return deriveNetworkIngestInfo({
		lanIp,
		rtmpActive: rtmpUnitActive,
		srtActive: srt.active,
		sourceKinds,
		operatorDisabled,
		...(srt.gateway ? { srtGateway: srt.gateway } : {}),
	});
}

/** Recompute + cache the snapshot. Never throws — degrades to the last cache. */
export async function refreshNetworkIngestInfo(
	deps: NetworkIngestDeps = defaultNetworkIngestDeps,
): Promise<NetworkIngest> {
	try {
		cached = await computeNetworkIngestInfo(deps);
	} catch (err) {
		logger.debug("network-ingest: refresh degraded", { err });
	}
	return cached;
}

let lastBroadcastJson: string | null = null;

/**
 * Refresh the snapshot and push a `status` frame carrying `network_ingest` only
 * when it changes, on the shared heartbeat tick (mirrors link-telemetry). Folds
 * into the existing status flow — no new endpoint.
 */
export async function refreshAndBroadcastNetworkIngest(
	deps: NetworkIngestDeps = defaultNetworkIngestDeps,
): Promise<NetworkIngest> {
	const info = await refreshNetworkIngestInfo(deps);
	const json = JSON.stringify(info);
	if (json !== lastBroadcastJson) {
		lastBroadcastJson = json;
		broadcastMsg("status", { network_ingest: info });
	}
	return info;
}

/**
 * The synchronous streaming-gate probe (Task 17 seam) backed by the cache.
 * Start-eligible = unit active AND operator has NOT disabled it (Task 7):
 * `pipelineAvailability` and the mock `isMockGatewayActive` mirror this predicate.
 */
export function buildGatewayProbe(): GatewayProbe {
	return {
		isActive(kind: RequiresGateway): boolean {
			const slot = getNetworkIngestInfo()[kind];
			return slot?.service_active === true && slot.operator_disabled !== true;
		},
	};
}

/** Clear the cached snapshot + broadcast dedup (test isolation). */
export function resetNetworkIngestState(): void {
	cached = { rtmp: null, srt: null };
	lastBroadcastJson = null;
}
