/*
	CeraUI - Mock Service Orchestrator
	Central service for managing mock state and data generation
*/

// State lifecycle: init → mutate via updateMockState() → reset via resetMockState()
//
//   init    initMockService(scenario) seeds the mutable `mockState` from the
//           active scenario, captures a deep pristine snapshot, and starts the
//           periodic-fluctuation + relay timers.
//   mutate  every write to `mockState` funnels through updateMockState(partial):
//           the four public setters (modem / wifi-connection / netif / encoder)
//           are thin wrappers that compute the next slice and hand it to the
//           single typed merger. `mockState` is the sole owner of session state.
//   reset   resetMockState() restores the pristine snapshot AND clears every
//           timer — side-effect-clean, so each test starts from the scenario's
//           seeded state with no leaked intervals or cross-test bleed.

import type { AddonConfig, AddonState } from "@ceraui/rpc/schemas";
import { logger } from "../helpers/logger.ts";
import {
	buildRelaysMsg,
	getRelays,
	setRelaysCacheMock,
} from "../modules/remote/remote-relays.ts";
import { broadcastMsg } from "../modules/ui/websocket-server.ts";
import { buildMockSimState } from "./fixture-factory.ts";
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
import {
	BITRATE_MAX_KBPS,
	BITRATE_MIN_KBPS,
	MOCK_RELAY_POPULATE_DELAY_MS,
	MOCK_RTT_INTERVAL_MS,
	MODEM_SIGNAL_FLUCTUATION_PERCENT,
	SENSOR_CURRENT_IDLE_A,
	SENSOR_CURRENT_IDLE_RANGE_A,
	SENSOR_CURRENT_STREAMING_A,
	SENSOR_CURRENT_STREAMING_RANGE_A,
	SENSOR_TEMP_BASE_IDLE_C,
	SENSOR_TEMP_BASE_STREAMING_C,
	SENSOR_TEMP_FLUCTUATION_C,
	SENSOR_VOLTAGE_BASE_V,
	SENSOR_VOLTAGE_RANGE_V,
	WIFI_SIGNAL_FLUCTUATION_PERCENT,
} from "./mock-constants.ts";
import type {
	MockEncoderConfigState,
	MockHealthState,
	MockModemConfigState,
	MockNetifConfigState,
	MockSimState,
	MockStreamErrorState,
	MockWifiConnectionState,
} from "./mock-schemas.ts";
import { validateMockFixtures } from "./mock-schemas.ts";
import { MockAddonDescriptor, MockAddonState } from "./providers/addons.ts";
import { resetMockKioskState } from "./providers/kiosk.ts";
import { getMockRelaysCache } from "./providers/relays.ts";

// Session-state slot shapes + their Zod schemas live in mock-schemas.ts, so the
// same schema both types these slots and validates the shipped fixtures at init.
export type {
	MockEncoderConfigState,
	MockHealthState,
	MockModemConfigState,
	MockNetifConfigState,
	MockSimState,
	MockStreamErrorState,
	MockWifiConnectionState,
};

// Dynamic mock state that changes over time
export interface MockState {
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
	// `null` = health is fully engine-derived (deriveMockHealth); a partial here
	// is layered on top by getMockHealth() for edge-case tests only.
	mockHealthOverride: Partial<MockHealthState> | null;
	// Last cerastream Tier-2 structured error driven in via injectMockStreamError,
	// or null when none (Task 16); resets with the scenario like the maps above.
	injectedStreamError: MockStreamErrorState;
	// Per-modem SIM lock state (keyed by modem id string) + the in-memory stand-in
	// for the chmod-600 tmpfs PIN secret read; both reset with the scenario.
	simStates: Map<string, MockSimState>;
	simPinSecret: string | null;
	// Add-on runtime state (config.json `addons` shape), seeded from the mock
	// fixture so resetMockState() restores it like every other session slot.
	mockAddons: AddonConfig;
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
	mockHealthOverride: null,
	injectedStreamError: null,
	simStates: new Map(),
	simPinSecret: null,
	mockAddons: {},
};

// Deep snapshot of `mockState` captured at the end of initMockService — the
// pristine seeded state for the active scenario that resetMockState() restores.
let pristineSnapshot: MockState | null = null;

let updateInterval: ReturnType<typeof setInterval> | null = null;

// Delay before the mock relay cache is populated, so the frontend can exercise
// the "no relays" → populated transition on a fresh dev start.
let relayPopulateTimeout: ReturnType<typeof setTimeout> | null = null;

// Periodic mock RTT rebroadcast. Once relays are populated, recompute mock RTT
// and re-emit `relays` on this cadence so the UI sees live, changing RTT values.
let rttBroadcastInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize (or re-initialize) the mock service with a specific scenario.
 * Re-calling resets all session-scoped maps to seeded defaults.
 */
export function initMockService(scenarioName?: string): void {
	// Fail loudly on a drifted fixture before any state is seeded from it.
	validateMockFixtures();

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
	mockState.simStates.clear();
	mockState.simPinSecret = null;
	mockState.mockHealthOverride = null;
	mockState.injectedStreamError = null;
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
			mockState.interfaceThroughput[radio.ifname] = mbpsToBytesPerSec(
				8 + index * 6,
			);
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
				.filter(
					(n) =>
						n.active ||
						n.ssid === "Office_Secure" ||
						n.ssid === "StreamingStudio",
				)
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
		mockState.simStates.set(String(i), buildMockSimState());
	}

	mockState.netifConfigs.set("eth0", {
		enabled: true,
		dhcp: true,
		ip: "192.168.1.100",
	});
	for (let i = 0; i < config.modems; i++) {
		const modem = mockModems[i];
		if (!modem) continue;
		mockState.netifConfigs.set(modem.interfaceName, {
			enabled: true,
			dhcp: true,
			ip: modem.ip,
		});
	}
	if (config.wifi) {
		mockState.netifConfigs.set("wlan0", {
			enabled: true,
			dhcp: true,
			ip: "192.168.2.100",
		});
	}

	mockState.mockEncoderConfig = {
		pipeline: "libuvch264",
		max_br: 8000,
		bitrate_overlay: false,
		resolution: "1080p",
		framerate: 30,
	};

	mockState.mockAddons = {
		[MockAddonDescriptor.id]: structuredClone(MockAddonState),
	};

	startPeriodicUpdates();

	mockState.initialized = true;
	pristineSnapshot = structuredClone(mockState);
	logger.info("🎭 Mock service initialized successfully");

	scheduleRelayPopulate();
}

// After a short delay, drop the mock relay cache in and rebroadcast so the
// initial connect snapshot sends `relays: null` and the UI transitions to the
// populated state. Cleared/recreated on re-init to stay idempotent.
function scheduleRelayPopulate(): void {
	if (relayPopulateTimeout) {
		clearTimeout(relayPopulateTimeout);
	}
	if (rttBroadcastInterval) {
		clearInterval(rttBroadcastInterval);
		rttBroadcastInterval = null;
	}
	relayPopulateTimeout = setTimeout(() => {
		relayPopulateTimeout = null;
		if (!shouldUseMocks()) return;
		setRelaysCacheMock(getMockRelaysCache());
		broadcastMsg("relays", buildRelaysMsg());
		logger.info("🎭 Mock relays populated after startup delay");
		startRttBroadcast();
	}, MOCK_RELAY_POPULATE_DELAY_MS);
}

function startRttBroadcast(): void {
	if (rttBroadcastInterval) {
		clearInterval(rttBroadcastInterval);
	}
	rttBroadcastInterval = setInterval(() => {
		if (!shouldUseMocks()) return;
		// setRemoteConfig (remote.ts) clears the relay cache on a provider/key
		// switch; production re-fetches it from the cloud on reconnect, but the
		// mock has no cloud, so re-seed here to keep the mock catalog continuously
		// available across a session.
		if (!getRelays()) setRelaysCacheMock(getMockRelaysCache());
		broadcastMsg("relays", buildRelaysMsg());
	}, MOCK_RTT_INTERVAL_MS);
}

/**
 * Start periodic updates to simulate real-time data changes
 */
function startPeriodicUpdates(): void {
	if (updateInterval) {
		clearInterval(updateInterval);
	}

	updateInterval = setInterval(() => {
		applyPeriodicFluctuations();
	}, 1000);
}

/**
 * Update mock state with realistic fluctuations
 */
function applyPeriodicFluctuations(): void {
	const config = getScenarioConfig();

	// Update modem signals (fluctuate ±MODEM_SIGNAL_FLUCTUATION_PERCENT%)
	for (const [id, signal] of mockState.modemSignals) {
		const fluctuation =
			(Math.random() - 0.5) * (MODEM_SIGNAL_FLUCTUATION_PERCENT * 2);
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
		const fluctuation =
			(Math.random() - 0.5) * (WIFI_SIGNAL_FLUCTUATION_PERCENT * 2);
		const newSignal = Math.max(20, Math.min(100, signal + fluctuation));
		mockState.wifiSignals.set(ssid, newSignal);
	}

	// Update sensors
	const baseTemp = config.streaming
		? SENSOR_TEMP_BASE_STREAMING_C
		: SENSOR_TEMP_BASE_IDLE_C;
	mockState.sensors.socTemp =
		baseTemp + (Math.random() - 0.5) * SENSOR_TEMP_FLUCTUATION_C;
	mockState.sensors.socVoltage =
		SENSOR_VOLTAGE_BASE_V + Math.random() * SENSOR_VOLTAGE_RANGE_V;
	mockState.sensors.socCurrent = config.streaming
		? SENSOR_CURRENT_STREAMING_A +
			Math.random() * SENSOR_CURRENT_STREAMING_RANGE_A
		: SENSOR_CURRENT_IDLE_A + Math.random() * SENSOR_CURRENT_IDLE_RANGE_A;

	// Update streaming stats
	if (config.streaming && mockState.streaming.isActive) {
		mockState.streaming.bitrate =
			BITRATE_MIN_KBPS + Math.random() * (BITRATE_MAX_KBPS - BITRATE_MIN_KBPS);
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
	const config = getScenarioConfig();
	if (isActive) {
		mockState.streaming.connectedRelays = config.modems;
	} else {
		mockState.streaming.connectedRelays = 0;
	}
}

function deriveMockHealth(): MockHealthState {
	const { streaming } = mockState;
	const linkCount = getScenarioConfig().modems;
	const activeLinks = streaming.isActive
		? Math.min(streaming.connectedRelays, linkCount)
		: 0;
	return {
		processAlive: streaming.isActive,
		framesAdvancing: streaming.isActive,
		frameCount: 0,
		reconnecting: false,
		reconnectCount: 0,
		linkCount,
		activeLinks,
	};
}

export function getMockHealth(): Readonly<MockHealthState> {
	const derived = deriveMockHealth();
	const override = mockState.mockHealthOverride;
	return override ? { ...derived, ...override } : derived;
}

export function setMockHealth(update: Partial<MockHealthState>): void {
	updateMockState({
		mockHealthOverride: { ...(mockState.mockHealthOverride ?? {}), ...update },
	});
}

export function setMockStreamError(event: MockStreamErrorState): void {
	updateMockState({ injectedStreamError: event });
}

function clearMockTimers(): void {
	if (updateInterval) {
		clearInterval(updateInterval);
		updateInterval = null;
	}
	if (relayPopulateTimeout) {
		clearTimeout(relayPopulateTimeout);
		relayPopulateTimeout = null;
	}
	if (rttBroadcastInterval) {
		clearInterval(rttBroadcastInterval);
		rttBroadcastInterval = null;
	}
}

/**
 * Stop the mock service
 */
export function stopMockService(): void {
	clearMockTimers();
	setRelaysCacheMock(undefined);
	mockState.initialized = false;
	logger.info("🎭 Mock service stopped");
}

/**
 * Single typed entry point for every write to `mockState` (see the lifecycle
 * note at the top of the file). Merges the provided top-level slices into the
 * mutable state object; the named setters below are thin wrappers over this.
 */
export function updateMockState(partial: Partial<MockState>): void {
	Object.assign(mockState, partial);
}

/**
 * Restore the active scenario's pristine seeded state and clear every running
 * timer. Side-effect-clean (no broadcasts, no new timers) so unit tests get
 * per-test isolation without leaking intervals. No-op until initMockService has
 * captured a snapshot.
 */
export function resetMockState(): void {
	clearMockTimers();
	resetMockKioskState();
	if (!pristineSnapshot) return;
	Object.assign(mockState, structuredClone(pristineSnapshot));
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
	const current = mockState.wifiConnections.get(deviceId) ?? {
		savedNetworks: [],
	};
	const wifiConnections = new Map(mockState.wifiConnections);
	wifiConnections.set(deviceId, { ...current, ...update });
	updateMockState({ wifiConnections });
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
	const modemConfigs = new Map(mockState.modemConfigs);
	modemConfigs.set(modemId, { ...current, ...update });
	updateMockState({ modemConfigs });
}

export function setMockNetifConfig(
	ifName: string,
	update: Partial<MockNetifConfigState>,
): void {
	const current = mockState.netifConfigs.get(ifName) ?? {
		enabled: true,
		dhcp: true,
	};
	const netifConfigs = new Map(mockState.netifConfigs);
	netifConfigs.set(ifName, { ...current, ...update });
	updateMockState({ netifConfigs });
}

export function setMockEncoderConfig(
	update: Partial<MockEncoderConfigState>,
): void {
	updateMockState({
		mockEncoderConfig: { ...mockState.mockEncoderConfig, ...update },
	});
}

export function setMockSimState(
	modemId: string,
	update: Partial<MockSimState>,
): void {
	const current = mockState.simStates.get(modemId) ?? buildMockSimState();
	const simStates = new Map(mockState.simStates);
	simStates.set(modemId, { ...current, ...update });
	updateMockState({ simStates });
}

export function setMockSimPinSecret(pin: string | null): void {
	updateMockState({ simPinSecret: pin });
}

export function getMockAddons(): Readonly<AddonConfig> {
	return mockState.mockAddons;
}

export function setMockAddonState(id: string, state: AddonState): void {
	updateMockState({ mockAddons: { ...mockState.mockAddons, [id]: state } });
}

export function removeMockAddonState(id: string): void {
	const mockAddons = { ...mockState.mockAddons };
	delete mockAddons[id];
	updateMockState({ mockAddons });
}

// Re-export commonly used functions
export {
	getActiveScenario,
	getScenarioConfig,
	isDevelopment,
	mockModems,
	mockWifiNetworks,
	mockWifiRadios,
};
