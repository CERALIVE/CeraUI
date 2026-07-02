/*
	CeraUI - Mock Configuration
	Defines scenarios and mock state for development mode
*/

// Type-only import on purpose: mock-schemas imports these fixtures at runtime,
// so a value import here would create a module cycle. `satisfies` below turns
// fixture/schema drift into a compile error.
import type {
	MockModemConfig,
	MockWifiNetwork,
	MockWifiRadio,
} from "./mock-schemas.ts";

export type { MockModemConfig, MockWifiNetwork, MockWifiRadio };

export type MockScenario =
	| "single-modem"
	| "multi-modem-wifi"
	| "streaming-active"
	| "caps-full"
	| "engine-starting"
	| "engine-unavailable";

// Per-scenario engine-capability profile read by getMockEngineCapabilities().
// Absent → provider keeps the default snapshot (MINIMAL_SAFE + ["srtla","rist"]).
export interface ScenarioCapabilities {
	// throws on fetch → getCapabilities() minimal floor + engineStarting flag
	engineStarting?: boolean;
	// throws on fetch → getCapabilities() serves cached/minimal + engineUnavailable
	engineUnavailable?: boolean;
	// sole gate for live-audio UI
	audioLiveSwitch?: boolean;
	// H265 + hw accel + audio-capable HDMI source, vs the TestPattern-only floor
	fullProfile?: boolean;
	// relay transports advertised (merged onto the srtla base)
	transports?: readonly string[];
	// forces a schema_version skew → schemaVersionMismatch flag (test seam only)
	schemaVersionMismatch?: boolean;
}

export interface ScenarioConfig {
	modems: number;
	wifi: boolean;
	streaming: boolean;
	description: string;
	capabilities?: ScenarioCapabilities;
}

export const scenarios: Record<MockScenario, ScenarioConfig> = {
	"single-modem": {
		modems: 1,
		wifi: false,
		streaming: false,
		description: "Single LTE modem, no WiFi, idle state",
	},
	"multi-modem-wifi": {
		modems: 3,
		wifi: true,
		streaming: false,
		description: "3 modems (4G/5G mix), WiFi with hotspot capability",
		// Dev default resolves the FULL engine profile (H265 + hw accel +
		// audio-capable HDMI source) so the Live UI exercises every capability-gated
		// control out of the box. engine-starting / engine-unavailable keep the floor.
		capabilities: { fullProfile: true },
	},
	"streaming-active": {
		modems: 2,
		wifi: true,
		streaming: true,
		description: "2 modems bonding, active stream with real-time stats",
		// Active-stream dev scenario also runs the full engine profile; the resolved
		// runtime encode is surfaced via getMockActiveEncode() (providers/streaming.ts).
		capabilities: { fullProfile: true },
	},
	"caps-full": {
		modems: 2,
		wifi: true,
		streaming: false,
		description:
			"Full engine caps: H265 + hardware accel, audio-capable source, live audio switch, SRT transport (idle)",
		capabilities: {
			fullProfile: true,
			audioLiveSwitch: true,
			transports: ["srtla", "srt"],
		},
	},
	"engine-starting": {
		modems: 1,
		wifi: false,
		streaming: false,
		description: "Engine still booting — minimal safe floor + engineStarting",
		capabilities: { engineStarting: true },
	},
	"engine-unavailable": {
		modems: 1,
		wifi: false,
		streaming: false,
		description:
			"Engine unreachable — cached/minimal snapshot + engineUnavailable",
		capabilities: { engineUnavailable: true },
	},
};

// Mock modem definitions
export const mockModems = [
	{
		id: 0,
		model: "RM520N-GL",
		manufacturer: "Quectel",
		imei: "867034057012345",
		iccid: "89014103211118510720",
		carrier: "T-Mobile",
		operatorCode: "310260",
		network_type: {
			supported: ["5g", "4g", "3g"],
			active: "5g",
		},
		interfaceName: "usb0",
		ip: "10.0.0.2",
	},
	{
		id: 1,
		model: "EM7455",
		manufacturer: "Sierra Wireless",
		imei: "359072060123456",
		iccid: "89012104111118512345",
		carrier: "AT&T",
		operatorCode: "310410",
		network_type: {
			supported: ["4g"],
			active: "4g",
		},
		interfaceName: "usb1",
		ip: "10.0.1.2",
	},
	{
		id: 2,
		model: "RM500Q-GL",
		manufacturer: "Quectel",
		imei: "867034058098765",
		iccid: "89011202212312345678",
		carrier: "Verizon",
		operatorCode: "311480",
		network_type: {
			supported: ["5g", "4g"],
			active: "5g",
		},
		interfaceName: "usb2",
		ip: "10.0.2.2",
	},
] satisfies MockModemConfig[];

// Mock WiFi radios
export const mockWifiRadios = [
	{
		device: "wlan0",
		ifname: "wlan0",
		macAddress: "dc:a6:32:12:34:57",
		supports_hotspot: true,
	},
	{
		device: "wlan1",
		ifname: "wlan1",
		macAddress: "dc:a6:32:12:34:58",
		supports_hotspot: true,
	},
] satisfies MockWifiRadio[];

// Mock WiFi networks
export const mockWifiNetworks = [
	{
		ssid: "HomeNetwork",
		bssid: "AA:BB:CC:DD:EE:01",
		signal: 92,
		frequency: 5180,
		security: "WPA2-Personal",
		active: true,
	},
	{
		ssid: "CoffeeShop_5G",
		bssid: "AA:BB:CC:DD:EE:02",
		signal: 68,
		frequency: 5240,
		security: "WPA2",
		active: false,
	},
	{
		ssid: "PublicWifi",
		bssid: "AA:BB:CC:DD:EE:03",
		signal: 45,
		frequency: 2437,
		security: "Open",
		active: false,
	},
	{
		ssid: "Neighbor_5G",
		bssid: "AA:BB:CC:DD:EE:04",
		signal: 35,
		frequency: 5500,
		security: "WPA3",
		active: false,
	},
	{
		ssid: "Guest_Network",
		bssid: "AA:BB:CC:DD:EE:05",
		signal: 72,
		frequency: 2462,
		security: "WPA2-Personal",
		active: false,
	},
	{
		ssid: "Office_Secure",
		bssid: "AA:BB:CC:DD:EE:06",
		signal: 88,
		frequency: 5180,
		security: "WPA2-Enterprise",
		active: false,
	},
	{
		ssid: "IoT_Network",
		bssid: "AA:BB:CC:DD:EE:07",
		signal: 55,
		frequency: 2437,
		security: "WPA2",
		active: false,
	},
	{
		ssid: "FreeWifi_Airport",
		bssid: "AA:BB:CC:DD:EE:08",
		signal: 28,
		frequency: 2412,
		security: "Open",
		active: false,
	},
	{
		ssid: "StreamingStudio",
		bssid: "AA:BB:CC:DD:EE:09",
		signal: 95,
		frequency: 5745,
		security: "WPA3-Personal",
		active: false,
	},
	{
		ssid: "Mobile_Hotspot",
		bssid: "AA:BB:CC:DD:EE:0A",
		signal: 78,
		frequency: 5200,
		security: "WPA2",
		active: false,
	},
] satisfies MockWifiNetwork[];

// Pairing fields seeded into the device config under shouldUseMocks() (wired in
// modules/config.ts loadConfig) so isPairedToManagedCloud() reads "paired" in
// dev/e2e and the managed destination enables — matching the `ceralive`
// provider metadata the mock relay catalog (providers/relays.ts) already
// carries. Never applied in production (shouldUseMocks() is false on real
// devices).
export const MOCK_CONFIG_PAIRING_DEFAULTS = {
	remote_key: "mock-pairing-key",
	remote_provider: "ceralive",
} as const;

// Active scenario state
let activeScenario: MockScenario = "multi-modem-wifi";

export function getActiveScenario(): MockScenario {
	return activeScenario;
}

export function setActiveScenario(scenario: MockScenario): void {
	if (scenarios[scenario]) {
		activeScenario = scenario;
	}
}

export function getScenarioConfig(): ScenarioConfig {
	return scenarios[activeScenario];
}

export function isDevelopment(): boolean {
	return (
		process.env.NODE_ENV === "development" || process.env.MOCK_MODE === "true"
	);
}
