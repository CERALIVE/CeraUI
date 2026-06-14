/*
 * Task 12 — loop visibility.
 *
 * The 5s loops (heartbeat, device-stats broadcast, event broadcast) used to be
 * silent on success and swallow hardware-read failures. These tests prove the
 * opt-in observability contract:
 *   - a device-stats tick emits a debug collected-signal summary,
 *   - a collector that degrades to null on a real error emits a WARN naming the
 *     signal (silent /sys / /proc read failures become visible),
 *   - at the default production level (warn) the per-tick debug lines are gone.
 *
 * Capture is done with a temporary in-memory Winston transport added to the
 * shared logger singleton; its own `level` is the gate under test (debug vs
 * warn), so we exercise the real level filtering rather than a stub.
 */
import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import winston from "winston";

import { logger } from "../helpers/logger.ts";
import {
	collectDeviceStats,
	createDeviceStatsState,
	type DeviceStatsDeps,
} from "../modules/system/device-stats.ts";
import { broadcast } from "../rpc/events.ts";
import { startHeartbeat, stopHeartbeat } from "../rpc/heartbeat.ts";

interface CapturedRecord {
	level: string;
	message: string;
	[key: string]: unknown;
}

// Winston delivers to piped transports on a later tick — settle before asserting.
const flush = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 15));

// A Stream transport carries its own `level`, so winston applies the real
// level filter before our capturing format runs — exactly the gate under test.
// The sink is a no-op writable; the capturing format records each accepted info.
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

describe("loop visibility — device-stats", () => {
	test("at debug, a tick logs a collected-signal summary", async () => {
		await withCapture("debug", async (records) => {
			await collectDeviceStats(healthyDeps(), createDeviceStatsState());
			await flush();

			const tick = records.find((r) => r.message === "device-stats tick");
			expect(tick).toBeDefined();
			const signals = tick?.signals as Record<string, string>;
			expect(Object.keys(signals).sort()).toEqual(
				["cpuLoad1", "disk", "ifaceRxTx", "raucSlot", "socTemp"].sort(),
			);
			expect(signals.disk).toBe("ok");
			expect(signals.cpuLoad1).toBe("ok");
			expect(signals.socTemp).toBe("ok");
		});
	});

	test("a forced collector failure logs a WARN naming the signal", async () => {
		await withCapture("warn", async (records) => {
			const deps = healthyDeps({
				readText: async (path) => {
					if (path === "/proc/loadavg") {
						throw new Error("ENOENT: /proc/loadavg");
					}
					if (path === "/proc/net/dev") return NETDEV;
					if (path.startsWith("/sys/block/")) return "0\n";
					throw new Error(`unexpected readText: ${path}`);
				},
			});
			await collectDeviceStats(deps, createDeviceStatsState());
			await flush();

			const warn = records.find(
				(r) => r.message === "device-stats degraded" && r.signal === "cpuLoad1",
			);
			expect(warn).toBeDefined();
			expect(warn?.level).toBe("warn");
			expect(typeof warn?.reason).toBe("string");
		});
	});

	test("at default prod level (warn) a healthy tick logs no per-tick lines", async () => {
		await withCapture("warn", async (records) => {
			await collectDeviceStats(healthyDeps(), createDeviceStatsState());
			await flush();

			expect(
				records.find((r) => r.message === "device-stats tick"),
			).toBeUndefined();
			expect(records).toHaveLength(0);
		});
	});
});

describe("loop visibility — heartbeat + broadcast", () => {
	test("at debug, the heartbeat tick logs its cadence count", async () => {
		await withCapture("debug", async (records) => {
			startHeartbeat(10);
			try {
				await new Promise((resolve) => setTimeout(resolve, 45));
			} finally {
				stopHeartbeat();
			}
			await flush();

			const ticks = records.filter((r) => r.message === "heartbeat tick");
			expect(ticks.length).toBeGreaterThan(0);
			expect(typeof ticks[0]?.tick).toBe("number");
		});
	});

	test("at debug, a broadcast logs the event name and client count", async () => {
		await withCapture("debug", async (records) => {
			broadcast("loop-visibility-probe", { n: 1 });
			await flush();

			const entry = records.find(
				(r) => r.message === "broadcast" && r.event === "loop-visibility-probe",
			);
			expect(entry).toBeDefined();
			expect(entry?.clients).toBe(0);
		});
	});

	test("at default prod level (warn) a broadcast logs no per-tick line", async () => {
		await withCapture("warn", async (records) => {
			broadcast("loop-visibility-probe-2", { n: 2 });
			await flush();

			expect(records.find((r) => r.message === "broadcast")).toBeUndefined();
		});
	});
});
