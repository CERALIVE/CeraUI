/*
CeraUI - Streaming Mock Provider
Simulates cerastream/srtla streaming statistics for development mode
*/

import type {
	ProcessErrorCode,
	ProcessErrorSource,
	RuntimeErrorEvent,
} from "@ceralive/cerastream";
import {
	getMockState,
	getScenarioConfig,
	getStreamingStats,
	setMockStreamError,
	setStreamingState,
	shouldUseMocks,
} from "../mock-service.ts";

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
