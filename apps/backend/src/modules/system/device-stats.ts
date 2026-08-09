/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project


    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
 * Device stats — the 5s `device-stats` broadcast.
 *
 * THE FIVE ALWAYS-PRESENT SIGNALS
 *
 *   {disk, cpuLoad1, socTemp, ifaceRxTx, raucSlot} are emitted on EVERY tick,
 *   each independently nullable. That set is still frozen: none of them may be
 *   removed, renamed, or made conditional.
 *
 * …PLUS DELIBERATELY ADDED OPTIONAL SIGNALS
 *
 *   The original S1 lock said this module emits those five and NOTHING else —
 *   "no per-core freq, GPU util, mem pressure, swap". Memory/swap is the first
 *   deliberate exception to that sentence, taken with eyes open: operators had
 *   no way to see memory pressure on a board that was visibly struggling, and
 *   the reading costs one `/proc/meminfo` read on a tick that already runs.
 *
 *   The exception is scoped, not a door left open. Added signals are OPTIONAL
 *   fields — present only when actually measured — so the five-key payload of an
 *   older device remains a valid payload, and every consumer keeps working
 *   without them. Adding one is still a contract change: it needs a schema
 *   update (`packages/rpc` system.schema.ts), a mock that flows through the real
 *   collector, and a deliberate update to the key-shape test — not a tweak.
 *
 *   OMIT vs ZERO is the rule that makes optional fields honest: a source we
 *   could not read is OMITTED, and a source that answered zero reports `0`. A
 *   swapless board really has `swapTotalBytes: 0`; a board whose /proc/meminfo
 *   was unreadable has no `swapTotalBytes` key at all. See collectors/memory.ts.
 *
 * DESIGN
 *
 *   Every collector is a pure parse function over injected I/O
 *   (`DeviceStatsDeps`), so the whole payload is unit-testable with no real
 *   hardware. `collectDeviceStats` wraps each signal in its own try/catch and
 *   degrades to `null` (or omission) on any failure — a missing /sys path or an
 *   absent `rauc` binary must never crash the sampling loop.
 *
 *   File reads go through the root-aware `CollectorFs` seam (collectors/fs.ts),
 *   whose production root is `/`; collectors that live in their own module
 *   (memory, and the cpufreq/DDR/GPU collectors that follow) receive that seam
 *   and nothing else.
 *
 *   socTemp is WIRED from sensors.ts (already broadcasting "SoC temperature" at
 *   1s) via `getSocTempRaw` — we do NOT read /sys/class/thermal a second time.
 */

import { execFileP } from "../../helpers/exec.ts";
import { logger } from "../../helpers/logger.ts";
import { ACTIVE_TO } from "../../helpers/shared.ts";
import { getms } from "../../helpers/time.ts";
import {
	getMockDeviceStatsDeps,
	shouldMockDeviceStats,
} from "../../mocks/providers/device-stats.ts";
import { DEVICE_STATS_EVENT } from "../../rpc/events.ts";
import { DEVICE_STATS_COLLECTOR_TIMEOUT_MS } from "../streaming/constants.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import { type CpuFreqStats, collectCpuFreq } from "./collectors/cpufreq.ts";
import { type CollectorFs, createCollectorFs } from "./collectors/fs.ts";
import { collectMemory, type MemoryStats } from "./collectors/memory.ts";
import { getSensors } from "./sensors.ts";

/** Broadcast cadence for the `device-stats` event. */
export const DEVICE_STATS_INTERVAL_MS = 5000;

/** Key under which sensors.ts publishes the SoC temperature string. */
const SOC_TEMP_SENSOR_KEY = "SoC temperature";

/** Filesystem whose usage we report. */
const DATA_MOUNT = "/data";

export type DiskType = "SSD" | "HDD" | "eMMC" | "unknown";

export type DiskStat = {
	/** Bytes used on the /data filesystem. */
	used: number;
	/** Total bytes on the /data filesystem. */
	total: number;
	/** Backing media classification. */
	type: DiskType;
};

export type IfaceRxTxStat = {
	/** Active interface name (e.g. "eth0"). */
	iface: string;
	/** Receive rate in bytes/second over the last sampling interval. */
	rxBytesPerSec: number;
	/** Transmit rate in bytes/second over the last sampling interval. */
	txBytesPerSec: number;
};

/**
 * The complete device-stats payload.
 *
 * The five ALWAYS-PRESENT keys are frozen and independently nullable: an
 * unavailable source reports `null` (or `"unavailable"` for raucSlot) rather
 * than failing the whole tick.
 *
 * The intersected collector types (`MemoryStats`, and the cpufreq/DDR/GPU
 * shapes that follow) contribute OPTIONAL keys — present only when measured.
 */
export type DeviceStatsPayload = {
	disk: DiskStat | null;
	cpuLoad1: number | null;
	socTemp: number | null;
	ifaceRxTx: IfaceRxTxStat | null;
	raucSlot: string;
} & MemoryStats &
	CpuFreqStats;

/**
 * Injected I/O surface — replaced wholesale in tests.
 *
 * `readText`/`readDir` are the shared root-aware collector seam
 * (`collectors/fs.ts`), so a module collector can be handed the deps object
 * itself and still see only the filesystem it is allowed to touch.
 */
export type DeviceStatsDeps = CollectorFs & {
	/** argv-only exec (execFileP in production — NO shell). */
	execFile: (
		file: string,
		args: readonly string[],
	) => Promise<{ stdout: string; stderr: string }>;
	/** Wire to sensors.ts SoC temperature — NOT a second thermal read. */
	getSocTempRaw: () => string | undefined;
	/** Monotonic-enough clock (ms) for the rx/tx rate delta. */
	now: () => number;
};

/** Cross-tick state: previous /proc/net/dev snapshot for the rate delta. */
export type DeviceStatsState = {
	prevNetDev?: { time: number; ifaces: Map<string, NetDevCounters> };
};

export function createDeviceStatsState(): DeviceStatsState {
	return {};
}

// ─── pure parsers (exported for tests) ──────────────────────────────────────

/** Parse `/proc/loadavg` → the 1-minute load average. */
export function parseLoadAvg(text: string): number | null {
	const first = text.trim().split(/\s+/)[0];
	if (first === undefined) return null;
	const n = Number.parseFloat(first);
	return Number.isFinite(n) ? n : null;
}

/** Parse sensors.ts "45.1 °C" → 45.1. Returns null when absent/unparseable. */
export function parseSocTemp(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const n = Number.parseFloat(raw);
	return Number.isFinite(n) ? n : null;
}

export type DfParsed = { used: number; total: number; source: string };

/**
 * Parse `df -B1 --output=used,size,source <mount>`:
 *
 *         Used         Size Source
 *   1234567890  10000000000 /dev/mmcblk0p2
 */
export function parseDfOutput(stdout: string): DfParsed | null {
	const lines = stdout.trim().split("\n");
	const data = lines[lines.length - 1];
	if (data === undefined) return null;
	const cols = data.trim().split(/\s+/);
	if (cols.length < 3) return null;
	const used = Number.parseInt(cols[0] ?? "", 10);
	const total = Number.parseInt(cols[1] ?? "", 10);
	const source = cols[2] ?? "";
	if (!Number.isFinite(used) || !Number.isFinite(total)) return null;
	return { used, total, source };
}

/**
 * Reduce a partition source (`/dev/mmcblk0p2`, `/dev/sda1`, `/dev/nvme0n1p3`)
 * to its parent block device name (`mmcblk0`, `sda`, `nvme0n1`) — the name
 * under /sys/block. Returns null for anything that is not a /dev/ node.
 */
export function blockDeviceFromSource(source: string): string | null {
	const dev = source.replace(/^\/dev\//, "");
	if (dev === source) return null; // not a /dev/ path (tmpfs, overlay, …)
	let m = dev.match(/^(nvme\d+n\d+)(p\d+)?$/);
	if (m?.[1]) return m[1];
	m = dev.match(/^(mmcblk\d+)(p\d+)?$/);
	if (m?.[1]) return m[1];
	m = dev.match(/^(sd[a-z]+)\d*$/);
	if (m?.[1]) return m[1];
	return dev;
}

/**
 * Classify backing media from the block device name + its
 * `queue/rotational` flag ("0" non-rotational, "1" spinning).
 */
export function classifyDiskType(
	blockDev: string | null,
	rotational: string | null,
): DiskType {
	if (blockDev === null) return "unknown";
	if (blockDev.startsWith("mmcblk")) return "eMMC";
	if (blockDev.startsWith("nvme")) return "SSD";
	if (rotational === null) return "unknown";
	const r = rotational.trim();
	if (r === "1") return "HDD";
	if (r === "0") return "SSD";
	return "unknown";
}

export type NetDevCounters = { rx: number; tx: number };

/**
 * Parse `/proc/net/dev` into per-interface rx/tx byte counters. Skips the two
 * header lines and the loopback interface.
 */
export function parseProcNetDev(text: string): Map<string, NetDevCounters> {
	const out = new Map<string, NetDevCounters>();
	for (const line of text.split("\n")) {
		const idx = line.indexOf(":");
		if (idx < 0) continue; // header / blank lines have no "iface:"
		const name = line.slice(0, idx).trim();
		if (name === "" || name === "lo") continue;
		const fields = line
			.slice(idx + 1)
			.trim()
			.split(/\s+/);
		// /proc/net/dev column layout: rx bytes is field 0, tx bytes is field 8.
		const rx = Number.parseInt(fields[0] ?? "", 10);
		const tx = Number.parseInt(fields[8] ?? "", 10);
		if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
		out.set(name, { rx, tx });
	}
	return out;
}

/**
 * Compute the rx/tx rate for the single most-active interface from two
 * /proc/net/dev snapshots. "Active" = the interface with the largest total
 * byte counter in the current snapshot (excluding lo, already filtered out).
 * Returns null when there is no positive elapsed time or no interface.
 */
export function computeIfaceRates(
	prev: Map<string, NetDevCounters>,
	cur: Map<string, NetDevCounters>,
	dtSec: number,
): IfaceRxTxStat | null {
	if (dtSec <= 0) return null;

	let bestIface: string | null = null;
	let bestTotal = -1;
	for (const [name, c] of cur) {
		const total = c.rx + c.tx;
		if (total > bestTotal) {
			bestTotal = total;
			bestIface = name;
		}
	}
	if (bestIface === null) return null;

	const curC = cur.get(bestIface);
	const prevC = prev.get(bestIface);
	if (!curC) return null;
	// New interface with no baseline → 0 rate this tick (not a crash).
	const rxDelta = prevC ? curC.rx - prevC.rx : 0;
	const txDelta = prevC ? curC.tx - prevC.tx : 0;
	return {
		iface: bestIface,
		// Counter resets (negative delta) clamp to 0.
		rxBytesPerSec: Math.max(0, Math.round(rxDelta / dtSec)),
		txBytesPerSec: Math.max(0, Math.round(txDelta / dtSec)),
	};
}

/**
 * Parse `rauc status --output-format=json` → the booted slot identifier.
 * Falls back to `boot_primary`. Returns null when neither is present.
 */
export function parseRaucSlot(stdout: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object") return null;
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.booted === "string" && obj.booted !== "") return obj.booted;
	if (typeof obj.boot_primary === "string" && obj.boot_primary !== "") {
		return obj.boot_primary;
	}
	return null;
}

// ─── degradation logging ────────────────────────────────────────────────────

/** Signal identifiers used in the degradation WARN + debug tick summary. */
type DeviceStatsSignal =
	| "disk"
	| "cpuLoad1"
	| "socTemp"
	| "ifaceRxTx"
	| "raucSlot"
	| "memory"
	| "cpuFreq";

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * A collector hit a real read/exec error and is degrading the signal to `null`.
 * WARN-level so silent hardware-read failures (missing /sys path, unreadable
 * /proc file, exec failure) surface even in production — distinct from the
 * EXPECTED null cases (first-sample baseline, rauc absent) which stay quiet.
 */
function warnDegraded(signal: DeviceStatsSignal, err: unknown): void {
	logger.warn("device-stats degraded", { signal, reason: errMessage(err) });
}

/**
 * Race one collector against a hard timeout. A hung hardware read (df, /proc,
 * rauc) degrades its single signal to `fallback` within `timeoutMs` so it can
 * never stall the whole 5s tick. The underlying read keeps running in the
 * background but its result is discarded — the tick already moved on.
 */
async function withCollectorTimeout<T>(
	signal: DeviceStatsSignal,
	fallback: T,
	run: () => Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((resolve) => {
		timer = setTimeout(() => {
			warnDegraded(
				signal,
				new Error(`collector timed out after ${timeoutMs}ms`),
			);
			resolve(fallback);
		}, timeoutMs);
	});
	try {
		return await Promise.race([run(), timeout]);
	} catch (err) {
		warnDegraded(signal, err);
		return fallback;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

// ─── per-signal collectors (each degrades to null/"unavailable") ─────────────

async function collectDisk(deps: DeviceStatsDeps): Promise<DiskStat | null> {
	try {
		const { stdout } = await deps.execFile("df", [
			"-B1",
			"--output=used,size,source",
			DATA_MOUNT,
		]);
		const df = parseDfOutput(stdout);
		if (!df) return null;

		const blockDev = blockDeviceFromSource(df.source);
		let rotational: string | null = null;
		if (blockDev) {
			try {
				rotational = await deps.readText(
					`/sys/block/${blockDev}/queue/rotational`,
				);
			} catch {
				// Missing rotational flag only loses the media classification (→
				// "unknown"); the disk signal itself is still valid, so no WARN.
				rotational = null;
			}
		}
		return {
			used: df.used,
			total: df.total,
			type: classifyDiskType(blockDev, rotational),
		};
	} catch (err) {
		warnDegraded("disk", err);
		return null;
	}
}

async function collectCpuLoad1(deps: DeviceStatsDeps): Promise<number | null> {
	try {
		return parseLoadAvg(await deps.readText("/proc/loadavg"));
	} catch (err) {
		warnDegraded("cpuLoad1", err);
		return null;
	}
}

/**
 * Read the SoC temperature from the injected sensors value (no second thermal
 * read). Synchronous, but wrapped so a throwing `getSocTempRaw` degrades the
 * single signal to `null` (with a WARN) instead of failing the whole tick.
 */
function collectSocTemp(deps: DeviceStatsDeps): number | null {
	try {
		return parseSocTemp(deps.getSocTempRaw());
	} catch (err) {
		warnDegraded("socTemp", err);
		return null;
	}
}

async function collectIfaceRxTx(
	deps: DeviceStatsDeps,
	state: DeviceStatsState,
): Promise<IfaceRxTxStat | null> {
	try {
		const now = deps.now();
		const ifaces = parseProcNetDev(await deps.readText("/proc/net/dev"));
		const prev = state.prevNetDev;
		state.prevNetDev = { time: now, ifaces };
		if (!prev) return null; // first sample establishes the baseline only
		return computeIfaceRates(prev.ifaces, ifaces, (now - prev.time) / 1000);
	} catch (err) {
		warnDegraded("ifaceRxTx", err);
		return null;
	}
}

/**
 * Memory/swap, from `collectors/memory.ts`. The module already degrades an
 * unreadable `/proc/meminfo` to "everything omitted", so this wrapper only
 * exists to keep the composition symmetrical with the other signals (and to
 * give `withCollectorTimeout` a fallback of the same shape).
 */
async function collectMemoryStats(deps: DeviceStatsDeps): Promise<MemoryStats> {
	try {
		return await collectMemory(deps);
	} catch (err) {
		warnDegraded("memory", err);
		return {};
	}
}

/**
 * Per-policy CPU frequency, from `collectors/cpufreq.ts`. Like the memory
 * wrapper this only keeps the composition symmetrical — the module already
 * degrades an absent cpufreq tree to "field omitted" on its own.
 */
async function collectCpuFreqStats(
	deps: DeviceStatsDeps,
): Promise<CpuFreqStats> {
	try {
		return await collectCpuFreq(deps);
	} catch (err) {
		warnDegraded("cpuFreq", err);
		return {};
	}
}

async function collectRaucSlot(deps: DeviceStatsDeps): Promise<string> {
	try {
		const { stdout } = await deps.execFile("rauc", [
			"status",
			"--output-format=json",
		]);
		return parseRaucSlot(stdout) ?? "unavailable";
	} catch {
		// rauc not installed / non-zero exit → graceful "unavailable".
		return "unavailable";
	}
}

/**
 * Collect every signal. Each is isolated: one failing source yields a null
 * (or "unavailable", or an omitted optional field), never a thrown tick.
 * socTemp is read from the injected sensors value — there is no second
 * /sys/class/thermal read here.
 */
export async function collectDeviceStats(
	deps: DeviceStatsDeps,
	state: DeviceStatsState,
	timeoutMs: number = DEVICE_STATS_COLLECTOR_TIMEOUT_MS,
): Promise<DeviceStatsPayload> {
	const [disk, cpuLoad1, ifaceRxTx, raucSlot, memory, cpuFreq] =
		await Promise.all([
			withCollectorTimeout("disk", null, () => collectDisk(deps), timeoutMs),
			withCollectorTimeout(
				"cpuLoad1",
				null,
				() => collectCpuLoad1(deps),
				timeoutMs,
			),
			withCollectorTimeout(
				"ifaceRxTx",
				null,
				() => collectIfaceRxTx(deps, state),
				timeoutMs,
			),
			withCollectorTimeout(
				"raucSlot",
				"unavailable",
				() => collectRaucSlot(deps),
				timeoutMs,
			),
			withCollectorTimeout<MemoryStats>(
				"memory",
				{},
				() => collectMemoryStats(deps),
				timeoutMs,
			),
			withCollectorTimeout<CpuFreqStats>(
				"cpuFreq",
				{},
				() => collectCpuFreqStats(deps),
				timeoutMs,
			),
		]);
	const socTemp = collectSocTemp(deps);
	const payload: DeviceStatsPayload = {
		disk,
		cpuLoad1,
		socTemp,
		ifaceRxTx,
		raucSlot,
		...memory,
		...cpuFreq,
	};
	logger.debug("device-stats tick", { signals: summarizeSignals(payload) });
	return payload;
}

type SignalState = "ok" | "null" | "unavailable";

function summarizeSignals(
	p: DeviceStatsPayload,
): Record<DeviceStatsSignal, SignalState> {
	return {
		disk: p.disk !== null ? "ok" : "null",
		cpuLoad1: p.cpuLoad1 !== null ? "ok" : "null",
		socTemp: p.socTemp !== null ? "ok" : "null",
		ifaceRxTx: p.ifaceRxTx !== null ? "ok" : "null",
		raucSlot: p.raucSlot === "unavailable" ? "unavailable" : "ok",
		// Optional signal: "null" here means "omitted from the payload".
		memory: p.memTotalBytes !== undefined ? "ok" : "null",
		cpuFreq: p.cpuFreq !== undefined ? "ok" : "null",
	};
}

// ─── production wiring ───────────────────────────────────────────────────────

export const defaultDeviceStatsDeps: DeviceStatsDeps = {
	...createCollectorFs(),
	execFile: (file, args) => execFileP(file, args),
	getSocTempRaw: () => getSensors()[SOC_TEMP_SENSOR_KEY],
	now: () => Date.now(),
};

const deviceStatsState = createDeviceStatsState();

// The mock deps are STATEFUL (a private rx/tx clock), so they are built once and
// reused across ticks rather than rebuilt each tick — a fresh instance would
// reset the clock and keep ifaceRxTx permanently at its baseline null.
let mockDeviceStatsDeps: DeviceStatsDeps | undefined;

/**
 * Select the collector deps for a tick. Under `shouldMockDeviceStats()` (the
 * dev/mock path) it returns the memoized mock deps so all five signals report
 * plausible fixture values; otherwise the real hardware deps. Resolved per tick
 * (not once at init) so it is robust to `initDeviceStats` running before the
 * mock service has initialized.
 */
export function resolveDeviceStatsDeps(): DeviceStatsDeps {
	if (shouldMockDeviceStats()) {
		mockDeviceStatsDeps ??= getMockDeviceStatsDeps();
		return mockDeviceStatsDeps;
	}
	return defaultDeviceStatsDeps;
}

/**
 * Start the 5s `device-stats` broadcast loop. Mirrors the sensors/netif
 * pattern: an immediate first tick (after the baseline rx/tx sample lands)
 * then a fixed interval. Coalescing (5s window) lives in rpc/coalesce.ts.
 */
export function initDeviceStats(): void {
	const tick = async () => {
		try {
			const payload = await collectDeviceStats(
				resolveDeviceStatsDeps(),
				deviceStatsState,
			);
			broadcastMsg(DEVICE_STATS_EVENT, payload, getms() - ACTIVE_TO);
		} catch (err) {
			logger.error(`device-stats tick failed: ${err}`);
		}
	};

	void tick();
	setInterval(tick, DEVICE_STATS_INTERVAL_MS);
}
