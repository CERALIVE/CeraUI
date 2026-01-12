/*
CeraUI - Streaming Mock Provider
Simulates ceracoder/srtla streaming statistics for development mode
*/

import {
	getScenarioConfig,
	getStreamingStats,
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
 * Get mock bitrate data (legacy compatibility; now uses ceracoder config)
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
