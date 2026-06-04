/*
	CeraUI - Mock Service Orchestrator
	Central service for managing mock state and data generation
*/

import { logger } from "../helpers/logger.ts";
import {
	getActiveScenario,
	getScenarioConfig,
	isDevelopment,
	type MockScenario,
	mockModems,
	mockWifiNetworks,
	mockWifiRadios,
	scenarios,
	setActiveScenario,
} from "./mock-config.ts";
import type { Resolution, Framerate } from "../../../packages/rpc/src/schemas/streaming.schema.ts";

// ─── Mutable session-state slot types ────────────────────────────────────────

/** Per-device WiFi connection state (keyed by device id, e.g. "wlan0") */
export interface MockWifiConnectionState {
	activeNetwork?: string;
	savedNetworks: string[];
}

/** Per-modem mutable config (keyed by modem id string, e.g. "0", "1") */
export interface MockModemConfigState {
	apn?: string;
	network_type_active?: string;
	roaming?: boolean;
}

/** Per-interface mutable netif config (keyed by interface name, e.g. "eth0") */
export interface MockNetifConfigState {
	enabled: boolean;
	dhcp: boolean;
	ip?: string;
}

/** Encoder config echo — mirrors the fields T11/T13 mutate */
export interface MockEncoderConfigState {
	pipeline?: string;
	max_br?: number;
	bitrate_overlay?: boolean;
	resolution?: Resolution;
	framerate?: Framerate;
}

// Dynamic mock state that changes over time
interface MockState {
	initialized: boolean;
	modemSignals: Map<number, number>;
	modemStates: Map<number, "registered" | "connected" | "searching">;
	networkTraffic: Map<string, number>;
	interfaceThroughput: Record<string, number>;
	wifiModes: Record<string, "station" | "hotspot">;
	wifiSignals: Map<string, number>;
	sensors: {
		socTemp: number;
		socVoltage: number;
		socCurrent: number;
	};
	streaming: {
		isActive: boolean;
		bitrate: number;
		srtLatency: number;
		packetLoss: number;
		connectedRelays: number;
	};
	// ── Session-scoped mutable maps (seeded by initMockService) ──
	wifiConnections: Map<string, MockWifiConnectionState>;
	modemConfigs: Map<string, MockModemConfigState>;
	netifConfigs: Map<string, MockNetifConfigState>;
	mockEncoderConfig: MockEncoderConfigState;
}

const mockState: MockState = {
	initialized: false,
	modemSignals: new Map(),
	modemStates: new Map(),
	networkTraffic: new Map(),
	interfaceThroughput: {},
	wifiModes: {},
	wifiSignals: new Map(),
	sensors: {
		socTemp: 52,
		socVoltage: 5.0,
		socCurrent: 2.0,
	},
	streaming: {
		isActive: false,
		bitrate: 10000,
		srtLatency: 200,
		packetLoss: 0.1,
		connectedRelays: 0,
	},
	wifiConnections: new Map(),
	modemConfigs: new Map(),
	netifConfigs: new Map(),
	mockEncoderConfig: {},
};

let updateInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize (or re-initialize) the mock service with a specific scenario.
 * Re-calling resets all session-scoped maps to seeded defaults.
 */
export function initMockService(scenarioName?: string): void {
	// Determine scenario from env or parameter
	const scenario = (scenarioName ||
		process.env.MOCK_SCENARIO ||
		"multi-modem-wifi") as MockScenario;

	if (!scenarios[scenario]) {
		logger.warn(
			`Unknown mock scenario: ${scenario}, falling back to multi-modem-wifi`,
		);
		setActiveScenario("multi-modem-wifi");
	} else {
		setActiveScenario(scenario);
	}

	const config = getScenarioConfig();
	logger.info(
		`🎭 Mock service initializing with scenario: ${getActiveScenario()}`,
	);
	logger.info(`   ${config.description}`);

	mockState.modemSignals.clear();
	mockState.modemStates.clear();
	mockState.networkTraffic.clear();
	mockState.wifiSignals.clear();
	mockState.wifiConnections.clear();
	mockState.modemConfigs.clear();
	mockState.netifConfigs.clear();
	mockState.interfaceThroughput = {};
	mockState.wifiModes = {};

	for (let i = 0; i < config.modems; i++) {
		mockState.modemSignals.set(i, 80 + Math.random() * 15);
		mockState.modemStates.set(i, "connected");
	}

	mockState.networkTraffic.set("eth0", 1000000);
	if (config.modems > 0) {
		for (let i = 0; i < config.modems; i++) {
			mockState.networkTraffic.set(`usb${i}`, 500000 + i * 100000);
		}
	}
	if (config.wifi) {
		mockState.networkTraffic.set("wlan0", 750000);
		for (const network of mockWifiNetworks) {
			mockState.wifiSignals.set(network.ssid, network.signal);
		}
	}

	const mbpsToBytesPerSec = (value: number) => value * 125_000;
	mockState.interfaceThroughput.eth0 = mbpsToBytesPerSec(75);
	for (let i = 0; i < config.modems; i++) {
		mockState.interfaceThroughput[`usb${i}`] = mbpsToBytesPerSec(2 + i * 2);
	}
	if (config.wifi) {
		mockWifiRadios.forEach((radio, index) => {
			mockState.interfaceThroughput[radio.ifname] = mbpsToBytesPerSec(8 + index * 6);
			mockState.wifiModes[radio.device] = "station";
		});
	}

	if (config.streaming) {
		mockState.streaming.isActive = true;
		mockState.streaming.connectedRelays = config.modems;
	} else {
		mockState.streaming.isActive = false;
		mockState.streaming.connectedRelays = 0;
	}

	if (config.wifi) {
		const activeNetwork = mockWifiNetworks.find((n) => n.active);
		mockState.wifiConnections.set("wlan0", {
			activeNetwork: activeNetwork?.ssid,
			savedNetworks: mockWifiNetworks
				.filter((n) => n.active || n.ssid === "Office_Secure" || n.ssid === "StreamingStudio")
				.map((n) => n.ssid),
		});
	}

	for (let i = 0; i < config.modems; i++) {
		const modem = mockModems[i];
		if (!modem) continue;
		mockState.modemConfigs.set(String(i), {
			apn: `internet.${modem.carrier.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`,
			network_type_active: modem.network_type.active,
			roaming: false,
		});
	}

	mockState.netifConfigs.set("eth0", { enabled: true, dhcp: true, ip: "192.168.1.100" });
	for (let i = 0; i < config.modems; i++) {
		const modem = mockModems[i];
		if (!modem) continue;
		mockState.netifConfigs.set(modem.interfaceName, { enabled: true, dhcp: true, ip: modem.ip });
	}
	if (config.wifi) {
		mockState.netifConfigs.set("wlan0", { enabled: true, dhcp: true, ip: "192.168.2.100" });
	}

	mockState.mockEncoderConfig = {
		pipeline: "libuvch264",
		max_br: 8000,
		bitrate_overlay: false,
		resolution: "1080p",
		framerate: 30,
	};

	startPeriodicUpdates();

	mockState.initialized = true;
	logger.info("🎭 Mock service initialized successfully");
}

/**
 * Start periodic updates to simulate real-time data changes
 */
function startPeriodicUpdates(): void {
	if (updateInterval) {
		clearInterval(updateInterval);
	}

	updateInterval = setInterval(() => {
		updateMockState();
	}, 1000);
}

/**
 * Update mock state with realistic fluctuations
 */
function updateMockState(): void {
	const config = getScenarioConfig();

	// Update modem signals (fluctuate ±5%)
	for (const [id, signal] of mockState.modemSignals) {
		const fluctuation = (Math.random() - 0.5) * 10;
		const newSignal = Math.max(50, Math.min(100, signal + fluctuation));
		mockState.modemSignals.set(id, newSignal);
	}

	// Update network traffic (simulate data transfer)
	for (const [iface, bytes] of mockState.networkTraffic) {
		const increment = Math.floor(Math.random() * 100000) + 50000;
		mockState.networkTraffic.set(iface, bytes + increment);
	}

	// Update WiFi signals
	for (const [ssid, signal] of mockState.wifiSignals) {
		const fluctuation = (Math.random() - 0.5) * 6;
		const newSignal = Math.max(20, Math.min(100, signal + fluctuation));
		mockState.wifiSignals.set(ssid, newSignal);
	}

	// Update sensors
	const baseTemp = config.streaming ? 58 : 48;
	mockState.sensors.socTemp = baseTemp + (Math.random() - 0.5) * 10;
	mockState.sensors.socVoltage = 4.9 + Math.random() * 0.3;
	mockState.sensors.socCurrent = config.streaming
		? 2.5 + Math.random() * 0.5
		: 1.5 + Math.random() * 0.3;

	// Update streaming stats
	if (config.streaming && mockState.streaming.isActive) {
		mockState.streaming.bitrate = 9000 + Math.random() * 3000;
		mockState.streaming.srtLatency = 180 + Math.random() * 80;
		mockState.streaming.packetLoss = Math.random() * 0.5;
	}
}

/**
 * Get current mock state (for providers to access)
 */
export function getMockState(): Readonly<MockState> {
	return mockState;
}

/**
 * Get modem signal for a specific modem
 */
export function getModemSignal(modemId: number): number {
	return mockState.modemSignals.get(modemId) ?? 75;
}

/**
 * Get modem connection state
 */
export function getModemState(
	modemId: number,
): "registered" | "connected" | "searching" {
	return mockState.modemStates.get(modemId) ?? "searching";
}

/**
 * Get network traffic bytes for an interface
 */
export function getNetworkTraffic(iface: string): number {
	return mockState.networkTraffic.get(iface) ?? 0;
}

/**
 * Get WiFi signal for a network
 */
export function getWifiSignal(ssid: string): number {
	return mockState.wifiSignals.get(ssid) ?? 50;
}

/**
 * Get sensor readings
 */
export function getSensorReadings() {
	return { ...mockState.sensors };
}

/**
 * Get streaming stats
 */
export function getStreamingStats() {
	return { ...mockState.streaming };
}

/**
 * Set streaming state (for testing)
 */
export function setStreamingState(isActive: boolean): void {
	mockState.streaming.isActive = isActive;
	if (isActive) {
		const config = getScenarioConfig();
		mockState.streaming.connectedRelays = config.modems;
	} else {
		mockState.streaming.connectedRelays = 0;
	}
}

/**
 * Stop the mock service
 */
export function stopMockService(): void {
	if (updateInterval) {
		clearInterval(updateInterval);
		updateInterval = null;
	}
	mockState.initialized = false;
	logger.info("🎭 Mock service stopped");
}

/**
 * Check if mock service should be active
 */
export function shouldUseMocks(): boolean {
	return isDevelopment() && mockState.initialized;
}

export function setMockWifiConnection(
	deviceId: string,
	update: Partial<MockWifiConnectionState>,
): void {
	const current = mockState.wifiConnections.get(deviceId) ?? { savedNetworks: [] };
	mockState.wifiConnections.set(deviceId, { ...current, ...update });
}

/**
 * Stable, deterministic mock connection UUID for a WiFi SSID.
 * Used to build the `saved` map in wifiBuildMsg() and to reverse-map the
 * UUIDs the frontend sends back to connect/disconnect/forget procedures.
 */
export function mockWifiUuidForSsid(ssid: string): string {
	const slug = ssid
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `mock-wifi-${slug}`;
}

/**
 * Reverse lookup: resolve the SSID for a mock WiFi UUID by scanning the
 * known seeded networks. Returns undefined for unknown/real UUIDs.
 */
export function mockWifiSsidForUuid(uuid: string): string | undefined {
	for (const network of mockWifiNetworks) {
		if (mockWifiUuidForSsid(network.ssid) === uuid) {
			return network.ssid;
		}
	}
	return undefined;
}

export function setMockModemConfig(
	modemId: string,
	update: Partial<MockModemConfigState>,
): void {
	const current = mockState.modemConfigs.get(modemId) ?? {};
	mockState.modemConfigs.set(modemId, { ...current, ...update });
}

export function setMockNetifConfig(
	ifName: string,
	update: Partial<MockNetifConfigState>,
): void {
	const current = mockState.netifConfigs.get(ifName) ?? { enabled: true, dhcp: true };
	mockState.netifConfigs.set(ifName, { ...current, ...update });
}

export function setMockEncoderConfig(update: Partial<MockEncoderConfigState>): void {
	mockState.mockEncoderConfig = { ...mockState.mockEncoderConfig, ...update };
}

// Re-export commonly used functions
export {
	isDevelopment,
	getActiveScenario,
	getScenarioConfig,
	mockModems,
	mockWifiNetworks,
	mockWifiRadios,
};
