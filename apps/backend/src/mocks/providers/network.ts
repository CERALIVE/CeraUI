/*
	CeraUI - Network Interface Mock Provider
	Simulates ifconfig output for development mode
*/

import {
	getNetworkTraffic,
	getScenarioConfig,
	mockModems,
	shouldUseMocks,
} from "../mock-service.ts";

/**
 * Generate mock ifconfig output based on current scenario
 */
export function getMockIfconfigOutput(): string {
	if (!shouldUseMocks()) {
		return "";
	}

	const config = getScenarioConfig();
	const interfaces: string[] = [];

	// Always include eth0 (ethernet)
	interfaces.push(
		generateInterfaceBlock("eth0", {
			ip: "192.168.1.100",
			netmask: "255.255.255.0",
			broadcast: "192.168.1.255",
			mac: "dc:a6:32:12:34:56",
			txBytes: getNetworkTraffic("eth0"),
			rxBytes: getNetworkTraffic("eth0") * 2,
			mtu: 1500,
		}),
	);

	// Add modem interfaces
	for (let i = 0; i < config.modems; i++) {
		const modem = mockModems[i];
		if (!modem) continue;

		interfaces.push(
			generateInterfaceBlock(modem.interfaceName, {
				ip: modem.ip,
				netmask: "255.255.255.0",
				broadcast: `10.0.${i}.255`,
				mac: `00:1e:10:1f:${String(i).padStart(2, "0")}:01`,
				txBytes: getNetworkTraffic(modem.interfaceName),
				rxBytes: getNetworkTraffic(modem.interfaceName) * 1.5,
				mtu: 1500,
			}),
		);
	}

	// Add wlan0 if WiFi is enabled
	if (config.wifi) {
		interfaces.push(
			generateInterfaceBlock("wlan0", {
				ip: "192.168.2.100",
				netmask: "255.255.255.0",
				broadcast: "192.168.2.255",
				mac: "dc:a6:32:12:34:57",
				txBytes: getNetworkTraffic("wlan0"),
				rxBytes: getNetworkTraffic("wlan0") * 1.8,
				mtu: 1500,
			}),
		);
	}

	// Add loopback (always present but filtered out by the parser)
	interfaces.push(
		generateInterfaceBlock("lo", {
			ip: "127.0.0.1",
			netmask: "255.0.0.0",
			txBytes: 12345678,
			rxBytes: 12345678,
			mtu: 65536,
			isLoopback: true,
		}),
	);

	return interfaces.join("\n\n");
}

interface InterfaceConfig {
	ip: string;
	netmask: string;
	broadcast?: string;
	mac?: string;
	txBytes: number;
	rxBytes: number;
	mtu: number;
	isLoopback?: boolean;
}

/**
 * Generate a single interface block in ifconfig format
 */
function generateInterfaceBlock(name: string, config: InterfaceConfig): string {
	const flags = config.isLoopback
		? "LOOPBACK,RUNNING"
		: "UP,BROADCAST,RUNNING,MULTICAST";

	const flagsNum = config.isLoopback ? 73 : 4163;

	const txPackets = Math.floor(config.txBytes / 1000);
	const rxPackets = Math.floor(config.rxBytes / 1000);

	let block = `${name}: flags=${flagsNum}<${flags}>  mtu ${config.mtu}\n`;
	block += `        inet ${config.ip}  netmask ${config.netmask}`;

	if (config.broadcast) {
		block += `  broadcast ${config.broadcast}`;
	}
	block += "\n";

	if (config.mac) {
		block += `        ether ${config.mac}  txqueuelen 1000  (Ethernet)\n`;
	}

	block += `        RX packets ${rxPackets}  bytes ${config.rxBytes} (${formatBytes(config.rxBytes)})\n`;
	block += `        RX errors 0  dropped 0  overruns 0  frame 0\n`;
	block += `        TX packets ${txPackets}  bytes ${config.txBytes} (${formatBytes(config.txBytes)})\n`;
	block += `        TX errors 0  dropped 0 overruns 0  carrier 0  collisions 0`;

	return block;
}

/**
 * Format bytes to human-readable string (ifconfig style)
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

/**
 * Check if we should use mock network data
 */
export function shouldMockNetwork(): boolean {
	return shouldUseMocks();
}
