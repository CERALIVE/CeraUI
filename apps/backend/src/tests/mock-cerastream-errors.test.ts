import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";

import type { RuntimeErrorEvent } from "@ceralive/cerastream";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import {
	getMockState,
	initMockService,
	resetMockState,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	type CerastreamTier2Error,
	clearMockStreamError,
	getInjectedMockStreamError,
	injectMockStreamError,
} from "../mocks/providers/streaming.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
} from "../modules/streaming/cerastream-backend.ts";

// Task 16 — drive each cerastream Tier-2 structured error class through the mock
// injection hook and assert it lands as the right UI-facing notification once it
// flows through the REAL backend error-mapping path (CerastreamBackend.handleEvent
// → resolveCerastreamError). The mock only builds the wire-accurate
// `RuntimeErrorEvent`; the backend mapping under test is untouched.

const SCENARIO = "streaming-active";

const silentLogger: CerastreamBackendDeps["logger"] = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

interface BackendHarness {
	backend: CerastreamBackend;
	notifications: Array<{ name: string; type: string; msg: string }>;
}

function makeBackend(): BackendHarness {
	const notifications: Array<{ name: string; type: string; msg: string }> = [];
	const config: RuntimeConfig = {
		max_br: 8000,
		srt_latency: 2000,
		balancer: "adaptive",
		pipeline: "h264_hdmi_1080p",
	};
	const backend = new CerastreamBackend({
		connect: async () => {
			throw new Error("connect is unused on the error-mapping path");
		},
		connectOptions: {},
		getConfig: () => config,
		saveConfig: () => {},
		bridge: {
			notify: (name, type, msg) => {
				notifications.push({ name, type, msg });
			},
			notificationExists: () => false,
			broadcastStatus: () => {},
		},
		execPath: "cerastream",
		configPath: "/tmp/cerastream-mock-errors.json",
		logger: silentLogger,
	});
	return { backend, notifications };
}

// The UI-facing notification each Tier-2 class must resolve to (channel = the
// notification name, msg = the human-readable text from the Task-7 catalog).
const EXPECTED: Record<
	CerastreamTier2Error,
	{ channel: "srtla" | "cerastream"; msg: string }
> = {
	srtla_initial_connect_failed: {
		channel: "srtla",
		msg: "Failed to connect to the SRTLA server. Retrying...",
	},
	srtla_no_connections: {
		channel: "srtla",
		msg: "All SRTLA connections failed. Trying to reconnect...",
	},
	capture_audio_error: {
		channel: "cerastream",
		msg: "Capture card error (audio). Trying to restart...",
	},
	capture_video_error: {
		channel: "cerastream",
		msg: "Capture card error (video). Trying to restart...",
	},
	pipeline_stall: {
		channel: "cerastream",
		msg: "The input source has stalled. Trying to restart...",
	},
	srt_connect_failed: {
		channel: "cerastream",
		msg: "Failed to connect to the SRT server. Retrying...",
	},
	srt_connection_lost: {
		channel: "cerastream",
		msg: "The SRT connection failed. Trying to reconnect...",
	},
};

const ALL_CODES = Object.keys(EXPECTED) as CerastreamTier2Error[];

describe("mock cerastream Tier-2 error injection → backend mapping", () => {
	beforeAll(() => {
		process.env.MOCK_MODE = "true";
		initMockService(SCENARIO);
	});
	afterEach(() => resetMockState());
	afterAll(() => stopMockService());

	test("injectMockStreamError builds a wire-accurate RuntimeErrorEvent", () => {
		const event = injectMockStreamError("pipeline_stall");
		expect(event).not.toBeNull();
		expect(event?.type).toBe("error");
		expect(event?.code).toBe("pipeline_stall");
		expect(event?.source).toBe("engine");
		expect(getInjectedMockStreamError()).toEqual(event as RuntimeErrorEvent);
	});

	test("each class carries the contract-accurate source (srtla vs engine)", () => {
		expect(injectMockStreamError("srtla_initial_connect_failed")?.source).toBe(
			"srtla",
		);
		expect(injectMockStreamError("srtla_no_connections")?.source).toBe("srtla");
		expect(injectMockStreamError("capture_audio_error")?.source).toBe("engine");
		expect(injectMockStreamError("capture_video_error")?.source).toBe("engine");
		expect(injectMockStreamError("srt_connect_failed")?.source).toBe("engine");
		expect(injectMockStreamError("srt_connection_lost")?.source).toBe("engine");
	});

	for (const code of ALL_CODES) {
		test(`injected '${code}' maps to its expected backend notification`, () => {
			const { backend, notifications } = makeBackend();
			const event = injectMockStreamError(code);
			expect(event).not.toBeNull();
			expect(getInjectedMockStreamError()).toEqual(event as RuntimeErrorEvent);

			backend.handleEvent(event as RuntimeErrorEvent);

			expect(notifications).toHaveLength(1);
			expect(notifications[0]?.name).toBe(EXPECTED[code].channel);
			expect(notifications[0]?.type).toBe("error");
			expect(notifications[0]?.msg).toBe(EXPECTED[code].msg);
		});
	}

	test("srt_connect_failed folds the injected reason into the message", () => {
		const { backend, notifications } = makeBackend();
		const event = injectMockStreamError(
			"srt_connect_failed",
			"Connection timed out",
		);
		expect(event?.reason).toBe("Connection timed out");

		backend.handleEvent(event as RuntimeErrorEvent);

		expect(notifications[0]?.name).toBe("cerastream");
		expect(notifications[0]?.msg).toBe(
			"Failed to connect to the SRT server (Connection timed out). Retrying...",
		);
	});

	test("the injected error is wired into resetMockState() scope (Task 4)", () => {
		injectMockStreamError("capture_video_error");
		expect(getInjectedMockStreamError()).not.toBeNull();
		expect(getMockState().injectedStreamError).not.toBeNull();

		resetMockState();

		expect(getInjectedMockStreamError()).toBeNull();
		expect(getMockState().injectedStreamError).toBeNull();
	});

	test("clearMockStreamError drops the injected error", () => {
		injectMockStreamError("pipeline_stall");
		expect(getInjectedMockStreamError()).not.toBeNull();

		clearMockStreamError();

		expect(getInjectedMockStreamError()).toBeNull();
	});
});

describe("no mock error path in production (stays behind shouldUseMocks())", () => {
	const savedNodeEnv = process.env.NODE_ENV;
	const savedMockMode = process.env.MOCK_MODE;

	afterAll(() => {
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
		stopMockService();
	});

	test("injection is inert when the mock service is not running", () => {
		// Production never calls initMockService (it is gated by isDevelopment()
		// in main.ts), so mockState.initialized is false → shouldUseMocks() false.
		stopMockService();
		process.env.MOCK_MODE = "true";

		expect(injectMockStreamError("pipeline_stall")).toBeNull();
		expect(getInjectedMockStreamError()).toBeNull();
	});

	test("injection is inert when NODE_ENV=production even if init ran", () => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		initMockService(SCENARIO);

		expect(injectMockStreamError("srt_connect_failed")).toBeNull();
		expect(getInjectedMockStreamError()).toBeNull();

		stopMockService();
	});
});
