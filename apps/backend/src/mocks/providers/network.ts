/*
	CeraUI - Network Interface Mock Provider
	Simulates ifconfig output for development mode
*/

import {
	getMockState,
	getScenarioConfig,
	mockModems,
	mockWifiRadios,
	shouldUseMocks,
} from "../mock-service.ts";

const resolveNetifIp = (name: string, fallback: string): string =>
	getMockState().netifConfigs.get(name)?.ip ?? fallback;

// network-interfaces.ts derives `tp = txBytes - prevTxBytes` each ~1s ifconfig
// poll, so these cumulative counters must advance by interfaceThroughput[name]
// bytes per tick for `tp` to track the seeded per-link rate. A disabled link
// advances by 0, collapsing its `tp` to 0 instead of a stale positive value.
const txByteCounters = new Map<string, number>();

const THROUGHPUT_FLUCTUATION = 0.15;

function advanceInterfaceTraffic(
	name: string,
	rxRatio: number,
): { txBytes: number; rxBytes: number } {
	const state = getMockState();
	const enabled = state.netifConfigs.get(name)?.enabled ?? true;
	const baseRate = state.interfaceThroughput[name] ?? 0;
	const increment = enabled
		? baseRate * (1 + (Math.random() - 0.5) * 2 * THROUGHPUT_FLUCTUATION)
		: 0;

	const previous = txByteCounters.get(name) ?? 0;
	const txBytes = Math.floor(previous + increment);
	txByteCounters.set(name, txBytes);

	return { txBytes, rxBytes: Math.floor(txBytes * rxRatio) };
}

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
	const eth0Traffic = advanceInterfaceTraffic("eth0", 2);
	interfaces.push(
		generateInterfaceBlock("eth0", {
			ip: resolveNetifIp("eth0", "192.168.1.100"),
			netmask: "255.255.255.0",
			broadcast: "192.168.1.255",
			mac: "dc:a6:32:12:34:56",
			txBytes: eth0Traffic.txBytes,
			rxBytes: eth0Traffic.rxBytes,
			mtu: 1500,
		}),
	);

	// Add modem interfaces
	for (let i = 0; i < config.modems; i++) {
		const modem = mockModems[i];
		if (!modem) continue;

		const modemTraffic = advanceInterfaceTraffic(modem.interfaceName, 1.5);
		interfaces.push(
			generateInterfaceBlock(modem.interfaceName, {
				ip: resolveNetifIp(modem.interfaceName, modem.ip),
				netmask: "255.255.255.0",
				broadcast: `10.0.${i}.255`,
				mac: `00:1e:10:1f:${String(i).padStart(2, "0")}:01`,
				txBytes: modemTraffic.txBytes,
				rxBytes: modemTraffic.rxBytes,
				mtu: 1500,
			}),
		);
	}

	if (config.wifi) {
		mockWifiRadios.forEach((radio, index) => {
			const wifiTraffic = advanceInterfaceTraffic(radio.ifname, 1.8);
			interfaces.push(
				generateInterfaceBlock(radio.ifname, {
					ip: resolveNetifIp(radio.ifname, `192.168.2.${100 + index}`),
					netmask: "255.255.255.0",
					broadcast: "192.168.2.255",
					mac: radio.macAddress,
					txBytes: wifiTraffic.txBytes,
					rxBytes: wifiTraffic.rxBytes,
					mtu: 1500,
				}),
			);
		});
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
