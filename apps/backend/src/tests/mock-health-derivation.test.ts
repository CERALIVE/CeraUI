import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";

import {
	getMockHealth,
	getMockState,
	initMockService,
	resetMockState,
	setMockHealth,
	setStreamingState,
	stopMockService,
	updateMockState,
} from "../mocks/mock-service.ts";
import {
	startMockStreaming,
	stopMockStreaming,
} from "../mocks/providers/streaming.ts";

let priorMockMode: string | undefined;

beforeAll(() => {
	priorMockMode = process.env.MOCK_MODE;
	process.env.MOCK_MODE = "true";
});

afterAll(() => {
	if (priorMockMode === undefined) {
		delete process.env.MOCK_MODE;
	} else {
		process.env.MOCK_MODE = priorMockMode;
	}
});

afterEach(() => stopMockService());

describe("getMockHealth — derives liveness from the mock streaming engine", () => {
	test("active streaming scenario derives a healthy bond", () => {
		initMockService("streaming-active");

		const health = getMockHealth();
		expect(health.processAlive).toBe(true);
		expect(health.framesAdvancing).toBe(true);
		expect(health.linkCount).toBe(2);
		expect(health.activeLinks).toBe(2);
	});

	test("idle scenario derives a dead process with zero active links", () => {
		initMockService("multi-modem-wifi");

		const health = getMockHealth();
		expect(health.processAlive).toBe(false);
		expect(health.framesAdvancing).toBe(false);
		expect(health.linkCount).toBe(3);
		expect(health.activeLinks).toBe(0);
	});

	test("starting then stopping the mock stream flips derived liveness", () => {
		initMockService("single-modem");
		expect(getMockHealth().processAlive).toBe(false);

		startMockStreaming();
		const live = getMockHealth();
		expect(live.processAlive).toBe(true);
		expect(live.framesAdvancing).toBe(true);
		expect(live.activeLinks).toBe(1);

		stopMockStreaming();
		const idle = getMockHealth();
		expect(idle.processAlive).toBe(false);
		expect(idle.activeLinks).toBe(0);
	});

	test("setStreamingState alone drives derived liveness without manual health writes", () => {
		initMockService("multi-modem-wifi");
		expect(getMockHealth().activeLinks).toBe(0);

		setStreamingState(true);
		expect(getMockHealth().activeLinks).toBe(3);
		expect(getMockHealth().processAlive).toBe(true);
	});
});

describe("active-link count tracks the connected-relay engine state", () => {
	test("dropping active links lowers activeLinks; restoring raises it", () => {
		initMockService("streaming-active");
		expect(getMockHealth().activeLinks).toBe(2);

		updateMockState({
			streaming: { ...getMockState().streaming, connectedRelays: 1 },
		});
		const dropped = getMockHealth();
		expect(dropped.activeLinks).toBe(1);
		expect(dropped.linkCount).toBe(2);

		updateMockState({
			streaming: { ...getMockState().streaming, connectedRelays: 2 },
		});
		expect(getMockHealth().activeLinks).toBe(2);
	});
});

describe("manual override still works for edge tests", () => {
	test("setMockHealth wins over the derived values it overrides", () => {
		initMockService("streaming-active");
		expect(getMockHealth().processAlive).toBe(true);
		expect(getMockHealth().activeLinks).toBe(2);

		setMockHealth({ processAlive: false, activeLinks: 0 });

		const overridden = getMockHealth();
		expect(overridden.processAlive).toBe(false);
		expect(overridden.activeLinks).toBe(0);
		expect(overridden.framesAdvancing).toBe(true);
		expect(overridden.linkCount).toBe(2);
	});

	test("resetMockState clears the override back to engine-derived health", () => {
		initMockService("streaming-active");
		setMockHealth({ processAlive: false, activeLinks: 0 });
		expect(getMockHealth().processAlive).toBe(false);

		resetMockState();

		const restored = getMockHealth();
		expect(restored.processAlive).toBe(true);
		expect(restored.activeLinks).toBe(2);
	});
});
