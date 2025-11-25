/*
	CeraUI - Modem Mock Provider
	Simulates mmcli (ModemManager) output for development mode
*/

import {
	getModemSignal,
	getModemState,
	getScenarioConfig,
	mockModems,
	shouldUseMocks,
} from "../mock-service.ts";

/**
 * Parse mmcli command arguments and return appropriate mock response
 */
export function handleMmcliCommand(args: string[]): string | null {
	if (!shouldUseMocks()) {
		return null;
	}

	// mmcli -K -L (list modems)
	if (args.includes("-L")) {
		return getMockModemList();
	}

	// mmcli -K -m <id> (get modem info)
	const modemIndex = args.indexOf("-m");
	if (modemIndex !== -1 && args[modemIndex + 1]) {
		const modemId = Number.parseInt(args[modemIndex + 1], 10);

		// Check for 3gpp-scan flag
		if (args.includes("--3gpp-scan")) {
			return getMockNetworkScan(modemId);
		}

		return getMockModemInfo(modemId);
	}

	// mmcli -K -i <id> (get SIM info)
	const simIndex = args.indexOf("-i");
	if (simIndex !== -1 && args[simIndex + 1]) {
		const simId = Number.parseInt(args[simIndex + 1], 10);
		return getMockSimInfo(simId);
	}

	return null;
}

/**
 * Generate mock modem list output
 */
function getMockModemList(): string {
	const config = getScenarioConfig();
	const lines: string[] = [];

	lines.push(`modem-list.length: ${config.modems}`);

	for (let i = 0; i < config.modems; i++) {
		lines.push(
			`modem-list.value[${i}]: /org/freedesktop/ModemManager1/Modem/${i}`,
		);
	}

	return lines.join("\n");
}

/**
 * Generate mock modem info output
 */
function getMockModemInfo(modemId: number): string {
	const config = getScenarioConfig();

	if (modemId >= config.modems) {
		return "";
	}

	const modem = mockModems[modemId];
	if (!modem) {
		return "";
	}

	const signal = Math.round(getModemSignal(modemId));
	const state = getModemState(modemId);
	const accessTech = modem.networkType === "5G" ? "5gnr" : "lte";

	const lines: string[] = [
		`modem.dbus-path: /org/freedesktop/ModemManager1/Modem/${modemId}`,
		`modem.generic.device-identifier: ${modem.imei.slice(0, 8)}`,
		`modem.generic.manufacturer: ${modem.manufacturer}`,
		`modem.generic.model: ${modem.model}`,
		`modem.generic.revision: ${modem.networkType === "5G" ? "RM520NGLAAR01A07M4G" : "SWI9X30C_02.33.03.00"}`,
		`modem.generic.carrier-configuration: default`,
		`modem.generic.carrier-configuration-revision: --`,
		`modem.generic.hardware-revision: --`,
		`modem.generic.equipment-identifier: ${modem.imei}`,
		`modem.generic.device: /sys/devices/platform/usb/usb${modemId + 1}`,
		`modem.generic.drivers.length: 2`,
		`modem.generic.drivers.value[0]: qmi_wwan`,
		`modem.generic.drivers.value[1]: option`,
		`modem.generic.plugin: ${modem.manufacturer}`,
		`modem.generic.primary-port: cdc-wdm${modemId}`,
		`modem.generic.ports.length: 4`,
		`modem.generic.ports.value[0]: cdc-wdm${modemId} (qmi)`,
		`modem.generic.ports.value[1]: ttyUSB${modemId * 3} (at)`,
		`modem.generic.ports.value[2]: ttyUSB${modemId * 3 + 1} (at)`,
		`modem.generic.ports.value[3]: ${modem.interfaceName} (net)`,
		`modem.generic.state: ${state}`,
		`modem.generic.state-failed-reason: --`,
		`modem.generic.power-state: on`,
		`modem.generic.access-technologies.length: 1`,
		`modem.generic.access-technologies.value[0]: ${accessTech}`,
		`modem.generic.signal-quality.value: ${signal}`,
		`modem.generic.signal-quality.recent: yes`,
		`modem.generic.supported-modes.length: 3`,
		`modem.generic.supported-modes.value[0]: allowed: 4g; preferred: none`,
		`modem.generic.supported-modes.value[1]: allowed: 4g, 5g; preferred: 5g`,
		`modem.generic.supported-modes.value[2]: allowed: 5g; preferred: none`,
		`modem.generic.current-modes: allowed: 4g, 5g; preferred: 5g`,
		`modem.generic.supported-bands.length: 20`,
		`modem.generic.current-bands.length: 15`,
		`modem.generic.supported-ip-families: ipv4, ipv6, ipv4v6`,
		`modem.generic.sim: /org/freedesktop/ModemManager1/SIM/${modemId}`,
		`modem.generic.sim-slots.length: 1`,
		`modem.generic.sim-slots.value[0]: /org/freedesktop/ModemManager1/SIM/${modemId}`,
		`modem.generic.primary-sim-slot: 1`,
		`modem.3gpp.imei: ${modem.imei}`,
		`modem.3gpp.registration-state: ${state === "connected" ? "home" : state === "registered" ? "roaming" : "searching"}`,
		`modem.3gpp.operator-code: ${modem.operatorCode}`,
		`modem.3gpp.operator-name: ${modem.carrier}`,
		`modem.3gpp.packet-service-state: attached`,
		`modem.3gpp.eps-ue-mode-operation: csps-2`,
		`modem.3gpp.pco: --`,
	];

	return lines.join("\n");
}

/**
 * Generate mock SIM info output
 */
function getMockSimInfo(simId: number): string {
	const config = getScenarioConfig();

	if (simId >= config.modems) {
		return "";
	}

	const modem = mockModems[simId];
	if (!modem) {
		return "";
	}

	const lines: string[] = [
		`sim.dbus-path: /org/freedesktop/ModemManager1/SIM/${simId}`,
		`sim.properties.active: yes`,
		`sim.properties.iccid: ${modem.iccid}`,
		`sim.properties.imsi: ${modem.iccid.slice(0, 15)}`,
		`sim.properties.eid: --`,
		`sim.properties.operator-code: ${modem.operatorCode}`,
		`sim.properties.operator-name: ${modem.carrier}`,
		`sim.properties.emergency-numbers.length: 3`,
		`sim.properties.emergency-numbers.value[0]: 911`,
		`sim.properties.emergency-numbers.value[1]: 112`,
		`sim.properties.emergency-numbers.value[2]: 000`,
		`sim.properties.preferred-networks.length: 0`,
	];

	return lines.join("\n");
}

/**
 * Generate mock network scan results
 */
function getMockNetworkScan(modemId: number): string {
	const config = getScenarioConfig();

	if (modemId >= config.modems) {
		return "";
	}

	const modem = mockModems[modemId];
	if (!modem) {
		return "";
	}

	// Generate some available networks
	const networks = [
		{ code: modem.operatorCode, name: modem.carrier, status: "current" },
		{ code: "310260", name: "T-Mobile", status: "available" },
		{ code: "310410", name: "AT&T", status: "available" },
		{ code: "311480", name: "Verizon", status: "available" },
	];

	const lines: string[] = [
		`modem.3gpp.scan-networks.length: ${networks.length}`,
	];

	for (let i = 0; i < networks.length; i++) {
		const net = networks[i];
		lines.push(
			`modem.3gpp.scan-networks.value[${i}]: operator-code: ${net?.code}, operator-name: ${net?.name}, availability: ${net?.status}`,
		);
	}

	return lines.join("\n");
}

/**
 * Check if we should mock modem commands
 */
export function shouldMockModems(): boolean {
	return shouldUseMocks();
}
