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
 * Device stats — exactly FIVE signals, broadcast on a 5s `device-stats` event.
 *
 * S1 lock: this module emits ONLY {disk, cpuLoad1, socTemp, ifaceRxTx, raucSlot}.
 * No per-core freq, GPU util, mem pressure, modem signal, swap, etc. Adding a
 * sixth field is a deliberate contract change, not a tweak.
 *
 * Design: every collector is a pure parse function over injected I/O
 * (`DeviceStatsDeps`), so the whole payload is unit-testable with no real
 * hardware. `collectDeviceStats` wraps each signal in its own try/catch and
 * degrades to `null` on any failure — a missing /sys path or an absent `rauc`
 * binary must never crash the sampling loop.
 *
 * socTemp is WIRED from sensors.ts (already broadcasting "SoC temperature" at
 * 1s) via `getSocTempRaw` — we do NOT read /sys/class/thermal a second time.
 */

import { execFileP } from "../../helpers/exec.ts";
import { logger } from "../../helpers/logger.ts";
import { ACTIVE_TO } from "../../helpers/shared.ts";
import { getms } from "../../helpers/time.ts";
import { DEVICE_STATS_EVENT } from "../../rpc/events.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
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
 * The complete device-stats payload. Keys are FROZEN by S1 — exactly five.
 * Every field is independently nullable: an unavailable source reports `null`
 * (or `"unavailable"` for raucSlot) rather than failing the whole tick.
 */
export type DeviceStatsPayload = {
	disk: DiskStat | null;
	cpuLoad1: number | null;
	socTemp: number | null;
	ifaceRxTx: IfaceRxTxStat | null;
	raucSlot: string;
};

/** Injected I/O surface — replaced wholesale in tests. */
export type DeviceStatsDeps = {
	/** Read a file as text (Bun.file().text() in production). */
	readText: (path: string) => Promise<string>;
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
	| "raucSlot";

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
 * Collect all five signals. Each is isolated: one failing source yields a null
 * (or "unavailable") field, never a thrown tick. socTemp is read from the
 * injected sensors value — there is no second /sys/class/thermal read here.
 */
export async function collectDeviceStats(
	deps: DeviceStatsDeps,
	state: DeviceStatsState,
): Promise<DeviceStatsPayload> {
	const [disk, cpuLoad1, ifaceRxTx, raucSlot] = await Promise.all([
		collectDisk(deps),
		collectCpuLoad1(deps),
		collectIfaceRxTx(deps, state),
		collectRaucSlot(deps),
	]);
	const socTemp = collectSocTemp(deps);
	const payload: DeviceStatsPayload = {
		disk,
		cpuLoad1,
		socTemp,
		ifaceRxTx,
		raucSlot,
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
	};
}

// ─── production wiring ───────────────────────────────────────────────────────

export const defaultDeviceStatsDeps: DeviceStatsDeps = {
	readText: (path) => Bun.file(path).text(),
	execFile: (file, args) => execFileP(file, args),
	getSocTempRaw: () => getSensors()[SOC_TEMP_SENSOR_KEY],
	now: () => Date.now(),
};

const deviceStatsState = createDeviceStatsState();

/**
 * Start the 5s `device-stats` broadcast loop. Mirrors the sensors/netif
 * pattern: an immediate first tick (after the baseline rx/tx sample lands)
 * then a fixed interval. Coalescing (5s window) lives in rpc/coalesce.ts.
 */
export function initDeviceStats(): void {
	const tick = async () => {
		try {
			const payload = await collectDeviceStats(
				defaultDeviceStatsDeps,
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
