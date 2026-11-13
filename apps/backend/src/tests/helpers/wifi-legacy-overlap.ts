import { jest, spyOn } from "bun:test";

export async function legacyOverlapTranscript(errors = false) {
	// Keep importing this test helper independent of application bootstrap.
	const runner = await import("../../helpers/run.ts");
	const nm = await import("../../modules/network/network-manager.ts");
	const { resetWifiCapabilitiesForTest, setWifiCapabilityDepsForTest } =
		await import("../../modules/wifi/wifi-capabilities.ts");
	const {
		clearWifiInterfacesForTest,
		getWifiInterfacesByMacAddress,
		wifiCancelScanRefresh,
		wifiStateInit,
	} = await import("../../modules/wifi/wifi-connections.ts");
	const { resetHotspotClientsForTest } = await import(
		"../../modules/wifi/wifi-hotspot-clients.ts"
	);
	const {
		resetWifiInterfaceDiscoveryForTest,
		stopWifiUpdateLoopForTest,
		wifiUpdateDevices,
	} = await import("../../modules/wifi/wifi-interfaces.ts");
	const compat = await import("../../rpc/compat.ts");
	jest.useFakeTimers();
	jest.setSystemTime(0);
	clearWifiInterfacesForTest();
	resetWifiInterfaceDiscoveryForTest();
	setWifiCapabilityDepsForTest({
		runIw: async () => "",
		readPhyName: async () => undefined,
		pathExists: async () => false,
		readNmcliWifiProperties: async () => new Map(),
		now: () => 0,
	});
	const gates = Array.from({ length: 2 }, () =>
		Promise.withResolvers<string[]>(),
	);
	const unexpected: string[] = [];
	const command = spyOn(runner, "run").mockImplementation(async (bin, args) => {
		unexpected.push(`${bin} ${args.join(" ")}`);
		throw new Error("Unfaked overlap command");
	});
	let reads = 0;
	const devices = spyOn(nm, "nmDevices").mockImplementation(() => {
		const gate = gates[reads++];
		if (!gate) throw new Error("Unexpected extra legacy read");
		return gate.promise;
	});
	const profiles = spyOn(nm, "nmConnsGet").mockResolvedValue([""]);
	const scan = spyOn(nm, "nmScanResults").mockResolvedValue([""]);
	let broadcasts = 0;
	const sink = spyOn(compat, "broadcastMsg").mockImplementation(() => {
		broadcasts++;
	});
	wifiStateInit({
		on: () => undefined,
		off: () => undefined,
		start: () => undefined,
		stop: () => undefined,
	});
	let restoreShadow: (() => void | Promise<void>) | undefined;
	const module = new URL(
		"../../modules/wifi/wifi-radio-identity.ts",
		import.meta.url,
	);
	if (await Bun.file(module).exists()) {
		const { fakeShadowSysfs } = await import(
			"./wifi-radio-equivalence-shadow.ts"
		);
		restoreShadow = await fakeShadowSysfs(() => []);
	}
	const calls = [wifiUpdateDevices(), wifiUpdateDevices(), wifiUpdateDevices()];
	const outcomes = calls.map((call) =>
		call.then(
			(value) => ({ value }),
			(error: unknown) => ({
				error: error instanceof Error ? error.message : String(error),
			}),
		),
	);
	try {
		const initialReads = reads;
		if (initialReads !== 1) {
			throw new Error(
				`Bounded discovery initial reads changed: ${initialReads}, expected 1`,
			);
		}
		if (errors) gates[0]?.reject(new Error("first legacy failure"));
		else gates[0]?.resolve([]);
		await outcomes[0];
		gates[1]?.resolve(errors ? [] : ["wlan0:wifi:unavailable:"]);
		await outcomes[1];
		const settled = await Promise.all(outcomes);
		return {
			initialReads,
			reads,
			joined: calls[1] === calls[2],
			results: errors
				? settled
				: settled.map((outcome) =>
						"value" in outcome ? outcome.value : outcome,
					),
			broadcasts,
			keys: Object.keys(getWifiInterfacesByMacAddress()),
			unexpected,
		};
	} finally {
		for (const gate of gates) gate.resolve([]);
		await Promise.allSettled(outcomes);
		stopWifiUpdateLoopForTest();
		wifiCancelScanRefresh();
		resetHotspotClientsForTest();
		resetWifiCapabilitiesForTest();
		clearWifiInterfacesForTest();
		await restoreShadow?.();
		scan.mockRestore();
		profiles.mockRestore();
		devices.mockRestore();
		sink.mockRestore();
		command.mockRestore();
		jest.useRealTimers();
	}
}
