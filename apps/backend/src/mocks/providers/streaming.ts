/*
CeraUI - Streaming Mock Provider
Simulates cerastream/srtla streaming statistics for development mode
*/

import {
	type ActiveEncode,
	CerastreamConnectionError,
	type GetCapabilitiesResult,
	type ProcessErrorCode,
	type ProcessErrorSource,
	type RuntimeErrorEvent,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import type { RequiresGateway } from "@ceraui/rpc/schemas";
import {
	type EngineCapabilitiesSnapshot,
	getCapabilities,
	getLastCapabilities,
	MINIMAL_SAFE_CAPABILITIES,
} from "../../modules/streaming/capabilities.ts";
import type { LinkTelemetryMessage } from "../../modules/streaming/link-telemetry.ts";
import { broadcastMsg } from "../../modules/ui/websocket-server.ts";
import { mockWifiRadios, type ScenarioCapabilities } from "../mock-config.ts";
import {
	getMockState,
	getScenarioConfig,
	getStreamingStats,
	setMockStreamError,
	setStreamingState,
	shouldUseMocks,
	updateMockState,
} from "../mock-service.ts";

// The caps-full hardware profile: H265 + hardware acceleration and an
// audio-capable HDMI source alongside the always-present TestPattern.
// Deliberately distinct from MINIMAL_SAFE_CAPABILITIES so a resolved snapshot is
// never mistaken for the floor.
const FULL_PROFILE_CAPABILITIES: GetCapabilitiesResult = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "3840x2160",
	},
	encoder: {
		codecs: ["H264", "H265"],
		bitrate_range: { min: 1000, max: 12000, unit: "kbps" },
	},
	sources: [
		{
			id: "hdmi",
			supports_audio: true,
			supports_resolution_override: true,
			supports_framerate_override: true,
			default_resolution: "1920x1080",
			default_framerate: 60,
		},
		{
			id: "test",
			supports_audio: false,
			supports_resolution_override: false,
			supports_framerate_override: false,
			default_resolution: "1920x1080",
			default_framerate: 30,
		},
	],
};

const DEFAULT_MOCK_TRANSPORTS = ["srtla", "rist"] as const;

// The full-profile scenario's RESOLVED runtime encode, mirroring the engine's
// active_encode status field (cerastream 0.4.0): H265 egress off the audio-capable
// HDMI source. Reported only while the mock stream is active — an idle engine emits
// no active_encode, so the mock returns null when not streaming.
const FULL_PROFILE_ACTIVE_ENCODE: ActiveEncode = {
	codec: "h265",
	resolution: "1920x1080",
	framerate: 30,
	active_input: "hdmi",
};

// Active scenario's capabilities sub-config with any TEST-ONLY override
// (setMockEngineCapabilities) layered on top. Pure read of seeded state.
function resolveScenarioCapabilities(): ScenarioCapabilities {
	const scenario = getScenarioConfig().capabilities ?? {};
	const override = getMockState().capabilityOverride ?? {};
	return { ...scenario, ...override };
}

/**
 * Mock engine capability snapshot for dev/e2e, seeded by the active MOCK_SCENARIO
 * at boot (main.ts wires it as initPipelines' fetchEngineCapabilities). Resolvable
 * scenarios return a snapshot; the engine-starting / engine-unavailable profiles
 * THROW, so the real getCapabilities() fallback ladder produces the engineStarting
 * / engineUnavailable flags exactly as it does for a down engine on device.
 * Default scenarios keep the historical snapshot (MINIMAL_SAFE_CAPABILITIES +
 * ["srtla", "rist"]).
 */
export function getMockEngineCapabilities(): EngineCapabilitiesSnapshot {
	const profile = resolveScenarioCapabilities();

	if (profile.engineStarting) {
		throw new CerastreamConnectionError(
			"mock: engine starting — no live snapshot yet (scenario)",
		);
	}
	if (profile.engineUnavailable) {
		throw new CerastreamConnectionError("mock: engine unavailable (scenario)");
	}

	const caps = structuredClone(
		profile.fullProfile ? FULL_PROFILE_CAPABILITIES : MINIMAL_SAFE_CAPABILITIES,
	);
	if (profile.audioLiveSwitch) {
		caps.audio_live_switch = true;
	}
	const transports = [...(profile.transports ?? DEFAULT_MOCK_TRANSPORTS)];
	const schemaVersion = profile.schemaVersionMismatch
		? `${SCHEMA_VERSION}-mock-skew`
		: SCHEMA_VERSION;

	return { caps, schemaVersion, transports };
}

/**
 * TEST-ONLY seam: layer a capability-profile override onto the active scenario,
 * then re-resolve through the real getCapabilities() path and rebroadcast the
 * `capabilities` event — mirroring the boot injection so unit/e2e fixtures can
 * drive engine-gated UI without a runtime mutator.
 *
 * INTENDED FOR IDLE STATE ONLY: the rebroadcast is reliable when the device is
 * not actively streaming. Do NOT assert its mid-active-stream rebroadcast
 * semantics — a live stream owns the engine and its own capability lifecycle.
 * No-op unless the mock service is active (shouldUseMocks()), so production never
 * invokes the mock fetcher or this rebroadcast.
 */
export async function setMockEngineCapabilities(
	partial: Partial<ScenarioCapabilities>,
): Promise<void> {
	if (!shouldUseMocks()) {
		return;
	}
	const current = getMockState().capabilityOverride ?? {};
	updateMockState({ capabilityOverride: { ...current, ...partial } });
	await getCapabilities({
		fetchEngineCapabilities: async () => getMockEngineCapabilities(),
	});
	broadcastMsg("capabilities", getLastCapabilities());
}

/**
 * Mock per-link srtla_send telemetry for the status flow. Emits one row per
 * active bonded iface (eth0 + usbN modems + wifi radios) ONLY while the mock
 * stream is active — idle returns null, matching real srtla_send behavior. The
 * `iface` values EXACTLY equal the FE-derived `link.id` set so every bonded-link
 * card joins a real RTT/NAK/weight instead of a "--" placeholder.
 */
export function buildMockLinkTelemetry(): LinkTelemetryMessage | null {
	if (!shouldUseMocks()) {
		return null;
	}
	if (!getStreamingStats().isActive) {
		return null;
	}

	const config = getScenarioConfig();
	const ifaces: string[] = ["eth0"];
	for (let i = 0; i < config.modems; i++) {
		ifaces.push(`usb${i}`);
	}
	if (config.wifi) {
		for (const radio of mockWifiRadios) {
			ifaces.push(radio.ifname);
		}
	}

	const now = Date.now();

	// `weight_percent` is each active link's NORMALIZED share of the total
	// selection weight (base_score × quality), summing to ~100 across links — NOT
	// a per-link constant. Source of truth: srtla-send-rs
	// `src/telemetry_file.rs` `conns_from_stats` + `weight_share_percent`
	// (a lone link → 100, two equal → 50/50). Varied per-index bases + a gentle
	// drift simulate a rebalancing bond; strictly positive so the total is never 0.
	const rawLinks = ifaces.map((iface, index) => {
		// Deterministic per-link base plus a gentle bounded drift so the HUD shows
		// live movement across ticks, kept inside the 20-60 ms plausible window.
		const rttBase = 25 + index * 6;
		const rttDrift = Math.round(8 * Math.sin(now / 4000 + index));
		const rawWeight = Math.max(
			1,
			40 + index * 18 + 8 * Math.sin(now / 5000 + index),
		);
		return {
			conn_id: String(index),
			iface,
			rtt_ms: Math.min(60, Math.max(20, rttBase + rttDrift)),
			nak_count: index % 3,
			rawWeight,
			stale: false,
		};
	});
	const totalWeight = rawLinks.reduce((sum, link) => sum + link.rawWeight, 0);

	const links = rawLinks.map(({ rawWeight, ...entry }) => ({
		...entry,
		weight_percent: Math.round((rawWeight / totalWeight) * 100),
	}));

	return { links, lastReadMs: now };
}

/**
 * Check if streaming scenario is active
 */
export function isStreamingScenario(): boolean {
	if (!shouldUseMocks()) {
		return false;
	}
	const config = getScenarioConfig();
	return config.streaming;
}

/**
 * Get mock bitrate data (legacy compatibility; now uses the encoder config)
 */
export function getMockBitrateData(): string {
	if (!shouldUseMocks()) {
		return "";
	}

	const stats = getStreamingStats();
	if (!stats.isActive) {
		return "";
	}

	// Format: bitrate in kbps
	return Math.round(stats.bitrate).toString();
}

/**
 * Get mock SRT statistics
 */
export function getMockSrtStats() {
	if (!shouldUseMocks()) {
		return null;
	}

	const stats = getStreamingStats();
	if (!stats.isActive) {
		return null;
	}

	return {
		bitrate: stats.bitrate,
		latency: stats.srtLatency,
		packetLoss: stats.packetLoss,
		rtt: 50 + Math.random() * 30, // Round-trip time in ms
		bandwidth: stats.bitrate * 1.2, // Available bandwidth
	};
}

/**
 * Get mock SRTLA connection stats per interface
 */
export function getMockSrtlaStats() {
	if (!shouldUseMocks()) {
		return null;
	}

	const config = getScenarioConfig();
	const stats = getStreamingStats();

	if (!stats.isActive) {
		return null;
	}

	// Generate stats for each connected modem
	const interfaceStats: Record<
		string,
		{
			sent: number;
			lost: number;
			retransmitted: number;
			rtt: number;
		}
	> = {};

	for (let i = 0; i < config.modems; i++) {
		const ifname = `usb${i}`;
		interfaceStats[ifname] = {
			sent: Math.floor(Math.random() * 10000) + 5000,
			lost: Math.floor(Math.random() * 10),
			retransmitted: Math.floor(Math.random() * 50),
			rtt: 40 + Math.random() * 60,
		};
	}

	return interfaceStats;
}

/**
 * Get mock BCRP relay status
 */
export function getMockBcrpStatus() {
	if (!shouldUseMocks()) {
		return null;
	}

	const stats = getStreamingStats();
	if (!stats.isActive || stats.connectedRelays === 0) {
		return null;
	}

	return {
		connected: true,
		relayCount: stats.connectedRelays,
		serverIps: ["relay1.example.com", "relay2.example.com"].slice(
			0,
			stats.connectedRelays,
		),
	};
}

/**
 * Start mock streaming (for testing)
 */
export function startMockStreaming(): void {
	if (!shouldUseMocks()) {
		return;
	}
	setStreamingState(true);
}

/**
 * Stop mock streaming (for testing)
 */
export function stopMockStreaming(): void {
	if (!shouldUseMocks()) {
		return;
	}
	setStreamingState(false);
}

/**
 * Check if we should mock streaming
 */
export function shouldMockStreaming(): boolean {
	return shouldUseMocks();
}

/**
 * Get mock encoder output info
 */
export function getMockEncoderInfo() {
	if (!shouldUseMocks()) {
		return null;
	}

	const stats = getStreamingStats();
	if (!stats.isActive) {
		return null;
	}

	return {
		resolution: "1920x1080",
		framerate: 30,
		codec: "h264",
		profile: "high",
		bitrate: stats.bitrate,
		keyframeInterval: 2,
	};
}

/**
 * Mock RESOLVED runtime encode (cerastream `active_encode` status field). Returns
 * the full-profile encode while the mock stream is active, null when idle — the
 * same present-while-streaming / absent-on-heartbeat contract the real engine
 * follows. No-op (null) unless the mock service is active.
 */
export function getMockActiveEncode(): ActiveEncode | null {
	if (!shouldUseMocks()) {
		return null;
	}
	if (!getStreamingStats().isActive) {
		return null;
	}
	return { ...FULL_PROFILE_ACTIVE_ENCODE };
}

/**
 * Format streaming stats for display
 */
export function formatMockStreamingStats(): Record<string, string> {
	if (!shouldUseMocks()) {
		return {};
	}

	const stats = getStreamingStats();
	if (!stats.isActive) {
		return {};
	}

	return {
		"Stream bitrate": `${(stats.bitrate / 1000).toFixed(1)} Mbps`,
		"SRT latency": `${stats.srtLatency.toFixed(0)} ms`,
		"Packet loss": `${stats.packetLoss.toFixed(2)}%`,
		"Connected relays": stats.connectedRelays.toString(),
	};
}

// ─── cerastream Tier-2 structured-error injection (Task 16) ───────────────────

/**
 * A cerastream Tier-2 structured error class — exactly the engine's runtime
 * error codes (`RuntimeErrorEvent["code"]`), so the mock can never invent a code
 * the real engine does not emit.
 */
export type CerastreamTier2Error = ProcessErrorCode;

// Canonical emitting source per Tier-2 code, mirroring the real engine contract:
// srtla-bonding failures originate from the srtla process; capture / pipeline /
// SRT-transport (state-transition) failures originate from the engine. The
// exhaustive Record turns a binding-side code addition into a compile error here.
const TIER2_ERROR_SOURCE: Record<ProcessErrorCode, ProcessErrorSource> = {
	srtla_initial_connect_failed: "srtla",
	srtla_no_connections: "srtla",
	capture_audio_error: "engine",
	capture_video_error: "engine",
	pipeline_stall: "engine",
	srt_connect_failed: "engine",
	srt_connection_lost: "engine",
};

/**
 * Drive a cerastream Tier-2 structured error into the mock streaming state so a
 * test can exercise the backend's structured error-mapping path. Builds the real
 * `RuntimeErrorEvent` wire shape (correct source per the contract) and records it
 * as the injected error. No-op (returns null) unless the mock service is active.
 */
export function injectMockStreamError(
	errorClass: CerastreamTier2Error,
	reason?: string,
): RuntimeErrorEvent | null {
	if (!shouldUseMocks()) {
		return null;
	}
	const previous = getMockState().injectedStreamError;
	const event: RuntimeErrorEvent = {
		type: "error",
		seq: previous ? previous.seq + 1 : 0,
		code: errorClass,
		source: TIER2_ERROR_SOURCE[errorClass],
		...(reason !== undefined ? { reason } : {}),
	};
	setMockStreamError(event);
	return event;
}

/** The currently injected Tier-2 error event, or null when none / mocks inactive. */
export function getInjectedMockStreamError(): RuntimeErrorEvent | null {
	if (!shouldUseMocks()) {
		return null;
	}
	return getMockState().injectedStreamError;
}

/** Clear any injected Tier-2 error. No-op unless the mock service is active. */
export function clearMockStreamError(): void {
	if (!shouldUseMocks()) {
		return;
	}
	setMockStreamError(null);
}

// ─── Network-ingest gateway active state (Task 17) ────────────────────────────

/**
 * Drive the dev/mock active state of a network-ingest gateway (rtmp/srt) so a
 * test can exercise both sides of the streaming.start gateway gate without a real
 * ingest server. No-op unless the mock service is active.
 */
export function setMockGatewayActive(
	kind: RequiresGateway,
	active: boolean,
): void {
	if (!shouldUseMocks()) {
		return;
	}
	updateMockState({
		gatewayActive: { ...getMockState().gatewayActive, [kind]: active },
	});
}

/** Whether the given network-ingest gateway is active in dev/mock (false when mocks inactive). */
export function isMockGatewayActive(kind: RequiresGateway): boolean {
	if (!shouldUseMocks()) {
		return false;
	}
	return getMockState().gatewayActive[kind] === true;
}
