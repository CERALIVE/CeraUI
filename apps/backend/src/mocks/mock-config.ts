/*
	CeraUI - Mock Configuration
	Defines scenarios and mock state for development mode
*/

export type MockScenario = "single-modem" | "multi-modem-wifi" | "streaming-active";

export interface ScenarioConfig {
	modems: number;
	wifi: boolean;
	streaming: boolean;
	description: string;
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
	},
	"streaming-active": {
		modems: 2,
		wifi: true,
		streaming: true,
		description: "2 modems bonding, active stream with real-time stats",
	},
};

// Mock modem definitions
export interface MockModemConfig {
	id: number;
	model: string;
	manufacturer: string;
	imei: string;
	iccid: string;
	carrier: string;
	operatorCode: string;
	networkType: "4G" | "5G";
	interfaceName: string;
	ip: string;
}

export const mockModems: MockModemConfig[] = [
	{
		id: 0,
		model: "RM520N-GL",
		manufacturer: "Quectel",
		imei: "867034057012345",
		iccid: "89014103211118510720",
		carrier: "T-Mobile",
		operatorCode: "310260",
		networkType: "5G",
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
		networkType: "4G",
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
		networkType: "5G",
		interfaceName: "usb2",
		ip: "10.0.2.2",
	},
];

// Mock WiFi networks
export interface MockWifiNetwork {
	ssid: string;
	bssid: string;
	signal: number;
	frequency: number;
	security: string;
	active: boolean;
}

export const mockWifiNetworks: MockWifiNetwork[] = [
	{
		ssid: "HomeNetwork",
		bssid: "AA:BB:CC:DD:EE:01",
		signal: 85,
		frequency: 5180,
		security: "WPA2",
		active: false,
	},
	{
		ssid: "CoffeeShop_5G",
		bssid: "AA:BB:CC:DD:EE:02",
		signal: 62,
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
];

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
	return process.env.NODE_ENV === "development" || process.env.MOCK_MODE === "true";
}

