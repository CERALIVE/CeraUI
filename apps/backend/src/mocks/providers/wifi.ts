/*
	CeraUI - WiFi Mock Provider
	Simulates nmcli WiFi commands for development mode
*/

import {
	getScenarioConfig,
	getWifiSignal,
	mockWifiNetworks,
	shouldUseMocks,
} from "../mock-service.ts";

// Mock saved WiFi connections
const mockSavedConnections = [
	{
		uuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
		name: "HomeNetwork",
		type: "802-11-wireless",
		device: "wlan0",
		macAddress: "dc:a6:32:12:34:57",
	},
];

// Mock hotspot connection
const mockHotspotConnection = {
	uuid: "hotspot-1234-5678-9012-abcdef123456",
	name: "CeraLive-Hotspot",
	password: "ceralive123",
	channel: 36,
};

/**
 * Handle nmcli commands and return mock responses
 */
export function handleNmcliCommand(args: string[]): string | null {
	if (!shouldUseMocks()) {
		return null;
	}

	const config = getScenarioConfig();
	if (!config.wifi) {
		return null;
	}

	const argsStr = args.join(" ");

	// nmcli --terse --fields <fields> connection show
	if (argsStr.includes("connection") && argsStr.includes("show")) {
		return getMockConnections(args);
	}

	// nmcli --terse --fields <fields> device status
	if (argsStr.includes("device") && argsStr.includes("status")) {
		return getMockDeviceStatus();
	}

	// nmcli device wifi list
	if (
		argsStr.includes("device") &&
		argsStr.includes("wifi") &&
		argsStr.includes("list")
	) {
		return getMockWifiList();
	}

	// nmcli device wifi rescan
	if (
		argsStr.includes("device") &&
		argsStr.includes("wifi") &&
		argsStr.includes("rescan")
	) {
		return ""; // Success (empty output)
	}

	// nmcli --get-values ... connection show <uuid>
	if (
		argsStr.includes("--get-values") &&
		argsStr.includes("connection") &&
		argsStr.includes("show")
	) {
		return getMockConnectionFields(args);
	}

	return null;
}

/**
 * Generate mock connection list
 */
function getMockConnections(args: string[]): string {
	const config = getScenarioConfig();
	const fieldsIndex = args.indexOf("--fields");
	const fields = fieldsIndex !== -1 ? args[fieldsIndex + 1] : "uuid,type";
	const fieldList = fields?.split(",") ?? ["uuid", "type"];

	const connections: string[] = [];

	// Only add WiFi connections if wifi is enabled in scenario
	if (config.wifi) {
		// Add saved WiFi connections
		for (const conn of mockSavedConnections) {
			const values = fieldList.map((f) => {
				switch (f.trim()) {
					case "uuid":
						return conn.uuid;
					case "type":
						return conn.type;
					case "name":
						return conn.name;
					case "timestamp":
						return "1700000000";
					default:
						return "mock";
				}
			});
			connections.push(values.join(":"));
		}

		// Add hotspot connection
		const hotspotValues = fieldList.map((f) => {
			switch (f.trim()) {
				case "uuid":
					return mockHotspotConnection.uuid;
				case "type":
					return "802-11-wireless";
				case "name":
					return mockHotspotConnection.name;
				case "timestamp":
					return "1700000001";
				default:
					return "mock";
			}
		});
		connections.push(hotspotValues.join(":"));
	}

	// Add empty line at the end (nmcli output typically ends with newline)
	connections.push("");

	return connections.join("\n");
}

/**
 * Generate mock device status
 */
function getMockDeviceStatus(): string {
	const config = getScenarioConfig();
	const devices: string[] = [];

	// Ethernet
	devices.push("eth0:ethernet:connected:Wired connection 1");

	// WiFi (if enabled)
	if (config.wifi) {
		devices.push("wlan0:wifi:connected:HomeNetwork");
	}

	// Modems
	for (let i = 0; i < config.modems; i++) {
		devices.push(`usb${i}:gsm:connected:gsm-connection-${i}`);
	}

	return devices.join("\n");
}

/**
 * Generate mock WiFi network list
 */
function getMockWifiList(): string {
	const networks: string[] = [];

	for (const network of mockWifiNetworks) {
		const signal = Math.round(getWifiSignal(network.ssid));
		const active = network.active ? "*" : "";
		// Format: IN-USE:BSSID:SSID:MODE:CHAN:RATE:SIGNAL:BARS:SECURITY
		const chan =
			network.frequency > 5000
				? Math.floor((network.frequency - 5000) / 5) + 36
				: Math.floor((network.frequency - 2407) / 5);
		networks.push(
			`${active}:${network.bssid}:${network.ssid}:Infra:${chan}:540 Mbit/s:${signal}:▂▄▆█:${network.security}`,
		);
	}

	return networks.join("\n");
}

/**
 * Generate mock connection field values
 */
function getMockConnectionFields(args: string[]): string {
	const getValuesIndex = args.indexOf("--get-values");
	const fields = getValuesIndex !== -1 ? args[getValuesIndex + 1] : "";
	const fieldList = fields?.split(",") ?? [];

	// Find the UUID (last argument usually)
	const uuid = args[args.length - 1];

	// Helper to get field value with proper defaults
	const getFieldValue = (
		field: string,
		conn: {
			mode: string;
			ssid: string;
			macAddress: string;
			channel?: number;
		},
	): string => {
		switch (field.trim()) {
			case "802-11-wireless.mode":
				return conn.mode;
			case "802-11-wireless.ssid":
				return conn.ssid;
			case "802-11-wireless.mac-address":
				return conn.macAddress;
			case "802-11-wireless.channel":
				return conn.channel ? String(conn.channel) : "36";
			case "GENERAL.STATE":
				return "activated";
			default:
				return "mock-value";
		}
	};

	// Check if it's the hotspot
	if (uuid === mockHotspotConnection.uuid) {
		return fieldList
			.map((f) =>
				getFieldValue(f, {
					mode: "ap",
					ssid: mockHotspotConnection.name,
					macAddress: "dc:a6:32:12:34:57",
					channel: mockHotspotConnection.channel,
				}),
			)
			.join("\n");
	}

	// Check saved connections
	const savedConn = mockSavedConnections.find((c) => c.uuid === uuid);
	if (savedConn) {
		return fieldList
			.map((f) =>
				getFieldValue(f, {
					mode: "infrastructure",
					ssid: savedConn.name,
					macAddress: savedConn.macAddress,
				}),
			)
			.join("\n");
	}

	// For any other connection (like modem connections or dynamically created ones)
	// Return values that won't cause errors but indicate it's not a wifi connection
	return fieldList
		.map((f) =>
			getFieldValue(f, {
				mode: "infrastructure",
				ssid: `mock-${uuid?.slice(0, 8) || "unknown"}`,
				macAddress: "00:00:00:00:00:00",
			}),
		)
		.join("\n");
}

/**
 * Get mock hotspot channels
 */
export function getMockHotspotChannels(): number[] {
	// Return common 5GHz channels
	return [36, 40, 44, 48, 149, 153, 157, 161];
}

/**
 * Check if we should mock WiFi commands
 * Note: This returns true in development mode even if wifi is disabled in scenario,
 * because nmcli is also used for modem connections
 */
export function shouldMockWifi(): boolean {
	return shouldUseMocks();
}

/**
 * Get mock WiFi interface info
 */
export function getMockWifiInterface() {
	if (!shouldMockWifi()) {
		return null;
	}

	return {
		ifname: "wlan0",
		macAddress: "dc:a6:32:12:34:57",
		ip: "192.168.2.100",
		supportsHotspot: true,
	};
}
