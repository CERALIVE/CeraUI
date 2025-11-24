/*
	CeraUI - Mock Service Orchestrator
	Central service for managing mock state and data generation
*/

import { logger } from "../helpers/logger.ts";
import {
	type MockScenario,
	getActiveScenario,
	getScenarioConfig,
	isDevelopment,
	mockModems,
	mockWifiNetworks,
	scenarios,
	setActiveScenario,
} from "./mock-config.ts";

// Dynamic mock state that changes over time
interface MockState {
	initialized: boolean;
	modemSignals: Map<number, number>;
	modemStates: Map<number, "registered" | "connected" | "searching">;
	networkTraffic: Map<string, number>;
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
}

const mockState: MockState = {
	initialized: false,
	modemSignals: new Map(),
	modemStates: new Map(),
	networkTraffic: new Map(),
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
};

let updateInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize the mock service with a specific scenario
 */
export function initMockService(scenarioName?: string): void {
	if (mockState.initialized) {
		logger.info("Mock service already initialized");
		return;
	}

	// Determine scenario from env or parameter
	const scenario = (scenarioName ||
		process.env.MOCK_SCENARIO ||
		"multi-modem-wifi") as MockScenario;

	if (!scenarios[scenario]) {
		logger.warn(`Unknown mock scenario: ${scenario}, falling back to multi-modem-wifi`);
		setActiveScenario("multi-modem-wifi");
	} else {
		setActiveScenario(scenario);
	}

	const config = getScenarioConfig();
	logger.info(`🎭 Mock service initializing with scenario: ${getActiveScenario()}`);
	logger.info(`   ${config.description}`);

	// Initialize modem states
	for (let i = 0; i < config.modems; i++) {
		mockState.modemSignals.set(i, 80 + Math.random() * 15);
		mockState.modemStates.set(i, "connected");
	}

	// Initialize network traffic counters
	mockState.networkTraffic.set("eth0", 1000000);
	if (config.modems > 0) {
		for (let i = 0; i < config.modems; i++) {
			mockState.networkTraffic.set(`usb${i}`, 500000 + i * 100000);
		}
	}
	if (config.wifi) {
		mockState.networkTraffic.set("wlan0", 750000);
		// Initialize WiFi signal strengths
		for (const network of mockWifiNetworks) {
			mockState.wifiSignals.set(network.ssid, network.signal);
		}
	}

	// Initialize streaming state
	if (config.streaming) {
		mockState.streaming.isActive = true;
		mockState.streaming.connectedRelays = config.modems;
	}

	// Start periodic updates
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
export function getModemState(modemId: number): "registered" | "connected" | "searching" {
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

// Re-export commonly used functions
export { isDevelopment, getActiveScenario, getScenarioConfig, mockModems, mockWifiNetworks };

