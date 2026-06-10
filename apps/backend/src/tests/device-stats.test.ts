/*
 * T32 — device-stats backend collectors (exactly FIVE signals).
 *
 * Proves the S1 lock (payload keys == {disk, cpuLoad1, socTemp, ifaceRxTx,
 * raucSlot}), that socTemp is WIRED from sensors.ts (no second
 * /sys/class/thermal read), and that every source degrades gracefully to
 * null / "unavailable" without crashing the tick.
 */
import { describe, expect, test } from "bun:test";

import {
	blockDeviceFromSource,
	classifyDiskType,
	collectDeviceStats,
	computeIfaceRates,
	createDeviceStatsState,
	type DeviceStatsDeps,
	type DeviceStatsState,
	parseDfOutput,
	parseLoadAvg,
	parseProcNetDev,
	parseRaucSlot,
	parseSocTemp,
} from "../modules/system/device-stats.ts";

// ─── deps stub ───────────────────────────────────────────────────────────────

type StubOpts = {
	files?: Record<string, string>;
	exec?: Record<string, { stdout: string; stderr?: string } | "throw">;
	socTemp?: string | undefined;
	now?: number;
};

function makeDeps(opts: StubOpts = {}): {
	deps: DeviceStatsDeps;
	readPaths: string[];
	execCalls: Array<{ file: string; args: readonly string[] }>;
} {
	const readPaths: string[] = [];
	const execCalls: Array<{ file: string; args: readonly string[] }> = [];
	const deps: DeviceStatsDeps = {
		readText: async (path) => {
			readPaths.push(path);
			const v = opts.files?.[path];
			if (v === undefined) throw new Error(`ENOENT: ${path}`);
			return v;
		},
		execFile: async (file, args) => {
			execCalls.push({ file, args });
			const entry = opts.exec?.[file];
			if (entry === undefined || entry === "throw") {
				throw new Error(`exec failed: ${file}`);
			}
			return { stdout: entry.stdout, stderr: entry.stderr ?? "" };
		},
		getSocTempRaw: () => opts.socTemp,
		now: () => opts.now ?? 1000,
	};
	return { deps, readPaths, execCalls };
}

const DF_OK =
	"        Used         Size Source\n   536870912  10737418240 /dev/mmcblk0p2\n";
const RAUC_OK = JSON.stringify({
	booted: "rootfs.0",
	boot_primary: "rootfs.0",
});
const NETDEV = (rx: number, tx: number) =>
	`Inter-|   Receive                                                |  Transmit\n` +
	` face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets\n` +
	`    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0\n` +
	`  eth0: ${rx} 100 0 0 0 0 0 0 ${tx} 100 0 0 0 0 0 0\n`;

// ─── pure parsers ─────────────────────────────────────────────────────────────

describe("device-stats pure parsers", () => {
	test("parseLoadAvg: first field of /proc/loadavg", () => {
		expect(parseLoadAvg("0.52 0.48 0.40 1/234 5678\n")).toBe(0.52);
		expect(parseLoadAvg("garbage")).toBeNull();
	});

	test("parseSocTemp: '45.1 °C' → 45.1; undefined → null", () => {
		expect(parseSocTemp("45.1 °C")).toBe(45.1);
		expect(parseSocTemp(undefined)).toBeNull();
		expect(parseSocTemp("n/a")).toBeNull();
	});

	test("parseDfOutput: used/size/source from -B1 output", () => {
		expect(parseDfOutput(DF_OK)).toEqual({
			used: 536870912,
			total: 10737418240,
			source: "/dev/mmcblk0p2",
		});
		expect(parseDfOutput("Used Size Source\n")).toBeNull();
	});

	test("blockDeviceFromSource: partition → parent block device", () => {
		expect(blockDeviceFromSource("/dev/mmcblk0p2")).toBe("mmcblk0");
		expect(blockDeviceFromSource("/dev/sda1")).toBe("sda");
		expect(blockDeviceFromSource("/dev/nvme0n1p3")).toBe("nvme0n1");
		expect(blockDeviceFromSource("tmpfs")).toBeNull();
	});

	test("classifyDiskType: media class from name + rotational flag", () => {
		expect(classifyDiskType("mmcblk0", "0")).toBe("eMMC");
		expect(classifyDiskType("nvme0n1", null)).toBe("SSD");
		expect(classifyDiskType("sda", "1")).toBe("HDD");
		expect(classifyDiskType("sda", "0")).toBe("SSD");
		expect(classifyDiskType("sda", null)).toBe("unknown");
		expect(classifyDiskType(null, "0")).toBe("unknown");
	});

	test("parseProcNetDev: per-iface rx/tx, skips lo + headers", () => {
		const m = parseProcNetDev(NETDEV(2000, 3000));
		expect(m.has("lo")).toBe(false);
		expect(m.get("eth0")).toEqual({ rx: 2000, tx: 3000 });
	});

	test("computeIfaceRates: bytes/sec delta on the most-active iface", () => {
		const prev = parseProcNetDev(NETDEV(1000, 1000));
		const cur = parseProcNetDev(NETDEV(3000, 5000));
		expect(computeIfaceRates(prev, cur, 2)).toEqual({
			iface: "eth0",
			rxBytesPerSec: 1000,
			txBytesPerSec: 2000,
		});
	});

	test("computeIfaceRates: counter reset clamps to 0; dt<=0 → null", () => {
		const prev = parseProcNetDev(NETDEV(9000, 9000));
		const cur = parseProcNetDev(NETDEV(10, 10));
		expect(computeIfaceRates(prev, cur, 2)).toEqual({
			iface: "eth0",
			rxBytesPerSec: 0,
			txBytesPerSec: 0,
		});
		expect(computeIfaceRates(prev, cur, 0)).toBeNull();
	});

	test("parseRaucSlot: booted slot; invalid JSON → null", () => {
		expect(parseRaucSlot(RAUC_OK)).toBe("rootfs.0");
		expect(parseRaucSlot('{"boot_primary":"rootfs.1"}')).toBe("rootfs.1");
		expect(parseRaucSlot("not json")).toBeNull();
		expect(parseRaucSlot("{}")).toBeNull();
	});
});

// ─── S1 lock + happy path ─────────────────────────────────────────────────────

describe("collectDeviceStats — S1 lock (exactly five keys)", () => {
	test("payload keys are EXACTLY {disk, cpuLoad1, socTemp, ifaceRxTx, raucSlot}", async () => {
		const mk = (rx: number, tx: number, now: number) =>
			makeDeps({
				files: {
					"/proc/loadavg": "1.25 0.9 0.7 1/100 42\n",
					"/proc/net/dev": NETDEV(rx, tx),
					"/sys/block/mmcblk0/queue/rotational": "0\n",
				},
				exec: { df: { stdout: DF_OK }, rauc: { stdout: RAUC_OK } },
				socTemp: "48.3 °C",
				now,
			}).deps;
		const state = createDeviceStatsState();
		await collectDeviceStats(mk(5000, 6000, 1000), state); // baseline sample
		const payload = await collectDeviceStats(mk(7000, 9000, 3000), state);

		expect(Object.keys(payload).sort()).toEqual(
			["cpuLoad1", "disk", "ifaceRxTx", "raucSlot", "socTemp"].sort(),
		);
		expect(payload.disk).toEqual({
			used: 536870912,
			total: 10737418240,
			type: "eMMC",
		});
		expect(payload.cpuLoad1).toBe(1.25);
		expect(payload.socTemp).toBe(48.3);
		expect(payload.ifaceRxTx?.iface).toBe("eth0");
		expect(payload.raucSlot).toBe("rootfs.0");
	});

	test("socTemp is WIRED from sensors.ts — no /sys/class/thermal read", async () => {
		const { deps, readPaths } = makeDeps({
			files: {
				"/proc/loadavg": "0.1 0.1 0.1 1/1 1\n",
				"/proc/net/dev": NETDEV(1, 1),
				"/sys/block/mmcblk0/queue/rotational": "0\n",
			},
			exec: { df: { stdout: DF_OK }, rauc: { stdout: RAUC_OK } },
			socTemp: "42.0 °C",
		});
		const payload = await collectDeviceStats(deps, createDeviceStatsState());

		expect(payload.socTemp).toBe(42.0);
		// The collector must NEVER touch the thermal sysfs — sensors.ts owns it.
		expect(readPaths.some((p) => p.includes("/sys/class/thermal"))).toBe(false);
	});

	test("first tick establishes the rx/tx baseline (ifaceRxTx null), second yields a rate", async () => {
		const state: DeviceStatsState = createDeviceStatsState();
		const mk = (rx: number, tx: number, now: number) =>
			makeDeps({
				files: {
					"/proc/loadavg": "0.1 0 0 1/1 1\n",
					"/proc/net/dev": NETDEV(rx, tx),
					"/sys/block/mmcblk0/queue/rotational": "0\n",
				},
				exec: { df: { stdout: DF_OK }, rauc: { stdout: RAUC_OK } },
				socTemp: "40 °C",
				now,
			}).deps;

		const first = await collectDeviceStats(mk(1000, 1000, 1000), state);
		expect(first.ifaceRxTx).toBeNull();
		const second = await collectDeviceStats(mk(3000, 7000, 3000), state);
		expect(second.ifaceRxTx).toEqual({
			iface: "eth0",
			rxBytesPerSec: 1000,
			txBytesPerSec: 3000,
		});
	});
});

// ─── negative: graceful degradation ────────────────────────────────────────────

describe("collectDeviceStats — graceful degradation (no crash)", () => {
	test("all sources unavailable → nulls + 'unavailable', keys intact, no throw", async () => {
		// Nothing stubbed: every readText/execFile rejects, sensors empty.
		const { deps } = makeDeps({ socTemp: undefined });
		let payload!: Awaited<ReturnType<typeof collectDeviceStats>>;
		await expect(
			(async () => {
				payload = await collectDeviceStats(deps, createDeviceStatsState());
			})(),
		).resolves.toBeUndefined();

		expect(Object.keys(payload).sort()).toEqual(
			["cpuLoad1", "disk", "ifaceRxTx", "raucSlot", "socTemp"].sort(),
		);
		expect(payload.disk).toBeNull();
		expect(payload.cpuLoad1).toBeNull();
		expect(payload.socTemp).toBeNull();
		expect(payload.ifaceRxTx).toBeNull();
		expect(payload.raucSlot).toBe("unavailable");
	});

	test("rauc binary absent → raucSlot 'unavailable', other signals still collected", async () => {
		const { deps } = makeDeps({
			files: {
				"/proc/loadavg": "0.7 0.5 0.3 1/1 1\n",
				"/proc/net/dev": NETDEV(1, 1),
				"/sys/block/mmcblk0/queue/rotational": "0\n",
			},
			exec: { df: { stdout: DF_OK }, rauc: "throw" },
			socTemp: "50 °C",
		});
		const payload = await collectDeviceStats(deps, createDeviceStatsState());
		expect(payload.raucSlot).toBe("unavailable");
		expect(payload.cpuLoad1).toBe(0.7);
		expect(payload.disk?.type).toBe("eMMC");
	});

	test("missing /sys rotational path → disk still reported, type 'unknown'", async () => {
		const { deps } = makeDeps({
			files: { "/proc/loadavg": "0.1 0 0 1/1 1\n" },
			// df returns an SSD-candidate device but rotational sysfs is absent.
			exec: {
				df: {
					stdout: "        Used         Size Source\n   100  200 /dev/sda1\n",
				},
				rauc: { stdout: RAUC_OK },
			},
			socTemp: undefined,
		});
		const payload = await collectDeviceStats(deps, createDeviceStatsState());
		expect(payload.disk).toEqual({ used: 100, total: 200, type: "unknown" });
	});
});
