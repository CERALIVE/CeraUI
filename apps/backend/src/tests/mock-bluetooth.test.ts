import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";

import { bluetoothStatusSchema } from "@ceraui/rpc/schemas";

import { buildMockBtDevice } from "../mocks/fixture-factory.ts";
import { scenarios } from "../mocks/mock-config.ts";
import {
	mockBtDeviceSchema,
	validateMockFixtures,
} from "../mocks/mock-schemas.ts";
import {
	initMockService,
	resetMockState,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	getMockBluetoothStatus,
	getMockBtDevice,
	getMockBtDevices,
	getMockBtScanTimerCount,
	isMockBtScanning,
	MOCK_BT_ADAPTER_PATH,
	MOCK_BT_BARE_PATH,
	MOCK_BT_MIC_BATTERY_PERCENT,
	MOCK_BT_MIC_PATH,
	MOCK_BT_PHONE_PATH,
	MOCK_BT_SPEAKER_PATH,
	mockBtConnect,
	mockBtDevicePath,
	mockBtDisconnect,
	mockBtDiscoverableFixtures,
	mockBtForget,
	mockBtPair,
	mockBtPairedMicFixture,
	mockBtSetTrusted,
	setMockBtAgentRegistered,
	setMockBtScenario,
	startMockBtScan,
	stopMockBtScan,
	UUID_A2DP_SINK,
	UUID_A2DP_SOURCE,
	UUID_HFP_HF,
	UUID_HSP_HS,
} from "../mocks/providers/bluetooth.ts";
import { deriveCapability } from "../modules/bluetooth/bluetooth-classes.ts";

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

function deviceAt(path: string) {
	const device = getMockBtDevice(path);
	if (device === undefined) throw new Error(`no mock BT device at ${path}`);
	return device;
}

describe("BT mock fixtures — schema + derivation", () => {
	beforeAll(() => initMockService("multi-modem-wifi"));
	afterAll(() => stopMockService());
	afterEach(() => resetMockState());

	test("validateMockFixtures() accepts every shipped BT fixture", () => {
		expect(() => validateMockFixtures()).not.toThrow();
	});

	test("a drifted MAC fails loudly, and the drift is written as evidence", () => {
		const drifted = {
			...mockBtPairedMicFixture(),
			address: "ZZ:BB:CC:DD:EE:11",
		};
		const result = mockBtDeviceSchema.safeParse(drifted);

		expect(result.success).toBe(false);
		if (result.success)
			throw new Error("expected a drifted MAC to be rejected");

		const addressIssue = result.error.issues.find((issue) =>
			issue.path.includes("address"),
		);
		expect(addressIssue?.message).toBe(
			"Must be a colon-separated 48-bit MAC address",
		);

		Bun.write(
			"test-results/bt-mock-drift.txt",
			`${[
				"Todo 14 — BT mock fixture drift detection",
				`Malformed fixture: the mic with address='${drifted.address}'`,
				"",
				"Zod rejection:",
				...result.error.issues.map(
					(issue) =>
						`  • [${issue.path.join(".") || "<root>"}]: ${issue.message}`,
				),
			].join("\n")}\n`,
		);
	});

	test("a device path that does not encode its own address is rejected", () => {
		const incoherent = {
			...mockBtPairedMicFixture(),
			address: "AA:BB:CC:DD:EE:99",
		};
		const result = mockBtDeviceSchema.safeParse(incoherent);

		expect(result.success).toBe(false);
		if (result.success) throw new Error("expected an incoherent path to fail");
		expect(
			result.error.issues.some((issue) => issue.path.includes("path")),
		).toBe(true);
	});

	test("buildMockBtDevice() mirrors the shipped bonded-mic fixture", () => {
		expect(buildMockBtDevice()).toEqual(mockBtPairedMicFixture());
	});

	test("buildMockBtDevice() throws at the build site on a malformed override", () => {
		expect(() => buildMockBtDevice({ address: "not-a-mac" })).toThrow();
		expect(() => buildMockBtDevice({ battery: 140 })).toThrow();
		// A coherent address change carries its path with it — the constraint is
		// satisfiable, not merely restrictive.
		const address = "AA:BB:CC:DD:EE:AB";
		expect(
			buildMockBtDevice({ address, path: mockBtDevicePath(address) }).path,
		).toBe("/org/bluez/hci0/dev_AA_BB_CC_DD_EE_AB");
	});

	test("the pairable mic is an audio-input with a SCO leg and a battery", () => {
		const mic = mockBtPairedMicFixture();

		expect(mic.deviceClass).toBe("audio-input");
		expect(mic.scoCapable).toBe(true);
		expect(mic.battery).toBe(MOCK_BT_MIC_BATTERY_PERCENT);
		expect(mic.transport).toBe("bredr");
		// DERIVED, not stated: the fixture's class pair is exactly what todo 12's
		// production derivation answers for the UUIDs it advertises.
		expect(deriveCapability([UUID_HSP_HS, UUID_HFP_HF])).toEqual({
			deviceClass: "audio-input",
			scoCapable: true,
		});
	});

	test("an A2DP-source-only device is an input with NO SCO leg", () => {
		const phone = mockBtDiscoverableFixtures().find(
			(d) => d.path === MOCK_BT_PHONE_PATH,
		);

		expect(phone?.deviceClass).toBe("audio-input");
		expect(phone?.scoCapable).toBe(false);
		expect(deriveCapability([UUID_A2DP_SOURCE])).toEqual({
			deviceClass: "audio-input",
			scoCapable: false,
		});
	});

	test("a playback-only speaker and a bare advertisement stay unknown", () => {
		const roster = mockBtDiscoverableFixtures();
		const speaker = roster.find((d) => d.path === MOCK_BT_SPEAKER_PATH);
		const bare = roster.find((d) => d.path === MOCK_BT_BARE_PATH);

		expect(speaker?.deviceClass).toBe("unknown");
		expect(speaker?.scoCapable).toBe(false);
		expect(deriveCapability([UUID_A2DP_SINK]).deviceClass).toBe("unknown");

		expect(bare?.deviceClass).toBe("unknown");
		expect(bare?.transport).toBe("unknown");
		expect(bare?.name).toBeUndefined();
	});

	test("an un-bonded roster device publishes no battery", () => {
		const mic = mockBtDiscoverableFixtures().find(
			(d) => d.path === MOCK_BT_MIC_PATH,
		);
		expect(mic?.battery).toBeUndefined();
		expect(mic?.rssi).toBe(-47);
	});
});

describe("BT mock scenarios", () => {
	afterAll(() => stopMockService());

	test("multi-modem-wifi is BT-present with an empty registry", () => {
		initMockService("multi-modem-wifi");
		const status = getMockBluetoothStatus();

		expect(bluetoothStatusSchema.safeParse(status).success).toBe(true);
		expect(status.available).toBe(true);
		expect(status.enabled).toBe(true);
		expect(status.adapters).toHaveLength(1);
		expect(status.adapters[0]?.path).toBe(MOCK_BT_ADAPTER_PATH);
		expect(status.devices).toHaveLength(0);
		expect(status.agent.registered).toBe(true);
	});

	test("bt-mic-paired seeds one bonded mic, battery and all", () => {
		initMockService("bt-mic-paired");
		const status = getMockBluetoothStatus();

		expect(bluetoothStatusSchema.safeParse(status).success).toBe(true);
		expect(status.devices).toHaveLength(1);
		expect(status.devices[0]).toEqual(mockBtPairedMicFixture());
		expect(status.devices[0]?.paired).toBe(true);
		expect(status.devices[0]?.trusted).toBe(true);
		expect(status.devices[0]?.connected).toBe(true);
		expect(status.devices[0]?.battery).toBe(MOCK_BT_MIC_BATTERY_PERCENT);
		// A bonded device is not advertising, so it carries no RSSI.
		expect(status.devices[0]?.rssi).toBeUndefined();
		expect(status.capabilities["audio-input"]).toBe("capable");
	});

	test("bt-mic-paired is registered in the scenario roster", () => {
		expect(scenarios["bt-mic-paired"].bluetooth).toEqual({
			adapter: true,
			enabled: true,
			micPaired: true,
			agent: true,
		});
	});

	test("a scenario with no BT block reports the emulated floor", () => {
		initMockService("single-modem");
		const status = getMockBluetoothStatus();

		expect(status.available).toBe(false);
		expect(status.unavailable?.cause).toBe("emulated");
		expect(status.adapters).toHaveLength(0);
		expect(status.devices).toHaveLength(0);
		expect(mockBtPair(MOCK_BT_MIC_PATH)).toEqual({
			ok: false,
			error: "bt_unavailable_in_emulated_mode",
		});
	});

	test("the agent gap every real device has is drivable", () => {
		initMockService("bt-mic-paired");
		setMockBtAgentRegistered(false);

		const status = getMockBluetoothStatus();
		expect(status.agent.registered).toBe(false);
		expect(status.agent.reason).toBe("exporter_unavailable");
		expect(status.capabilities.pairing).toBe("unavailable");
	});
});

describe("BT mock — the gate ladder", () => {
	beforeAll(() => initMockService("bt-mic-paired"));
	afterAll(() => stopMockService());
	afterEach(() => resetMockState());

	test("a controller-less board refuses every mutation with no_adapter", () => {
		setMockBtScenario({ adapter: false });

		const status = getMockBluetoothStatus();
		expect(status.available).toBe(false);
		expect(status.unavailable?.cause).toBe("no_adapter");
		expect(status.capabilities.adapter).toBe("unavailable");

		expect(mockBtPair(MOCK_BT_MIC_PATH)).toEqual({
			ok: false,
			error: "no_adapter",
		});
		expect(startMockBtScan(MOCK_BT_ADAPTER_PATH)).toEqual({
			ok: false,
			error: "no_adapter",
		});
	});

	test("an operator-disabled board answers bluetooth_disabled, not a fault", () => {
		setMockBtScenario({ enabled: false });

		const status = getMockBluetoothStatus();
		expect(status.enabled).toBe(false);
		expect(status.available).toBe(false);
		expect(status.unavailable?.cause).toBe("bluez_unavailable");
		expect(status.adapters).toHaveLength(0);

		expect(mockBtSetTrusted(MOCK_BT_MIC_PATH, true)).toEqual({
			ok: false,
			error: "bluetooth_disabled",
		});
	});

	test("an unknown path is refused as such", () => {
		expect(mockBtPair("/org/bluez/hci0/dev_00_00_00_00_00_00")).toEqual({
			ok: false,
			error: "unknown_device",
		});
		expect(startMockBtScan("/org/bluez/hci9")).toEqual({
			ok: false,
			error: "unknown_adapter",
		});
	});
});

describe("BT mock — the pair/trust state machine", () => {
	beforeAll(() => initMockService("multi-modem-wifi"));
	afterAll(() => stopMockService());
	afterEach(() => resetMockState());

	async function discoverRoster(): Promise<void> {
		startMockBtScan(MOCK_BT_ADAPTER_PATH, { tickMs: 1, windowMs: 5_000 });
		await sleep(60);
		stopMockBtScan(MOCK_BT_ADAPTER_PATH);
	}

	test("pair bonds AND connects, restoring the battery", async () => {
		await discoverRoster();
		expect(deviceAt(MOCK_BT_MIC_PATH).paired).toBe(false);

		expect(mockBtPair(MOCK_BT_MIC_PATH)).toEqual({ ok: true });

		const mic = deviceAt(MOCK_BT_MIC_PATH);
		expect(mic.paired).toBe(true);
		expect(mic.connected).toBe(true);
		expect(mic.battery).toBe(MOCK_BT_MIC_BATTERY_PERCENT);
		expect(mic.trusted).toBe(false);
	});

	test("pairing twice is idempotent", async () => {
		await discoverRoster();
		mockBtPair(MOCK_BT_MIC_PATH);
		const first = deviceAt(MOCK_BT_MIC_PATH);

		expect(mockBtPair(MOCK_BT_MIC_PATH)).toEqual({ ok: true });
		expect(deviceAt(MOCK_BT_MIC_PATH)).toEqual(first);
	});

	test("trust is a settable flag, and it can be revoked", async () => {
		await discoverRoster();
		mockBtPair(MOCK_BT_MIC_PATH);

		expect(mockBtSetTrusted(MOCK_BT_MIC_PATH, true)).toEqual({ ok: true });
		expect(deviceAt(MOCK_BT_MIC_PATH).trusted).toBe(true);

		expect(mockBtSetTrusted(MOCK_BT_MIC_PATH, false)).toEqual({ ok: true });
		expect(deviceAt(MOCK_BT_MIC_PATH).trusted).toBe(false);
	});

	test("disconnect retracts the battery; reconnect restores it", async () => {
		await discoverRoster();
		mockBtPair(MOCK_BT_MIC_PATH);

		expect(mockBtDisconnect(MOCK_BT_MIC_PATH)).toEqual({ ok: true });
		const away = deviceAt(MOCK_BT_MIC_PATH);
		expect(away.connected).toBe(false);
		expect(away.battery).toBeUndefined();
		// The BOND survives the link — a disconnected headset is still paired.
		expect(away.paired).toBe(true);

		expect(mockBtConnect(MOCK_BT_MIC_PATH)).toEqual({ ok: true });
		const back = deviceAt(MOCK_BT_MIC_PATH);
		expect(back.connected).toBe(true);
		expect(back.battery).toBe(MOCK_BT_MIC_BATTERY_PERCENT);
	});

	test("forget retires the row entirely", async () => {
		await discoverRoster();
		mockBtPair(MOCK_BT_MIC_PATH);
		mockBtSetTrusted(MOCK_BT_MIC_PATH, true);

		expect(mockBtForget(MOCK_BT_MIC_PATH)).toEqual({ ok: true });
		expect(getMockBtDevice(MOCK_BT_MIC_PATH)).toBeUndefined();
		expect(mockBtForget(MOCK_BT_MIC_PATH)).toEqual({
			ok: false,
			error: "unknown_device",
		});
	});

	test("a bonded mic reaches the wire as a schema-valid audio input", async () => {
		await discoverRoster();
		mockBtPair(MOCK_BT_MIC_PATH);
		mockBtSetTrusted(MOCK_BT_MIC_PATH, true);

		const status = getMockBluetoothStatus();
		expect(bluetoothStatusSchema.safeParse(status).success).toBe(true);
		expect(status.devices.find((d) => d.path === MOCK_BT_MIC_PATH)).toEqual(
			mockBtPairedMicFixture(),
		);
	});
});

describe("BT mock — the scan lifecycle", () => {
	beforeAll(() => initMockService("multi-modem-wifi"));
	afterAll(() => stopMockService());
	afterEach(() => resetMockState());

	test("a scan starts empty and discovers over ticks, then stops itself", async () => {
		expect(getMockBtDevices()).toHaveLength(0);

		expect(
			startMockBtScan(MOCK_BT_ADAPTER_PATH, { tickMs: 15, windowMs: 160 }),
		).toEqual({ ok: true });
		expect(isMockBtScanning()).toBe(true);
		// Nothing is folded in at t=0 — the roster has to arrive.
		expect(getMockBtDevices()).toHaveLength(0);

		await sleep(45);
		const midway = getMockBtDevices();
		expect(midway.length).toBeGreaterThan(0);
		expect(midway.length).toBeLessThan(4);
		expect(midway[0]?.path).toBe(MOCK_BT_MIC_PATH);

		await sleep(200);
		expect(getMockBtDevices()).toHaveLength(4);
		expect(isMockBtScanning()).toBe(false);
		expect(getMockBtScanTimerCount()).toBe(0);
	});

	test("a second scan on a scanning adapter is refused, never queued", () => {
		startMockBtScan(MOCK_BT_ADAPTER_PATH, { tickMs: 500, windowMs: 5_000 });

		expect(startMockBtScan(MOCK_BT_ADAPTER_PATH)).toEqual({
			ok: false,
			error: "adapter_busy",
			heldBy: "discovery",
		});
	});

	test("a discovered device carries an RSSI and no bond", async () => {
		startMockBtScan(MOCK_BT_ADAPTER_PATH, { tickMs: 1, windowMs: 5_000 });
		await sleep(60);

		const mic = deviceAt(MOCK_BT_MIC_PATH);
		expect(mic.paired).toBe(false);
		expect(mic.trusted).toBe(false);
		expect(mic.connected).toBe(false);
		expect(mic.battery).toBeUndefined();
		expect(mic.rssi).toBe(-47);
	});

	test("stopping early closes the window and drops every timer", async () => {
		startMockBtScan(MOCK_BT_ADAPTER_PATH, { tickMs: 1_000, windowMs: 9_000 });
		expect(getMockBtScanTimerCount()).toBeGreaterThan(0);

		expect(stopMockBtScan(MOCK_BT_ADAPTER_PATH)).toEqual({ ok: true });
		expect(isMockBtScanning()).toBe(false);
		expect(getMockBtScanTimerCount()).toBe(0);

		// Nothing arrives after the window closed.
		await sleep(30);
		expect(getMockBtDevices()).toHaveLength(0);
	});
});

describe("BT mock — resetMockState() leaves no timers and no state", () => {
	beforeAll(() => initMockService("bt-mic-paired"));
	afterAll(() => stopMockService());

	test("an in-flight scan and its mutations are scrubbed by a reset", async () => {
		mockBtForget(MOCK_BT_MIC_PATH);
		setMockBtAgentRegistered(false);
		startMockBtScan(MOCK_BT_ADAPTER_PATH, { tickMs: 1_000, windowMs: 30_000 });

		expect(getMockBtScanTimerCount()).toBeGreaterThan(0);
		expect(isMockBtScanning()).toBe(true);
		expect(getMockBtDevices()).toHaveLength(0);

		resetMockState();

		expect(getMockBtScanTimerCount()).toBe(0);
		expect(isMockBtScanning()).toBe(false);
		expect(getMockBluetoothStatus().agent.registered).toBe(true);
		expect(getMockBtDevices()).toEqual([mockBtPairedMicFixture()]);

		// The cleared timers stay cleared: nothing fires after the reset.
		await sleep(30);
		expect(getMockBtScanTimerCount()).toBe(0);
		expect(getMockBtDevices()).toEqual([mockBtPairedMicFixture()]);
	});

	test("a reset also drops a scenario override", () => {
		setMockBtScenario({ adapter: false });
		expect(getMockBluetoothStatus().unavailable?.cause).toBe("no_adapter");

		resetMockState();

		expect(getMockBluetoothStatus().available).toBe(true);
	});
});
