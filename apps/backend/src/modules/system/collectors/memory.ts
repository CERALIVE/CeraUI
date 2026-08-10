/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2026 CeraLive project


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
 * Memory + swap, read from `/proc/meminfo` through the collector filesystem
 * seam (`./fs.ts`). Composed by `device-stats.ts`; never inlined there —
 * `sensors.ts`/`fan.ts` set that precedent and T4-T6's collectors follow it.
 *
 * WHY /proc/meminfo AND NOT `free`
 *
 *   `free` is a formatter over this exact file. Shelling out would add a binary
 *   to the backend's allow-list (`run.ts`), add a process spawn every 5s, and
 *   hand us a locale-dependent, column-shifting text table instead of a stable
 *   `Key: value kB` ABI. The file is the source; the tool is a view of it.
 *
 * UNITS
 *
 *   Every quantity this collector consumes is reported by the kernel in kB —
 *   which means KiB, 1024 bytes, not 1000 (fs/proc/meminfo.c uses
 *   `>> (10 - PAGE_SHIFT)`). It is converted ONCE, here, so nothing downstream
 *   ever has to know the file's unit: the emitted fields are named `…Bytes` and
 *   are bytes. A line carrying any OTHER unit is refused rather than assumed —
 *   a wrong unit is a wrong measurement, and there is no such kernel today.
 *
 * OMISSION vs ZERO — the whole point of the module
 *
 *   `SwapTotal: 0` on a swapless board is a MEASUREMENT: the board was asked and
 *   answered "none". It is emitted as `swapTotalBytes: 0`.
 *
 *   A line that is missing, unparseable, or wrongly-united was never measured.
 *   Its field is OMITTED — never coerced to 0, never NaN, never null-filled.
 *   Rendering an unmeasured value as zero is the same lie as rendering a
 *   busy/idle encoder core as 50 % (`encoder-load.ts`) or a 2-of-6 cooling level
 *   as 33 % (`fan.ts`): it fabricates a reading the hardware never produced.
 *
 *   The two cases are therefore distinguishable at every layer above: absent key
 *   ⇒ unknown, present zero ⇒ measured zero.
 *
 * DERIVED PERCENT
 *
 *   `memUsedPercent` = round((MemTotal − MemAvailable) / MemTotal × 100), clamped
 *   to 0-100. MemAvailable (not MemFree) is the denominator's counterpart on
 *   purpose: MemFree excludes reclaimable page cache, so a healthy Linux box
 *   reports it near zero and a MemFree-based percent reads as a permanent
 *   out-of-memory alarm. The percent is emitted ONLY when both inputs were
 *   measured and MemTotal > 0 — a zero total makes the ratio undefined, and an
 *   undefined ratio is omitted rather than shown as 0 %.
 */

import { logger } from "../../../helpers/logger.ts";
import type { CollectorFs } from "./fs.ts";

/** The kernel node this collector reads. Absolute — resolved by the seam. */
export const PROC_MEMINFO = "/proc/meminfo";

/** Bytes per meminfo "kB" — the file means KiB. */
const MEMINFO_UNIT_BYTES = 1024;

/**
 * Memory/swap signals on the `device-stats` payload. EVERY field is optional:
 * an absent field means "not measured", a present `0` means "measured zero".
 */
export type MemoryStats = {
	/** Total usable RAM (`MemTotal`), bytes. */
	memTotalBytes?: number;
	/** RAM available for new work without swapping (`MemAvailable`), bytes. */
	memAvailableBytes?: number;
	/** (MemTotal − MemAvailable) / MemTotal × 100, rounded, clamped 0-100. */
	memUsedPercent?: number;
	/** Total swap (`SwapTotal`), bytes. `0` on a swapless board is REAL. */
	swapTotalBytes?: number;
	/** Unused swap (`SwapFree`), bytes. */
	swapFreeBytes?: number;
};

/**
 * `Key:   <integer> kB` — the only line shape this collector accepts.
 *
 * Lines with no unit (`HugePages_Total: 0`) or a different unit are matched but
 * rejected below, so an unexpected unit can never be silently read as kB.
 */
const MEMINFO_LINE = /^(\w+):\s+(\d+)(?:\s+(\S+))?\s*$/;

/**
 * Parse `/proc/meminfo` into key → BYTES. Only kB-united integer lines are
 * kept; anything else (blank, unparseable, differently-united) is dropped, and
 * a dropped key is indistinguishable from one the kernel never printed — both
 * mean "not measured", which is exactly the intent.
 */
export function parseMeminfo(text: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const line of text.split("\n")) {
		const m = line.match(MEMINFO_LINE);
		if (m?.[1] === undefined || m[2] === undefined) continue;
		if (m[3] !== "kB") continue;
		const value = Number.parseInt(m[2], 10);
		if (!Number.isFinite(value)) continue;
		out.set(m[1], value * MEMINFO_UNIT_BYTES);
	}
	return out;
}

/** Clamp a derived percentage into the only range a percentage can occupy. */
function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

/**
 * Reduce a `/proc/meminfo` body to the emitted signals. Pure — the entire
 * omission-vs-zero contract lives here and is unit-testable without a
 * filesystem.
 */
export function memoryStatsFromMeminfo(text: string): MemoryStats {
	const fields = parseMeminfo(text);
	const stats: MemoryStats = {};

	const memTotal = fields.get("MemTotal");
	const memAvailable = fields.get("MemAvailable");
	if (memTotal !== undefined) stats.memTotalBytes = memTotal;
	if (memAvailable !== undefined) stats.memAvailableBytes = memAvailable;
	if (memTotal !== undefined && memAvailable !== undefined && memTotal > 0) {
		stats.memUsedPercent = clampPercent(
			Math.round(((memTotal - memAvailable) / memTotal) * 100),
		);
	}

	const swapTotal = fields.get("SwapTotal");
	const swapFree = fields.get("SwapFree");
	if (swapTotal !== undefined) stats.swapTotalBytes = swapTotal;
	if (swapFree !== undefined) stats.swapFreeBytes = swapFree;

	return stats;
}

/**
 * Read + parse the memory signals. Never throws: an unreadable `/proc/meminfo`
 * degrades to the empty set (every field omitted) with a WARN, so the 5s tick
 * that composes this collector cannot be taken down by it.
 */
export async function collectMemory(
	fs: CollectorFs,
	path: string = PROC_MEMINFO,
): Promise<MemoryStats> {
	try {
		return memoryStatsFromMeminfo(await fs.readText(path));
	} catch (err) {
		// A Linux box without /proc/meminfo is a real failure, not a board shape —
		// WARN so it surfaces, then omit rather than invent.
		logger.warn("memory: meminfo unreadable", { path, err });
		return {};
	}
}
