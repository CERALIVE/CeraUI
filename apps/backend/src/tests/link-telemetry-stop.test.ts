import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";

import type {
	Telemetry,
	TelemetryUpdate,
	watchTelemetry as WatchTelemetryFn,
} from "@ceralive/srtla-send/telemetry";
import {
	initMockService,
	setStreamingState,
	stopMockService,
} from "../mocks/mock-service.ts";
import { buildMockLinkTelemetry } from "../mocks/providers/streaming.ts";
import {
	broadcastLinkTelemetryIfChanged,
	buildLinkTelemetry,
	isLinkTelemetryActive,
	resetLinkTelemetryBroadcastState,
	setIfaceResolverForTest,
	setMockLinkTelemetryProvider,
	startLinkTelemetry,
	stopLinkTelemetry,
} from "../modules/streaming/link-telemetry.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";

/*
    Todo 5 — telemetry null-on-stop regression test.

    Locks the stop contract the frontend (Todo 6) relies on: once the stream
    stops — via session stop OR srtla_send process exit, both of which call
    `stopLinkTelemetry()` in streamloop/{process-runner,session}.ts — the NEXT
    `broadcastLinkTelemetryIfChanged()` heartbeat tick MUST emit
    `{ linkTelemetry: null }` exactly once, and the tick after that emits
    NOTHING (the JSON-diff dedupe holds "null" against "null").

    The guarantee hinges on `stopLinkTelemetry()` NOT resetting the broadcast
    dedupe cache (`lastBroadcastJson`): the last live tick left a non-null JSON
    cached, so the first post-stop null payload differs and is broadcast; the
    second matches and is suppressed. If a future change reset the dedupe cache
    inside the stop path, the null frame would be swallowed and the HUD would
    keep showing a stale bond — this test is the tripwire for that ordering bug.
*/

function snapshot(
	connections: Array<Partial<Telemetry["connections"][number]>>,
): Telemetry {
	return {
		schema_version: 1,
		last_updated_ms: Date.now(),
		connections: connections.map((c, i) => ({
			conn_id: String(i),
			rtt_ms: 0,
			nak_count: 0,
			weight_percent: 100,
			window: 1000,
			in_flight: 0,
			bitrate_bps: 0,
			...c,
		})),
	};
}

// A watch double that captures the fresh-snapshot callback so the test drives
// telemetry ticks directly, matching the file-poll producer path.
function captureWatch() {
	const calls: Array<{ path: string; cb: (u: TelemetryUpdate) => void }> = [];
	const watch: typeof WatchTelemetryFn = (path, cb) => {
		calls.push({ path, cb });
		return { stop: () => {} };
	};
	return {
		watch,
		emit: (t: Telemetry | null) => {
			for (const c of calls) c.cb({ data: t, stale: t === null });
		},
	};
}

function captureClient(sink: string[]): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: (message: string) => sink.push(message),
	} as unknown as AppWebSocket;
}

// Extract the `status` payloads a broadcast tick actually pushed to the socket.
function statusPayloads(raw: string[]) {
	return raw
		.map((line) => JSON.parse(line))
		.filter(
			(obj): obj is { status: { linkTelemetry: unknown } } =>
				!!obj && typeof obj === "object" && "status" in obj,
		)
		.map((obj) => obj.status);
}

describe("production stop → null linkTelemetry broadcast once (dedupe holds)", () => {
	beforeEach(() => {
		stopLinkTelemetry();
		setIfaceResolverForTest(null);
		setMockLinkTelemetryProvider(null);
		resetLinkTelemetryBroadcastState();
	});

	afterEach(() => {
		stopLinkTelemetry();
		setIfaceResolverForTest(null);
		setMockLinkTelemetryProvider(null);
		resetLinkTelemetryBroadcastState();
	});

	test("stopLinkTelemetry() → next tick emits {linkTelemetry:null} exactly once; second tick emits nothing", () => {
		const sink: string[] = [];
		const client = captureClient(sink);
		addClient(client);
		try {
			const w = captureWatch();
			setIfaceResolverForTest(() => "usb0");

			// --- Stream live: a fresh snapshot flows and one tick broadcasts it. ---
			startLinkTelemetry("/tmp/stats.json", ["10.0.0.1"], { watch: w.watch });
			w.emit(snapshot([{ conn_id: "0", nak_count: 1, weight_percent: 100 }]));

			const live = broadcastLinkTelemetryIfChanged();
			expect(live).not.toBeNull();
			expect(live?.links[0]?.iface).toBe("usb0");

			// --- Stream stops (session stop / srtla_send exit both call this). ---
			stopLinkTelemetry();
			// No active source → the derived payload is null immediately.
			expect(isLinkTelemetryActive()).toBe(false);
			expect(buildLinkTelemetry()).toBeNull();

			// --- First heartbeat tick after stop: emits the null frame once. ---
			const firstAfterStop = broadcastLinkTelemetryIfChanged();
			expect(firstAfterStop).toBeNull();

			// --- Second heartbeat tick: dedupe holds "null" vs "null" → silent. ---
			const secondAfterStop = broadcastLinkTelemetryIfChanged();
			expect(secondAfterStop).toBeNull();

			// Exactly two status pushes total: the live one, then the null one.
			const statuses = statusPayloads(sink);
			expect(statuses).toHaveLength(2);
			// The live tick carried real links; the post-stop tick carried null.
			expect(statuses[0]?.linkTelemetry).not.toBeNull();
			expect(statuses[1]?.linkTelemetry).toBeNull();

			// Precisely one frame across the whole run set linkTelemetry to null.
			const nullFrames = statuses.filter((s) => s.linkTelemetry === null);
			expect(nullFrames).toHaveLength(1);
		} finally {
			removeClient(client);
		}
	});

	test("buildLinkTelemetry() returns null after stop (no active source)", () => {
		const w = captureWatch();
		setIfaceResolverForTest(() => "usb0");
		startLinkTelemetry("/tmp/stats.json", ["10.0.0.1"], { watch: w.watch });
		w.emit(snapshot([{ conn_id: "0" }]));
		expect(buildLinkTelemetry()).not.toBeNull();

		stopLinkTelemetry();
		expect(buildLinkTelemetry()).toBeNull();
	});
});

describe("mock provider path → buildMockLinkTelemetry() null when not active", () => {
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

	test("idle scenario (getStreamingStats().isActive === false) → null", () => {
		initMockService("multi-modem-wifi");
		expect(buildMockLinkTelemetry()).toBeNull();
	});

	test("active stream flipped inactive mid-scenario → back to null", () => {
		initMockService("streaming-active");
		expect(buildMockLinkTelemetry()).not.toBeNull();

		setStreamingState(false);
		expect(buildMockLinkTelemetry()).toBeNull();
	});
});
