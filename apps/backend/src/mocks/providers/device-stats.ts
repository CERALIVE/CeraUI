/*
	CeraUI - Device-Stats Mock Provider (T3 — ceraui-experience-hardening)

	Dev/emulated-mode stand-in for the `device-stats` collector deps — the five
	always-present signals plus the optional memory/swap, per-policy CPU
	frequency, and DDR-bus fields.

	On a dev box (no Rockchip hardware, no `rauc` binary, empty sensors map) the
	production `defaultDeviceStatsDeps` degrade almost every signal to `null`:

	  - `disk`      — `df /data` usually works, but the media type + the /data
	                  mount are the dev host's, not a device's;
	  - `raucSlot`  — `rauc` is absent → "unavailable";
	  - `socTemp`   — CRITICAL: the dev sensors path only `broadcastMsg("sensors",
	                  data)` (sensors.ts) and NEVER writes the module-global
	                  `sensors` map that `getSocTempRaw` → `getSensors()["SoC
	                  temperature"]` reads, so `socTemp` is ALWAYS `null` in mock
	                  mode. This provider therefore supplies socTemp DIRECTLY as a
	                  fixture value (NOT via the sensors broadcast).

	This provider builds a `DeviceStatsDeps` double whose raw command / file
	outputs are SERIALIZED from the single Zod-validated {@link MOCK_DEVICE_STATS}
	fixture, so the REAL collectors + parsers in `device-stats.ts` reduce them
	back to exactly the fixture — the mock exercises the same parse path a real
	device would rather than short-circuiting `collectDeviceStats`.

	The `device-stats.ts` seam (`resolveDeviceStatsDeps`) selects these deps
	INTERNALLY under `shouldMockDeviceStats()`; `initDeviceStats()` stays
	parameterless. Gated by `shouldUseMocks()` — a no-op (never selected) in
	production.
*/

import { CPUFREQ_DIR } from "../../modules/system/collectors/cpufreq.ts";
import { DEVFREQ_DIR } from "../../modules/system/collectors/ddr.ts";
import type { DeviceStatsDeps } from "../../modules/system/device-stats.ts";
import type { MockDeviceStats } from "../mock-schemas.ts";
import { shouldUseMocks } from "../mock-service.ts";

/** 1 GiB in bytes — keeps the disk fixture readable. */
const GIB = 1024 ** 3;

/**
 * Plausible device-stats fixture — EVERY signal populated (no nulls, no
 * omissions: a mock that omitted a field would be claiming it is unmeasurable
 * on this host, and dev mode must exercise every rendered element). Zod
 * validated by `mockDeviceStatsSchema` in `validateMockFixtures()` (mock-schemas.ts).
 * This is the single source of truth: {@link getMockDeviceStatsDeps} serializes
 * each field into the raw output its collector parses, so the emitted payload
 * equals this fixture (with `ifaceRxTx` populated from the second tick onward —
 * the first tick is the rx/tx baseline, exactly as on a real device).
 */
export const MOCK_DEVICE_STATS = {
	disk: { used: 40 * GIB, total: 128 * GIB, type: "SSD" },
	cpuLoad1: 0.42,
	socTemp: 52.0,
	ifaceRxTx: {
		iface: "eth0",
		rxBytesPerSec: 1_250_000,
		txBytesPerSec: 640_000,
	},
	raucSlot: "A",
	memTotalBytes: 8 * GIB,
	memAvailableBytes: 6 * GIB,
	// Not an independent fixture value — the collector DERIVES this from the two
	// above ((8 − 6) / 8 × 100), so a wrong figure here fails the mock round-trip
	// test rather than silently shipping a mock that disagrees with production.
	memUsedPercent: 25,
	swapTotalBytes: 2 * GIB,
	swapFreeBytes: 2 * GIB,
	// An RK3588-shaped cpufreq tree: one policy per cluster boundary. The ids are
	// the sysfs directory names the provider writes back out, nothing more.
	cpuFreq: [
		{ id: "policy0", curKhz: 1_008_000, maxKhz: 1_800_000 },
		{ id: "policy4", curKhz: 1_416_000, maxKhz: 2_400_000 },
		{ id: "policy6", curKhz: 2_016_000, maxKhz: 2_400_000 },
	],
	// DDR bus at 528 MHz against a 1.56 GHz ceiling. Hz here, unlike cpuFreq's
	// kHz — the two collectors report the unit their sysfs class uses.
	ddr: { loadPercent: 37, curFreqHz: 528_000_000, maxFreqHz: 1_560_000_000 },
} satisfies MockDeviceStats;

// ─── raw-output serializers (fixture → the bytes each real collector parses) ──

/** Map a fixture disk media type to a representative `df` source device node. */
function diskSourceForType(type: MockDeviceStats["disk"]["type"]): string {
	switch (type) {
		case "eMMC":
			return "/dev/mmcblk0p2";
		case "SSD":
			return "/dev/nvme0n1p2";
		case "HDD":
			return "/dev/sda1";
		default:
			return "/dev/sda1";
	}
}

/** The `/sys/block/<dev>/queue/rotational` flag a media type implies ("1" spinning). */
function rotationalForType(type: MockDeviceStats["disk"]["type"]): string {
	return type === "HDD" ? "1\n" : "0\n";
}

/** Reproduce `df -B1 --output=used,size,source /data` for the disk fixture. */
function buildDfOutput(disk: MockDeviceStats["disk"]): string {
	const source = diskSourceForType(disk.type);
	return `        Used         Size Source\n  ${disk.used} ${disk.total} ${source}\n`;
}

/** Reproduce `rauc status --output-format=json` for the booted-slot fixture. */
function buildRaucOutput(slot: string): string {
	return JSON.stringify({ booted: slot, boot_primary: slot });
}

/**
 * Reproduce a `/proc/meminfo` body for the memory fixture, so the REAL
 * `collectMemory` parser reduces it back to exactly those fields — including
 * the derived `memUsedPercent`, which is never written into the file.
 *
 * Values go out in the kernel's own unit (kB meaning KiB); `MemFree` is emitted
 * alongside `MemAvailable` purely so the fixture looks like a real file (the
 * collector deliberately ignores it — see collectors/memory.ts).
 */
function buildMeminfo(stats: MockDeviceStats): string {
	const kib = (bytes: number) => bytes / 1024;
	return (
		`MemTotal:       ${kib(stats.memTotalBytes)} kB\n` +
		`MemFree:        ${kib(stats.memAvailableBytes / 2)} kB\n` +
		`MemAvailable:   ${kib(stats.memAvailableBytes)} kB\n` +
		`SwapTotal:      ${kib(stats.swapTotalBytes)} kB\n` +
		`SwapFree:       ${kib(stats.swapFreeBytes)} kB\n`
	);
}

/**
 * Reproduce the `/sys/devices/system/cpu/cpufreq/policy*` tree for the cpufreq
 * fixture — one integer-bearing file per node, exactly as the kernel exposes
 * them (kHz, trailing newline) — so the REAL `collectCpuFreq` enumerates and
 * parses it back into the fixture rows.
 */
function buildCpuFreq(policies: MockDeviceStats["cpuFreq"]): {
	dir: string[];
	files: Map<string, string>;
} {
	const files = new Map<string, string>();
	for (const policy of policies) {
		files.set(
			`${CPUFREQ_DIR}/${policy.id}/scaling_cur_freq`,
			`${policy.curKhz}\n`,
		);
		files.set(
			`${CPUFREQ_DIR}/${policy.id}/cpuinfo_max_freq`,
			`${policy.maxKhz}\n`,
		);
	}
	// `boost` is a real sibling of the policy directories on many kernels — it is
	// listed so the collector's enumeration filter is exercised, not bypassed.
	return { dir: [...policies.map((p) => p.id), "boost"], files };
}

/**
 * Reproduce a `/sys/class/devfreq` memory-controller device for the DDR fixture,
 * so the REAL `collectDdr` probes and parses it back into the fixture reading.
 *
 * The device is called `dmc` because that is the FIRST candidate the collector
 * probes — not because a board has been observed using that name (the node name
 * is a hardware-open question; see collectors/ddr.ts). `load` is written in the
 * vendor `"N@FkHz"` form so the mock exercises that parse branch rather than the
 * simpler bare-integer one, and a GPU devfreq device is listed alongside it so
 * the candidate filter is exercised instead of bypassed.
 */
function buildDdr(ddr: MockDeviceStats["ddr"]): {
	dir: string[];
	files: Map<string, string>;
} {
	const device = "dmc";
	const files = new Map<string, string>([
		[
			`${DEVFREQ_DIR}/${device}/load`,
			`${ddr.loadPercent}@${ddr.curFreqHz}Hz\n`,
		],
		[`${DEVFREQ_DIR}/${device}/cur_freq`, `${ddr.curFreqHz}\n`],
		[`${DEVFREQ_DIR}/${device}/max_freq`, `${ddr.maxFreqHz}\n`],
	]);
	return { dir: [device, "fb000000.gpu"], files };
}

/** Reproduce a single-interface `/proc/net/dev` snapshot (rx field 0, tx field 8). */
function buildNetDev(iface: string, rx: number, tx: number): string {
	return (
		"Inter-|   Receive                                                |  Transmit\n" +
		" face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets\n" +
		"    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0\n" +
		`  ${iface}: ${rx} 100 0 0 0 0 0 0 ${tx} 100 0 0 0 0 0 0\n`
	);
}

// A fixed positive epoch base + a per-tick step for the deterministic mock
// clock. The rx/tx counters are `rate × now_seconds`, so the collector's
// `delta / dt` reduces EXACTLY to the fixture rate regardless of the step
// value — the step only has to be positive so `dt > 0` on the second tick.
const CLOCK_BASE_MS = 1_700_000_000_000;
const CLOCK_STEP_MS = 5_000;

/**
 * Build a `DeviceStatsDeps` double seeded from {@link MOCK_DEVICE_STATS}. Fed to
 * the REAL `collectDeviceStats`, it yields the fixture payload:
 *
 *   - `disk` / `cpuLoad1` / `raucSlot` / `socTemp` are stable every tick;
 *   - `ifaceRxTx` is `null` on the FIRST tick (rx/tx baseline) then the exact
 *     fixture rate on every subsequent tick — the counters advance on a private
 *     monotonic clock so the derived rate is deterministic without depending on
 *     real wall-clock elapsed time between ticks.
 *
 * The returned object is STATEFUL (its clock advances per netdev read), so the
 * caller must build it ONCE and reuse it across ticks (the seam memoizes it).
 */
export function getMockDeviceStatsDeps(): DeviceStatsDeps {
	const { disk, cpuLoad1, socTemp, ifaceRxTx, raucSlot } = MOCK_DEVICE_STATS;
	const dfOutput = buildDfOutput(disk);
	const raucOutput = buildRaucOutput(raucSlot);
	const rotational = rotationalForType(disk.type);
	const meminfo = buildMeminfo(MOCK_DEVICE_STATS);
	const cpufreq = buildCpuFreq(MOCK_DEVICE_STATS.cpuFreq);
	const ddr = buildDdr(MOCK_DEVICE_STATS.ddr);

	// One tick counter, advanced only by the netdev read. `now()` reads the
	// current tick's time BEFORE the read increments it, so the snapshot time and
	// its counters share the same logical instant within a collectDeviceStats call.
	let tick = 0;
	const clockAt = (t: number): number => CLOCK_BASE_MS + t * CLOCK_STEP_MS;

	return {
		readText: async (path) => {
			if (path === "/proc/loadavg") {
				return `${cpuLoad1.toFixed(2)} 0.35 0.30 1/210 4242\n`;
			}
			if (path === "/proc/net/dev") {
				const nowMs = clockAt(tick);
				const rx = Math.round((ifaceRxTx.rxBytesPerSec * nowMs) / 1000);
				const tx = Math.round((ifaceRxTx.txBytesPerSec * nowMs) / 1000);
				const out = buildNetDev(ifaceRxTx.iface, rx, tx);
				tick += 1;
				return out;
			}
			if (path === "/proc/meminfo") {
				return meminfo;
			}
			const sysfsNode = cpufreq.files.get(path) ?? ddr.files.get(path);
			if (sysfsNode !== undefined) {
				return sysfsNode;
			}
			if (path.startsWith("/sys/block/")) {
				return rotational;
			}
			throw new Error(`mock device-stats: unexpected readText(${path})`);
		},
		// Only the trees this fixture serves are enumerable. Every other path
		// REJECTS — the honest answer for a host with no such tree, where an
		// empty listing would instead claim the directory exists and is empty.
		readDir: async (path) => {
			if (path === CPUFREQ_DIR) {
				return cpufreq.dir;
			}
			if (path === DEVFREQ_DIR) {
				return ddr.dir;
			}
			throw new Error(`mock device-stats: unexpected readDir(${path})`);
		},
		execFile: async (file) => {
			if (file === "df") return { stdout: dfOutput, stderr: "" };
			if (file === "rauc") return { stdout: raucOutput, stderr: "" };
			throw new Error(`mock device-stats: unexpected execFile(${file})`);
		},
		// Direct fixture — the sensors broadcast never populates getSensors() in
		// mock mode, so socTemp cannot be sourced through the normal wire here.
		getSocTempRaw: () => `${socTemp.toFixed(1)} °C`,
		now: () => clockAt(tick),
	};
}

/**
 * Whether the device-stats loop should run against {@link getMockDeviceStatsDeps}
 * instead of the real hardware collectors. Mirrors `shouldMockSensors()` — true
 * only on the dev/mock path (`shouldUseMocks()`), never in production.
 */
export function shouldMockDeviceStats(): boolean {
	return shouldUseMocks();
}
