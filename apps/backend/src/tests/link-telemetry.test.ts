import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ControlClient, HelloResult } from "@ceralive/srtla-send/control";
import {
	connectionTelemetrySchema,
	type Telemetry,
	type TelemetryUpdate,
	telemetrySchema,
	type watchTelemetry as WatchTelemetryFn,
} from "@ceralive/srtla-send/telemetry";
import {
	broadcastLinkTelemetryIfChanged,
	buildLinkTelemetry,
	ingestTelemetryForTest,
	ipForConnId,
	isLinkTelemetryActive,
	registerSrtlaIpList,
	resetLinkTelemetryBroadcastState,
	setControlClientFactoryForTest,
	setIfaceResolverForTest,
	setTelemetryClockForTest,
	startLinkTelemetry,
	stopLinkTelemetry,
} from "../modules/streaming/link-telemetry.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";

// Do NOT re-add a local `bytes_sent_total` widening: `2026.8.0` declares it on
// the producer's own `Telemetry`, so building fixtures against that shape is
// what makes a producer rename fail this file rather than be masked.
type SenderConnection = Telemetry["connections"][number];

function snapshot(
	connections: Array<Partial<SenderConnection>>,
	bondBytesSentTotal?: number,
): Telemetry {
	const snap: Telemetry = {
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
		...(bondBytesSentTotal === undefined
			? {}
			: { bytes_sent_total: bondBytesSentTotal }),
	};
	return snap;
}

// A watch double that captures the callback so the test drives ticks directly,
// and records the path/options it was started with.
function captureWatch() {
	const calls: Array<{ path: string; cb: (u: TelemetryUpdate) => void }> = [];
	let stopped = 0;
	const watch: typeof WatchTelemetryFn = (path, cb) => {
		calls.push({ path, cb });
		return {
			stop: () => {
				stopped++;
			},
		};
	};
	return {
		watch,
		emit: (t: Telemetry | null) => {
			for (const c of calls) c.cb({ data: t, stale: t === null });
		},
		get stopped() {
			return stopped;
		},
		get path() {
			return calls.at(-1)?.path;
		},
		get count() {
			return calls.length;
		},
	};
}

// A control-client double: drives the JSON-RPC stats-subscription cutover path.
// `subscribed` resolves once subscribeStats is invoked (cutover confirmed live),
// and `emit` pushes an `event` snapshot (or null for disconnect/parse-failure).
function fakeControlClient(opts: {
	capabilities: Array<string>;
	helloThrows?: boolean;
}) {
	let onEventCb: ((s: Telemetry | null) => void) | null = null;
	let closed = false;
	let resolveSubscribed!: () => void;
	const subscribed = new Promise<void>((r) => {
		resolveSubscribed = r;
	});
	const client: ControlClient = {
		hello: async (): Promise<HelloResult> => {
			if (opts.helloThrows) throw new Error("hello failed");
			return {
				schema_version: 1,
				engine: "srtla_send",
				capabilities: opts.capabilities,
			};
		},
		rawRequest: async () => null,
		subscribeStats: (onEvent) => {
			onEventCb = onEvent;
			resolveSubscribed();
			return () => {
				closed = true;
				onEventCb = null;
			};
		},
		close: () => {
			closed = true;
		},
	};
	return {
		client,
		emit: (s: Telemetry | null) => onEventCb?.(s),
		subscribed,
		get closed() {
			return closed;
		},
	};
}

// Drain pending microtasks/macrotasks so a fire-and-forget cutover that takes a
// path with no `subscribed` signal (connect failure, capability absent) settles.
const flushCutover = async (): Promise<void> => {
	await Bun.sleep(0);
	await Bun.sleep(0);
};

function captureClient(sink: string[]): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: (message: string) => sink.push(message),
	} as unknown as AppWebSocket;
}

// The registry/watch state is module-global; reset BEFORE each test too so a
// prior test file that touched setSrtlaIpList/startLinkTelemetry cannot leak a
// non-zero conn_id counter into the order-sensitive assertions here.
beforeEach(() => {
	stopLinkTelemetry();
	setIfaceResolverForTest(null);
	setTelemetryClockForTest(null);
	setControlClientFactoryForTest(null);
	resetLinkTelemetryBroadcastState();
});

afterEach(() => {
	stopLinkTelemetry();
	setIfaceResolverForTest(null);
	setTelemetryClockForTest(null);
	setControlClientFactoryForTest(null);
	resetLinkTelemetryBroadcastState();
});

describe("conn_id -> iface registry", () => {
	test("assigns ids in source-IP-file order on first appearance", () => {
		registerSrtlaIpList(["10.0.0.1", "10.0.0.2", "192.168.1.5"]);
		expect(ipForConnId("0")).toBe("10.0.0.1");
		expect(ipForConnId("1")).toBe("10.0.0.2");
		expect(ipForConnId("2")).toBe("192.168.1.5");
	});

	test("dedups by first appearance, ignoring blanks and whitespace", () => {
		registerSrtlaIpList(["10.0.0.1", "", " 10.0.0.1 ", "10.0.0.2"]);
		expect(ipForConnId("0")).toBe("10.0.0.1");
		expect(ipForConnId("1")).toBe("10.0.0.2");
		expect(ipForConnId("2")).toBeUndefined();
	});

	test("SIGHUP reload keeps existing ids and mints monotonic ids for new IPs", () => {
		registerSrtlaIpList(["10.0.0.1", "10.0.0.2"]);
		// Drop .1, keep .2, add .3 — .2 keeps id 1, .3 gets the next id (2).
		registerSrtlaIpList(["10.0.0.2", "10.0.0.3"]);
		expect(ipForConnId("0")).toBeUndefined();
		expect(ipForConnId("1")).toBe("10.0.0.2");
		expect(ipForConnId("2")).toBe("10.0.0.3");
	});

	test("a re-added IP mints a fresh id (id is never reused)", () => {
		registerSrtlaIpList(["10.0.0.1"]);
		registerSrtlaIpList([]); // pruned
		registerSrtlaIpList(["10.0.0.1"]); // re-added
		expect(ipForConnId("0")).toBeUndefined();
		expect(ipForConnId("1")).toBe("10.0.0.1");
	});
});

describe("watch lifecycle + null propagation", () => {
	test("not running -> linkTelemetry is null", () => {
		expect(isLinkTelemetryActive()).toBe(false);
		expect(buildLinkTelemetry()).toBeNull();
	});

	test("startLinkTelemetry seeds the registry from the spawn-time IP list", () => {
		const w = captureWatch();
		setIfaceResolverForTest(() => undefined);
		startLinkTelemetry("/tmp/stats.json", ["10.0.0.1", "10.0.0.2"], {
			watch: w.watch,
		});
		expect(isLinkTelemetryActive()).toBe(true);
		expect(w.path).toBe("/tmp/stats.json");
		expect(ipForConnId("0")).toBe("10.0.0.1");
		expect(ipForConnId("1")).toBe("10.0.0.2");
	});

	test("running but no fresh snapshot yet -> null", () => {
		const w = captureWatch();
		setIfaceResolverForTest(() => undefined);
		startLinkTelemetry("/tmp/stats.json", [], { watch: w.watch });
		expect(buildLinkTelemetry()).toBeNull();
	});

	test("stop halts the watcher and reverts to null", () => {
		const w = captureWatch();
		setIfaceResolverForTest(() => undefined);
		startLinkTelemetry("/tmp/stats.json", ["10.0.0.1"], { watch: w.watch });
		w.emit(snapshot([{ conn_id: "0" }]));
		expect(buildLinkTelemetry()).not.toBeNull();
		stopLinkTelemetry();
		expect(w.stopped).toBe(1);
		expect(isLinkTelemetryActive()).toBe(false);
		expect(buildLinkTelemetry()).toBeNull();
		// Registry cleared on stop (process-restart id reset).
		expect(ipForConnId("0")).toBeUndefined();
	});
});

describe("ingestion + mapping + payload shape", () => {
	test("live snapshot maps conn_id to the correct iface name", () => {
		const w = captureWatch();
		const ipToIface: Record<string, string> = {
			"10.0.0.1": "usb0",
			"10.0.0.2": "wlan0",
		};
		setIfaceResolverForTest((ip) => ipToIface[ip]);
		startLinkTelemetry("/tmp/stats.json", ["10.0.0.1", "10.0.0.2"], {
			watch: w.watch,
		});

		w.emit(
			snapshot([
				{ conn_id: "0", rtt_ms: 12, nak_count: 3, weight_percent: 100 },
				{ conn_id: "1", rtt_ms: 0, nak_count: 0, weight_percent: 85 },
			]),
		);

		const payload = buildLinkTelemetry();
		expect(payload).not.toBeNull();
		expect(payload?.links).toHaveLength(2);
		expect(payload?.links[0]?.iface).toBe("usb0");
		expect(payload?.links[1]?.iface).toBe("wlan0");
	});

	test("every link carries the full required field set, stale=false when fresh", () => {
		const w = captureWatch();
		setIfaceResolverForTest(() => "usb0");
		startLinkTelemetry("/tmp/stats.json", ["10.0.0.1"], { watch: w.watch });
		w.emit(
			snapshot([
				{ conn_id: "0", rtt_ms: 5, nak_count: 2, bitrate_bps: 2_500_000 },
			]),
		);

		const link = buildLinkTelemetry()?.links[0];
		expect(link).toEqual({
			conn_id: "0",
			iface: "usb0",
			rtt_ms: 5,
			nak_count: 2,
			weight_percent: 100,
			bitrate_bps: 2_500_000,
			stale: false,
		});
	});

	test("unknown conn_id falls back to the raw IP, then a synthetic label", () => {
		const w = captureWatch();
		// No iface name for the known IP; an entirely unknown conn_id has no IP.
		setIfaceResolverForTest(() => undefined);
		startLinkTelemetry("/tmp/stats.json", ["10.0.0.1"], { watch: w.watch });
		w.emit(snapshot([{ conn_id: "0" }, { conn_id: "9" }]));

		const links = buildLinkTelemetry()?.links;
		expect(links?.[0]?.iface).toBe("10.0.0.1"); // known IP, no name
		expect(links?.[1]?.iface).toBe("link-9"); // unknown id, no IP
	});

	test("idle-but-running snapshot yields an empty link list (not null)", () => {
		const w = captureWatch();
		setIfaceResolverForTest(() => undefined);
		startLinkTelemetry("/tmp/stats.json", [], { watch: w.watch });
		w.emit(snapshot([]));
		const payload = buildLinkTelemetry();
		expect(payload?.links).toEqual([]);
		expect(typeof payload?.lastReadMs).toBe("number");
	});
});

describe("lastReadMs staleness clock (QW-H)", () => {
	test("advances on each fresh read and freezes when reads go null", () => {
		const w = captureWatch();
		setIfaceResolverForTest(() => "usb0");
		let clock = 1000;
		setTelemetryClockForTest(() => clock);
		startLinkTelemetry("/tmp/stats.json", ["10.0.0.1"], { watch: w.watch });

		clock = 1000;
		w.emit(snapshot([{ conn_id: "0" }]));
		const first = buildLinkTelemetry()?.lastReadMs;
		expect(first).toBe(1000);

		clock = 2000;
		w.emit(snapshot([{ conn_id: "0" }]));
		const second = buildLinkTelemetry()?.lastReadMs;
		expect(second).toBe(2000);
		expect(second).toBeGreaterThan(first as number);

		// Stats file deleted/stale -> watchTelemetry yields null. The clock must
		// freeze at the last successful read rather than advancing.
		clock = 3000;
		w.emit(null);
		const frozen = buildLinkTelemetry();
		expect(frozen?.lastReadMs).toBe(2000);
		expect(frozen?.links[0]?.stale).toBe(true);
	});

	test("resets to 0 on stop so a restarted watcher starts cold", () => {
		const w = captureWatch();
		setIfaceResolverForTest(() => "usb0");
		setTelemetryClockForTest(() => 5000);
		startLinkTelemetry("/tmp/stats.json", ["10.0.0.1"], { watch: w.watch });
		w.emit(snapshot([{ conn_id: "0" }]));
		expect(buildLinkTelemetry()?.lastReadMs).toBe(5000);

		stopLinkTelemetry();
		startLinkTelemetry("/tmp/stats.json", ["10.0.0.1"], { watch: w.watch });
		expect(buildLinkTelemetry()).toBeNull();
	});
});

describe("stale propagation", () => {
	test("a stale/absent tick flags cached links stale:true", () => {
		const w = captureWatch();
		setIfaceResolverForTest(() => "usb0");
		startLinkTelemetry("/tmp/stats.json", ["10.0.0.1"], { watch: w.watch });

		w.emit(snapshot([{ conn_id: "0", nak_count: 7 }]));
		expect(buildLinkTelemetry()?.links[0]?.stale).toBe(false);

		// watchTelemetry collapses absent/unparseable/stale reads to null.
		w.emit(null);
		const link = buildLinkTelemetry()?.links[0];
		expect(link?.stale).toBe(true);
		// Last-known values are retained while stale.
		expect(link?.nak_count).toBe(7);
		expect(link?.iface).toBe("usb0");
	});
});

// The live "bitrate" the operator reads used to be `engine_bitrate.applied_kbps`
// — the adaptive controller's own SETPOINT. Proven on a board: a steady 4100
// while the engine's watchdog logged "frames-not-advancing" and /proc/net/dev
// showed 48-85 kbps of SSH/WS traffic and no media at all. srtla_send has always
// published a real per-link measurement (ADR-001 `bitrate_bps`, wire bytes × 8)
// and this module silently discarded it. These tests pin that it now flows.
describe("measured wire bitrate (ADR-001 bitrate_bps)", () => {
	function liveWith(connections: Array<Record<string, number | string>>) {
		const w = captureWatch();
		setIfaceResolverForTest((ip) => (ip === "10.0.0.1" ? "usb0" : "wlan0"));
		startLinkTelemetry("/tmp/stats.json", ["10.0.0.1", "10.0.0.2"], {
			watch: w.watch,
		});
		w.emit(snapshot(connections));
		return w;
	}

	test("carries each link's measured bitrate through to the payload", () => {
		liveWith([
			{ conn_id: "0", bitrate_bps: 2_500_000 },
			{ conn_id: "1", bitrate_bps: 1_000_000 },
		]);

		const links = buildLinkTelemetry()?.links;
		expect(links?.[0]?.bitrate_bps).toBe(2_500_000);
		expect(links?.[1]?.bitrate_bps).toBe(1_000_000);
	});

	test("aggregates the bond total as the sum across links", () => {
		liveWith([
			{ conn_id: "0", bitrate_bps: 2_500_000 },
			{ conn_id: "1", bitrate_bps: 1_000_000 },
		]);

		expect(buildLinkTelemetry()?.measured_bps).toBe(3_500_000);
	});

	test("a bond carrying nothing measures ZERO — the setpoint's blind spot", () => {
		liveWith([
			{ conn_id: "0", bitrate_bps: 0 },
			{ conn_id: "1", bitrate_bps: 0 },
		]);

		const payload = buildLinkTelemetry();
		expect(payload?.measured_bps).toBe(0);
		expect(payload?.links.every((l) => l.bitrate_bps === 0)).toBe(true);
	});

	test("an unreadable link contributes 0 instead of NaN-ing the whole bond", () => {
		liveWith([
			{ conn_id: "0", bitrate_bps: Number.NaN },
			{ conn_id: "1", bitrate_bps: 1_000_000 },
		]);

		const payload = buildLinkTelemetry();
		expect(payload?.links[0]?.bitrate_bps).toBe(0);
		expect(payload?.measured_bps).toBe(1_000_000);
	});

	test("an idle-but-running bond reports a zero total, not an absent one", () => {
		const w = captureWatch();
		setIfaceResolverForTest(() => undefined);
		startLinkTelemetry("/tmp/stats.json", [], { watch: w.watch });
		w.emit(snapshot([]));

		expect(buildLinkTelemetry()?.measured_bps).toBe(0);
	});

	test("a stale tick retains the last measured values beside stale:true", () => {
		const w = liveWith([
			{ conn_id: "0", bitrate_bps: 2_000_000 },
			{ conn_id: "1", bitrate_bps: 500_000 },
		]);
		w.emit(null);

		const payload = buildLinkTelemetry();
		expect(payload?.measured_bps).toBe(2_500_000);
		expect(payload?.links.every((l) => l.stale)).toBe(true);
	});
});

describe("cumulative session bytes (srtla_send ADR-002 bytes_sent_total)", () => {
	function liveWith(
		connections: Array<Record<string, number | string>>,
		bondBytes?: number,
	) {
		const w = captureWatch();
		setIfaceResolverForTest((ip) => (ip === "10.0.0.1" ? "usb0" : "wlan0"));
		startLinkTelemetry("/tmp/stats.json", ["10.0.0.1", "10.0.0.2"], {
			watch: w.watch,
		});
		w.emit(snapshot(connections, bondBytes));
		return w;
	}

	test("forwards the per-link and bond counters as BYTES, with no x8", () => {
		liveWith(
			[
				{ conn_id: "0", bitrate_bps: 2_500_000, bytes_sent_total: 812_000_000 },
				{ conn_id: "1", bitrate_bps: 1_000_000, bytes_sent_total: 808_000_000 },
			],
			1_620_000_000,
		);

		const payload = buildLinkTelemetry();
		// The rate keeps its x8; the count beside it must not acquire one.
		expect(payload?.measured_bps).toBe(3_500_000);
		expect(payload?.links[0]?.bytes_sent_total).toBe(812_000_000);
		expect(payload?.links[1]?.bytes_sent_total).toBe(808_000_000);
		expect(payload?.bytes_sent_total).toBe(1_620_000_000);
	});

	test("the bond total is FORWARDED, never re-summed from the live links", () => {
		// The post-teardown state: a link the sender dropped is gone from
		// `connections` while its bytes stay banked in the bond counter. Summing
		// the survivors here would report a total that ran backwards.
		liveWith([{ conn_id: "0", bytes_sent_total: 100 }], 9_000);

		expect(buildLinkTelemetry()?.bytes_sent_total).toBe(9_000);
	});

	test("a sender predating ADR-002 leaves it UNKNOWN, never zero", () => {
		liveWith([
			{ conn_id: "0", bitrate_bps: 2_500_000 },
			{ conn_id: "1", bitrate_bps: 1_000_000 },
		]);

		const payload = buildLinkTelemetry();
		expect(payload?.bytes_sent_total).toBeUndefined();
		expect(payload?.links[0]?.bytes_sent_total).toBeUndefined();
		// The rest of the payload is unaffected — the change is additive.
		expect(payload?.measured_bps).toBe(3_500_000);
	});

	test("a malformed counter is refused at the PRODUCER, so it never reaches a row", () => {
		// This case used to be covered by a hand-rolled `asCumulativeBytes` guard in
		// `link-telemetry-rows.ts`, written when the field was believed unreadable
		// and therefore read off `unknown`. The field is typed and Zod-validated by
		// `@ceralive/srtla-send@2026.8.0` itself, so that guard was redundant and is
		// gone — but the GUARANTEE it encoded still has to hold, so the coverage
		// moves down to the boundary that now enforces it rather than being deleted.
		const malformed = [Number.NaN, -1, 1.5];
		for (const bytes of malformed) {
			expect(
				connectionTelemetrySchema.safeParse({
					conn_id: "0",
					rtt_ms: 0,
					nak_count: 0,
					weight_percent: 100,
					window: 1000,
					in_flight: 0,
					bitrate_bps: 0,
					bytes_sent_total: bytes,
				}).success,
			).toBe(false);
			expect(
				telemetrySchema.safeParse({
					last_updated_ms: Date.now(),
					connections: [],
					bytes_sent_total: bytes,
				}).success,
			).toBe(false);
		}

		// Non-vacuity: a WELL-FORMED counter parses and is forwarded verbatim.
		expect(
			connectionTelemetrySchema.safeParse({
				conn_id: "0",
				rtt_ms: 0,
				nak_count: 0,
				weight_percent: 100,
				window: 1000,
				in_flight: 0,
				bitrate_bps: 0,
				bytes_sent_total: 7,
			}).success,
		).toBe(true);
		liveWith([{ conn_id: "0", bytes_sent_total: 7 }], 7);
		expect(buildLinkTelemetry()?.links[0]?.bytes_sent_total).toBe(7);
	});

	test("a running-but-idle bond still reports what it already sent", () => {
		const w = captureWatch();
		setIfaceResolverForTest(() => undefined);
		startLinkTelemetry("/tmp/stats.json", [], { watch: w.watch });
		w.emit(snapshot([], 4_096));

		const payload = buildLinkTelemetry();
		expect(payload?.links).toHaveLength(0);
		expect(payload?.bytes_sent_total).toBe(4_096);
	});

	test("a stale tick keeps the last known total instead of dropping it", () => {
		const w = liveWith([{ conn_id: "0", bytes_sent_total: 500 }], 500);
		w.emit(null);

		const payload = buildLinkTelemetry();
		expect(payload?.bytes_sent_total).toBe(500);
		expect(payload?.links.every((l) => l.stale)).toBe(true);
	});

	test("a new stream starts the total over, never inheriting the last one", () => {
		liveWith([{ conn_id: "0", bytes_sent_total: 900 }], 900);
		expect(buildLinkTelemetry()?.bytes_sent_total).toBe(900);

		stopLinkTelemetry();
		expect(buildLinkTelemetry()).toBeNull();

		const w = captureWatch();
		startLinkTelemetry("/tmp/stats.json", ["10.0.0.1"], { watch: w.watch });
		w.emit(snapshot([{ conn_id: "0", bytes_sent_total: 12 }], 12));

		expect(buildLinkTelemetry()?.bytes_sent_total).toBe(12);
	});
});

describe("garbage input (corrupt stats file)", () => {
	test("a corrupt file leaves the backend alive; payload degrades to null/stale", async () => {
		const path = `/tmp/ceralive-link-telemetry-garbage-${process.pid}.json`;
		await Bun.write(path, "{ this is not valid json ::::");
		setIfaceResolverForTest(() => undefined);

		// Use the REAL watcher against the corrupt file; readTelemetry returns
		// null for unparseable input, so the backend must not throw.
		startLinkTelemetry(path, ["10.0.0.1"], { intervalMs: 500 });
		await Bun.sleep(50);

		expect(isLinkTelemetryActive()).toBe(true);
		// No prior fresh snapshot -> unavailable (null), never a crash.
		expect(buildLinkTelemetry()).toBeNull();

		// A fresh snapshot followed by a corrupt read surfaces as stale.
		ingestTelemetryForTest(snapshot([{ conn_id: "0" }]));
		ingestTelemetryForTest(null);
		expect(buildLinkTelemetry()?.links[0]?.stale).toBe(true);

		await Bun.file(path)
			.delete()
			.catch(() => {});
	});
});

describe("broadcastLinkTelemetryIfChanged — status flow integration", () => {
	function statusPayloads(raw: string[]) {
		return raw
			.map((line) => JSON.parse(line))
			.filter(
				(obj): obj is { status: { linkTelemetry: unknown } } =>
					!!obj && typeof obj === "object" && "status" in obj,
			)
			.map((obj) => obj.status);
	}

	test("emits a status message carrying linkTelemetry, only on change", () => {
		const sink: string[] = [];
		const client = captureClient(sink);
		addClient(client);
		try {
			const w = captureWatch();
			setIfaceResolverForTest(() => "usb0");
			startLinkTelemetry("/tmp/stats.json", ["10.0.0.1"], { watch: w.watch });

			w.emit(snapshot([{ conn_id: "0", nak_count: 1 }]));
			broadcastLinkTelemetryIfChanged();
			// Identical payload -> suppressed.
			broadcastLinkTelemetryIfChanged();
			// New value -> emitted again.
			w.emit(snapshot([{ conn_id: "0", nak_count: 2 }]));
			broadcastLinkTelemetryIfChanged();

			const statuses = statusPayloads(sink);
			expect(statuses).toHaveLength(2);
			const first = statuses[0]?.linkTelemetry as {
				links: Array<{ iface: string; nak_count: number }>;
			};
			expect(first.links[0]?.iface).toBe("usb0");
			expect(first.links[0]?.nak_count).toBe(1);
		} finally {
			removeClient(client);
		}
	});
});

describe("control-socket subscription cutover + airtight file-poll fallback", () => {
	test("subscription path broadcasts the same LinkTelemetryMessage shape as file-poll", async () => {
		const w = captureWatch();
		const fake = fakeControlClient({ capabilities: ["stats-subscription"] });
		setControlClientFactoryForTest(async () => fake.client);
		setIfaceResolverForTest(() => "usb0");

		startLinkTelemetry("/tmp/stats.json", ["10.0.0.1"], {
			watch: w.watch,
			controlSocket: "/tmp/srtla-send-control-9000.sock",
		});
		// Cutover confirmed live -> the redundant file-poll watcher is retired.
		await fake.subscribed;
		expect(w.stopped).toBe(1);
		expect(isLinkTelemetryActive()).toBe(true);

		fake.emit(
			snapshot([
				{ conn_id: "0", rtt_ms: 7, nak_count: 4, bitrate_bps: 1_800_000 },
			]),
		);
		const payload = buildLinkTelemetry();
		expect(payload?.links).toEqual([
			{
				conn_id: "0",
				iface: "usb0",
				rtt_ms: 7,
				nak_count: 4,
				weight_percent: 100,
				bitrate_bps: 1_800_000,
				stale: false,
			},
		]);
		expect(payload?.measured_bps).toBe(1_800_000);
		expect(typeof payload?.lastReadMs).toBe("number");
	});

	test("connect failure (factory returns null) leaves the file-poll running", async () => {
		const w = captureWatch();
		setControlClientFactoryForTest(async () => null);
		setIfaceResolverForTest(() => "usb0");

		startLinkTelemetry("/tmp/stats.json", ["10.0.0.1"], {
			watch: w.watch,
			controlSocket: "/tmp/srtla-send-control-9000.sock",
		});
		await flushCutover();

		// File-poll never stopped; telemetry still flows from the poll.
		expect(w.stopped).toBe(0);
		expect(isLinkTelemetryActive()).toBe(true);
		w.emit(snapshot([{ conn_id: "0", nak_count: 1 }]));
		expect(buildLinkTelemetry()?.links[0]?.nak_count).toBe(1);
	});

	test("capability absent (no stats-subscription) closes the client and stays on file-poll", async () => {
		const w = captureWatch();
		const fake = fakeControlClient({ capabilities: ["set-mode"] });
		setControlClientFactoryForTest(async () => fake.client);
		setIfaceResolverForTest(() => "usb0");

		startLinkTelemetry("/tmp/stats.json", ["10.0.0.1"], {
			watch: w.watch,
			controlSocket: "/tmp/srtla-send-control-9000.sock",
		});
		await flushCutover();

		expect(fake.closed).toBe(true);
		expect(w.stopped).toBe(0);
		expect(isLinkTelemetryActive()).toBe(true);
		w.emit(snapshot([{ conn_id: "0", nak_count: 2 }]));
		expect(buildLinkTelemetry()?.links[0]?.nak_count).toBe(2);
	});

	test("mid-stream subscription disconnect (onEvent null) re-arms the file-poll", async () => {
		const w = captureWatch();
		const fake = fakeControlClient({ capabilities: ["stats-subscription"] });
		setControlClientFactoryForTest(async () => fake.client);
		setIfaceResolverForTest(() => "usb0");

		startLinkTelemetry("/tmp/stats.json", ["10.0.0.1"], {
			watch: w.watch,
			controlSocket: "/tmp/srtla-send-control-9000.sock",
		});
		await fake.subscribed;
		expect(w.stopped).toBe(1);
		expect(w.count).toBe(1);

		fake.emit(snapshot([{ conn_id: "0", nak_count: 3 }]));
		expect(buildLinkTelemetry()?.links[0]?.stale).toBe(false);

		// Subscription drops -> a null event with no live watcher re-starts the poll.
		fake.emit(null);
		expect(w.count).toBe(2);
		expect(buildLinkTelemetry()?.links[0]?.stale).toBe(true);

		// The re-armed file-poll feeds fresh telemetry again.
		w.emit(snapshot([{ conn_id: "0", nak_count: 5 }]));
		const link = buildLinkTelemetry()?.links[0];
		expect(link?.stale).toBe(false);
		expect(link?.nak_count).toBe(5);
	});
});
