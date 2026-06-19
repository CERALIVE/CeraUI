/*
 * Backend perf/stability quick wins (Todo 1).
 *
 * Locks the four behaviours added in
 * `fix(backend): jitter intervals, collector timeouts, prune dead clients,
 * log swallowed errors`:
 *
 *   1. periodic intervals carry ±10% jitter (de-correlate the fleet),
 *   2. a hung/slow device-stats collector degrades to null within the timeout
 *      instead of stalling the whole tick,
 *   3. a throwing collector keeps the tick alive and logs,
 *   4. the link-telemetry iface resolver retries on failure and logs before
 *      falling back,
 *   plus the seqCounters cap and stale-client pruning.
 *
 * Logger assertions use a temporary in-memory Winston transport on the shared
 * logger singleton (same technique as loop-visibility.test.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import winston from "winston";

import { logger } from "../helpers/logger.ts";
import {
	applyJitter,
	PERIODIC_JITTER_FRACTION,
} from "../modules/streaming/constants.ts";
import {
	loadDefaultIfaceResolverWithRetry,
	setResolverLoaderForTest,
} from "../modules/streaming/link-telemetry.ts";
import {
	collectDeviceStats,
	createDeviceStatsState,
	type DeviceStatsDeps,
} from "../modules/system/device-stats.ts";
import {
	addClient,
	advanceSeq,
	pruneStaleClients,
	removeClient,
	SEQ_COUNTERS_MAX_SIZE,
} from "../rpc/events.ts";
import { HEARTBEAT_INTERVAL_MS } from "../rpc/heartbeat.ts";
import type { AppWebSocket } from "../rpc/types.ts";

interface CapturedRecord {
	level: string;
	message: string;
	[key: string]: unknown;
}

const flush = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 15));

async function withCapture(
	level: string,
	run: (records: CapturedRecord[]) => Promise<void>,
): Promise<void> {
	const records: CapturedRecord[] = [];
	const capture = winston.format((info) => {
		records.push({ ...info } as unknown as CapturedRecord);
		return info;
	});
	const transport = new winston.transports.Stream({
		stream: new Writable({
			write(_chunk, _enc, cb) {
				cb();
			},
		}),
		level,
		format: capture(),
	});
	logger.add(transport);
	try {
		await run(records);
	} finally {
		logger.remove(transport);
	}
}

// ─── 1. jitter ───────────────────────────────────────────────────────────────

describe("applyJitter", () => {
	test("the heartbeat interval stays within ±10% — [4.5s, 5.5s]", () => {
		const lo = HEARTBEAT_INTERVAL_MS * (1 - PERIODIC_JITTER_FRACTION);
		const hi = HEARTBEAT_INTERVAL_MS * (1 + PERIODIC_JITTER_FRACTION);
		expect(lo).toBe(4500);
		expect(hi).toBe(5500);
		for (let i = 0; i < 10_000; i++) {
			const v = applyJitter(HEARTBEAT_INTERVAL_MS);
			expect(v).toBeGreaterThanOrEqual(lo);
			expect(v).toBeLessThan(hi);
		}
	});

	test("rand extremes hit the exact bounds; rand=0.5 is the base", () => {
		expect(applyJitter(5000, 0.1, () => 0)).toBe(4500);
		expect(applyJitter(5000, 0.1, () => 0.5)).toBe(5000);
		// rand() is [0,1); the upper bound is approached but never reached.
		expect(applyJitter(5000, 0.1, () => 0.999_999)).toBeLessThan(5500);
		expect(applyJitter(5000, 0.1, () => 0.999_999)).toBeGreaterThan(5499);
	});

	test("fraction 0 disables jitter", () => {
		expect(applyJitter(5000, 0, () => 0)).toBe(5000);
		expect(applyJitter(5000, 0, () => 0.99)).toBe(5000);
	});
});

// ─── 2 + 3. device-stats per-collector timeout ───────────────────────────────

const NETDEV =
	"Inter-|   Receive                                                |  Transmit\n" +
	" face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets\n" +
	"  eth0: 1000 100 0 0 0 0 0 0 500 100 0 0 0 0 0 0\n";

function healthyDeps(
	overrides: Partial<DeviceStatsDeps> = {},
): DeviceStatsDeps {
	return {
		readText: async (path) => {
			if (path === "/proc/loadavg") return "0.50 0.40 0.30 1/200 1234\n";
			if (path === "/proc/net/dev") return NETDEV;
			if (path.startsWith("/sys/block/")) return "0\n";
			throw new Error(`unexpected readText: ${path}`);
		},
		execFile: async (file) => {
			if (file === "df") {
				return {
					stdout: "        Used         Size Source\n   100  200 /dev/sda1\n",
					stderr: "",
				};
			}
			if (file === "rauc") {
				return { stdout: JSON.stringify({ booted: "rootfs.0" }), stderr: "" };
			}
			throw new Error(`unexpected execFile: ${file}`);
		},
		getSocTempRaw: () => "45.1 °C",
		now: () => 1000,
		...overrides,
	};
}

describe("device-stats per-collector timeout", () => {
	test("a collector that never resolves does not delay the tick (degrades to null)", async () => {
		await withCapture("warn", async (records) => {
			const deps = healthyDeps({
				// `df` hangs forever — stands in for the 3s slow-collector case.
				execFile: (file) => {
					if (file === "rauc") {
						return Promise.resolve({
							stdout: JSON.stringify({ booted: "rootfs.0" }),
							stderr: "",
						});
					}
					return new Promise(() => {}); // never settles
				},
			});

			const started = Date.now();
			const payload = await collectDeviceStats(
				deps,
				createDeviceStatsState(),
				40, // tiny timeout so the test never waits 3s
			);
			const elapsed = Date.now() - started;

			// The tick returned promptly despite the hung `df`.
			expect(elapsed).toBeLessThan(1000);
			// The hung signal degraded to null; the others still populated.
			expect(payload.disk).toBeNull();
			expect(payload.cpuLoad1).toBe(0.5);
			expect(payload.raucSlot).toBe("rootfs.0");

			await flush();
			const warn = records.find(
				(r) => r.message === "device-stats degraded" && r.signal === "disk",
			);
			expect(warn).toBeDefined();
			expect(String(warn?.reason)).toContain("timed out");
		});
	});

	test("a throwing collector keeps the tick alive and logs a WARN", async () => {
		await withCapture("warn", async (records) => {
			const deps = healthyDeps({
				readText: async (path) => {
					if (path === "/proc/loadavg") throw new Error("ENOENT loadavg");
					if (path === "/proc/net/dev") return NETDEV;
					if (path.startsWith("/sys/block/")) return "0\n";
					throw new Error(`unexpected readText: ${path}`);
				},
			});

			const payload = await collectDeviceStats(
				deps,
				createDeviceStatsState(),
				1000,
			);

			// Loop alive: cpuLoad1 degraded to null, every other signal intact.
			expect(payload.cpuLoad1).toBeNull();
			expect(payload.disk).not.toBeNull();
			expect(payload.raucSlot).toBe("rootfs.0");

			await flush();
			const warn = records.find(
				(r) => r.message === "device-stats degraded" && r.signal === "cpuLoad1",
			);
			expect(warn?.level).toBe("warn");
		});
	});
});

// ─── 4. link-telemetry iface resolver retry ──────────────────────────────────

describe("loadDefaultIfaceResolverWithRetry", () => {
	afterEach(() => {
		setResolverLoaderForTest(null);
	});

	test("retries every attempt, logs each failure at debug, then warns once", async () => {
		let attempts = 0;
		setResolverLoaderForTest(() => {
			attempts++;
			return Promise.reject(new Error("network module unavailable"));
		});

		await withCapture("debug", async (records) => {
			const ok = await loadDefaultIfaceResolverWithRetry(3, 1, async () => {});
			expect(ok).toBe(false);
			expect(attempts).toBe(3); // exhausted all retries

			await flush();
			const debugs = records.filter(
				(r) => r.message === "link-telemetry: iface resolver load failed",
			);
			expect(debugs.length).toBe(3); // logged before each suppression
			const warn = records.find((r) =>
				r.message.startsWith("link-telemetry: iface resolver unavailable"),
			);
			expect(warn?.level).toBe("warn");
		});
	});

	test("a later attempt succeeding stops the retry loop", async () => {
		let attempts = 0;
		setResolverLoaderForTest(() => {
			attempts++;
			if (attempts < 2) {
				return Promise.reject(new Error("transient"));
			}
			return Promise.resolve(() => "eth0");
		});

		const ok = await loadDefaultIfaceResolverWithRetry(5, 1, async () => {});
		expect(ok).toBe(true);
		expect(attempts).toBe(2); // stopped as soon as it succeeded
	});
});

// ─── seqCounters cap ─────────────────────────────────────────────────────────

describe("advanceSeq capacity bound", () => {
	test("never grows past SEQ_COUNTERS_MAX_SIZE; evicts the oldest type", () => {
		const map = new Map<string, number>();
		for (let i = 0; i < SEQ_COUNTERS_MAX_SIZE + 10; i++) {
			advanceSeq(map, `type-${i}`);
		}
		expect(map.size).toBe(SEQ_COUNTERS_MAX_SIZE);
		// The earliest-inserted types were evicted.
		expect(map.has("type-0")).toBe(false);
		expect(map.has(`type-${SEQ_COUNTERS_MAX_SIZE + 9}`)).toBe(true);
	});

	test("an already-tracked type stays monotonic and is never evicted", () => {
		const map = new Map<string, number>();
		expect(advanceSeq(map, "status")).toBe(1);
		expect(advanceSeq(map, "status")).toBe(2);
		// Fill past capacity with fresh types; "status" keeps advancing.
		for (let i = 0; i < SEQ_COUNTERS_MAX_SIZE + 5; i++) {
			advanceSeq(map, `type-${i}`);
			advanceSeq(map, "status");
		}
		expect(map.has("status")).toBe(true);
		expect(map.size).toBeLessThanOrEqual(SEQ_COUNTERS_MAX_SIZE);
	});
});

// ─── stale-client pruning ────────────────────────────────────────────────────

function makeClient(lastActive: number): {
	ws: AppWebSocket;
	closed: () => boolean;
} {
	let wasClosed = false;
	const ws = {
		data: { isAuthenticated: true, lastActive },
		close: () => {
			wasClosed = true;
		},
	} as unknown as AppWebSocket;
	return { ws, closed: () => wasClosed };
}

describe("pruneStaleClients", () => {
	test("drops + closes clients past the staleness threshold, keeps fresh ones", () => {
		const now = 100_000;
		const stale = makeClient(now - 20_000); // older than 15s
		const fresh = makeClient(now - 1_000); // within window
		addClient(stale.ws);
		addClient(fresh.ws);
		try {
			const pruned = pruneStaleClients(15_000, now);
			expect(pruned).toBe(1);
			expect(stale.closed()).toBe(true);
			expect(fresh.closed()).toBe(false);
		} finally {
			removeClient(stale.ws);
			removeClient(fresh.ws);
		}
	});

	test("a client exactly at the threshold is kept (strict >)", () => {
		const now = 100_000;
		const edge = makeClient(now - 15_000);
		addClient(edge.ws);
		try {
			expect(pruneStaleClients(15_000, now)).toBe(0);
			expect(edge.closed()).toBe(false);
		} finally {
			removeClient(edge.ws);
		}
	});
});
