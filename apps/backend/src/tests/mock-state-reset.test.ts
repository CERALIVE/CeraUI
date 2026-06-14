import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";

import {
	getMockState,
	initMockService,
	type MockState,
	resetMockState,
	setMockEncoderConfig,
	setMockModemConfig,
	setMockNetifConfig,
	setMockWifiConnection,
	stopMockService,
	updateMockState,
} from "../mocks/mock-service.ts";

const SCENARIO = "multi-modem-wifi";

// Pristine seeds for the multi-modem-wifi scenario (mirrors mock-service init).
const PRISTINE_MODEM0_APN = "internet.tmobile.com"; // carrier "T-Mobile"
const PRISTINE_ETH0_IP = "192.168.1.100";
const PRISTINE_WLAN0_NETWORK = "HomeNetwork";

const snapshot = (): MockState => structuredClone(getMockState());

describe("mockState mutation ownership — updateMockState + named setters", () => {
	beforeAll(() => initMockService(SCENARIO));
	afterAll(() => stopMockService());

	test("named setters write through to mockState slices", () => {
		setMockModemConfig("0", { apn: "custom.apn", roaming: true });
		setMockNetifConfig("eth0", { ip: "172.16.0.5", enabled: false });
		setMockWifiConnection("wlan0", { activeNetwork: "OtherNet" });
		setMockEncoderConfig({ max_br: 4242 });

		const state = getMockState();
		expect(state.modemConfigs.get("0")?.apn).toBe("custom.apn");
		expect(state.modemConfigs.get("0")?.roaming).toBe(true);
		expect(state.netifConfigs.get("eth0")?.ip).toBe("172.16.0.5");
		expect(state.netifConfigs.get("eth0")?.enabled).toBe(false);
		expect(state.wifiConnections.get("wlan0")?.activeNetwork).toBe("OtherNet");
		expect(state.mockEncoderConfig.max_br).toBe(4242);
	});

	test("updateMockState merges a top-level slice", () => {
		updateMockState({
			sensors: { socTemp: 91, socVoltage: 5.1, socCurrent: 3.3 },
		});
		expect(getMockState().sensors).toEqual({
			socTemp: 91,
			socVoltage: 5.1,
			socCurrent: 3.3,
		});
	});
});

describe("resetMockState — restore the pristine scenario snapshot", () => {
	beforeAll(() => initMockService(SCENARIO));
	afterAll(() => stopMockService());

	test("mutate every slice → reset → deep-equals pristine snapshot", () => {
		const pristine = snapshot();

		// Mutate across maps, records, and nested objects.
		setMockModemConfig("0", { apn: "polluted.apn", roaming: true });
		setMockNetifConfig("eth0", { ip: "10.10.10.10", enabled: false });
		setMockWifiConnection("wlan0", { activeNetwork: "PollutedNet" });
		setMockEncoderConfig({ max_br: 999, pipeline: "polluted" });
		updateMockState({
			sensors: { socTemp: 999, socVoltage: 0.1, socCurrent: 0.1 },
		});

		// Mutation is observable and differs from pristine.
		expect(snapshot()).not.toEqual(pristine);
		expect(getMockState().modemConfigs.get("0")?.apn).toBe("polluted.apn");

		resetMockState();

		expect(snapshot()).toEqual(pristine);
	});
});

describe("per-test isolation — two sequential tests do not bleed state", () => {
	// init ONCE: the only thing that cleans up between the two tests is the
	// afterEach resetMockState() — so a clean second test proves reset isolates.
	let pristine: MockState;
	beforeAll(() => {
		initMockService(SCENARIO);
		pristine = snapshot();
	});
	afterEach(() => resetMockState());
	afterAll(() => stopMockService());

	test("first test pollutes the shared mockState", () => {
		setMockModemConfig("0", { apn: "bled.apn" });
		setMockNetifConfig("eth0", { ip: "10.10.10.10" });
		setMockWifiConnection("wlan0", { activeNetwork: "BledNet" });
		updateMockState({
			sensors: { socTemp: 999, socVoltage: 0.1, socCurrent: 0.1 },
		});

		const state = getMockState();
		expect(state.modemConfigs.get("0")?.apn).toBe("bled.apn");
		expect(state.netifConfigs.get("eth0")?.ip).toBe("10.10.10.10");
		expect(state.sensors.socTemp).toBe(999);
	});

	test("second test sees pristine state, not the first test's mutations", () => {
		expect(snapshot()).toEqual(pristine);

		const state = getMockState();
		expect(state.modemConfigs.get("0")?.apn).toBe(PRISTINE_MODEM0_APN);
		expect(state.netifConfigs.get("eth0")?.ip).toBe(PRISTINE_ETH0_IP);
		expect(state.wifiConnections.get("wlan0")?.activeNetwork).toBe(
			PRISTINE_WLAN0_NETWORK,
		);
	});
});
