import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
	Telemetry,
	TelemetryUpdate,
	watchTelemetry as WatchTelemetryFn,
} from "@ceralive/srtla-send/telemetry";
import {
	broadcastLinkTelemetryIfChanged,
	buildLinkTelemetry,
	ingestTelemetryForTest,
	ipForConnId,
	isLinkTelemetryActive,
	registerSrtlaIpList,
	resetLinkTelemetryBroadcastState,
	setIfaceResolverForTest,
	setTelemetryClockForTest,
	startLinkTelemetry,
	stopLinkTelemetry,
} from "../modules/streaming/link-telemetry.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";

function snapshot(
	connections: Array<Partial<Telemetry["connections"][number]>>,
): Telemetry {
	return {
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
	};
}

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
	resetLinkTelemetryBroadcastState();
});

afterEach(() => {
	stopLinkTelemetry();
	setIfaceResolverForTest(null);
	setTelemetryClockForTest(null);
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
		w.emit(snapshot([{ conn_id: "0", rtt_ms: 5, nak_count: 2 }]));

		const link = buildLinkTelemetry()?.links[0];
		expect(link).toEqual({
			conn_id: "0",
			iface: "usb0",
			rtt_ms: 5,
			nak_count: 2,
			weight_percent: 100,
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
