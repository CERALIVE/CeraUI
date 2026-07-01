import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import {
	initMockService,
	setStreamingState,
	stopMockService,
} from "../mocks/mock-service.ts";
import { buildMockLinkTelemetry } from "../mocks/providers/streaming.ts";
import {
	buildLinkTelemetry,
	setMockLinkTelemetryProvider,
} from "../modules/streaming/link-telemetry.ts";

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

afterEach(() => {
	setMockLinkTelemetryProvider(null);
	stopMockService();
});

// The exact bonded-link id set the frontend derives per scenario (T4 canonical
// join set): eth0 (always) + usbN modems + wifi radios. A telemetry `iface` NOT
// in this set renders nowhere; a card whose id has no telemetry shows "--".
const STREAMING_ACTIVE_IFACES = ["eth0", "usb0", "usb1", "wlan0", "wlan1"];
const SINGLE_MODEM_IFACES = ["eth0", "usb0"];

describe("buildMockLinkTelemetry — active-only per-link emission", () => {
	test("idle scenario (no active mock stream) -> null", () => {
		initMockService("multi-modem-wifi");
		expect(buildMockLinkTelemetry()).toBeNull();
	});

	test("streaming-active -> non-null rows whose iface set matches the FE link ids", () => {
		initMockService("streaming-active");

		const payload = buildMockLinkTelemetry();
		expect(payload).not.toBeNull();

		const ifaces = payload?.links.map((l) => l.iface) ?? [];
		expect(new Set(ifaces)).toEqual(new Set(STREAMING_ACTIVE_IFACES));
		// Every emitted iface MUST be one of the FE-derived link ids (the join).
		for (const iface of ifaces) {
			expect(STREAMING_ACTIVE_IFACES).toContain(iface);
		}
	});

	test("streaming-active -> plausible sender values (rtt 20-60, small nak, fresh)", () => {
		initMockService("streaming-active");

		const links = buildMockLinkTelemetry()?.links ?? [];
		expect(links.length).toBe(STREAMING_ACTIVE_IFACES.length);
		for (const link of links) {
			expect(link.rtt_ms).toBeGreaterThanOrEqual(20);
			expect(link.rtt_ms).toBeLessThanOrEqual(60);
			expect(link.nak_count).toBeGreaterThanOrEqual(0);
			expect(link.nak_count).toBeLessThanOrEqual(3);
			expect(link.stale).toBe(false);
			expect(typeof link.conn_id).toBe("string");
		}
	});

	// weight_percent is each active link's NORMALIZED share of total selection
	// weight, summing to ~100 across active links — NOT a per-link constant 100.
	// Contract source: srtla-send-rs src/telemetry_file.rs `conns_from_stats` /
	// `weight_share_percent` (round(w/total×100); two equal links → 50/50). The
	// independent per-link rounding lets the sum drift by up to ±(link count).
	test("streaming-active -> weight_percent is a normalized share summing to ~100, not all 100", () => {
		initMockService("streaming-active");

		const links = buildMockLinkTelemetry()?.links ?? [];
		expect(links.length).toBe(STREAMING_ACTIVE_IFACES.length);

		for (const link of links) {
			expect(link.weight_percent).toBeGreaterThanOrEqual(0);
			expect(link.weight_percent).toBeLessThanOrEqual(100);
		}

		const sum = links.reduce((acc, l) => acc + l.weight_percent, 0);
		expect(Math.abs(sum - 100)).toBeLessThanOrEqual(links.length);

		// The reported bug: every link pinned to 100. With >1 active link a
		// normalized share can never leave them all at 100.
		expect(links.every((l) => l.weight_percent === 100)).toBe(false);
	});

	test("single-modem (no wifi) -> only eth0 + usb0", () => {
		initMockService("single-modem");
		setStreamingState(true);

		const ifaces = buildMockLinkTelemetry()?.links.map((l) => l.iface) ?? [];
		expect(new Set(ifaces)).toEqual(new Set(SINGLE_MODEM_IFACES));
	});

	test("stopping the mock stream mid-scenario returns to null (idle)", () => {
		initMockService("streaming-active");
		expect(buildMockLinkTelemetry()).not.toBeNull();

		setStreamingState(false);
		expect(buildMockLinkTelemetry()).toBeNull();
	});
});

describe("buildLinkTelemetry seam — mock rows surface through the status flow", () => {
	test("registered provider drives buildLinkTelemetry while streaming-active", () => {
		initMockService("streaming-active");
		setMockLinkTelemetryProvider(buildMockLinkTelemetry);

		const payload = buildLinkTelemetry();
		expect(payload).not.toBeNull();
		const ifaces = payload?.links.map((l) => l.iface) ?? [];
		expect(new Set(ifaces)).toEqual(new Set(STREAMING_ACTIVE_IFACES));
	});

	test("idle -> buildLinkTelemetry stays null even with the provider registered", () => {
		initMockService("multi-modem-wifi");
		setMockLinkTelemetryProvider(buildMockLinkTelemetry);

		expect(buildLinkTelemetry()).toBeNull();
	});
});
