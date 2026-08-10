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
 * DDR-bus load, read from a memory-controller device under `/sys/class/devfreq`
 * through the collector filesystem seam (`./fs.ts`). Composed by
 * `device-stats.ts` — never inlined there, same as `collectors/memory.ts` and
 * `collectors/cpufreq.ts`.
 *
 * THE DEVICE IS PROBED, NOT KNOWN — THIS IS A HARDWARE-OPEN ITEM
 *
 *   Nothing here claims to know what the board calls its memory controller.
 *   devfreq device names come from the device tree, so the same SoC family can
 *   present `dmc`, `ff620000.dmc`, `ff630000.dfi`, or nothing at all depending
 *   on the kernel and the DT. This module therefore PROBES a candidate list
 *   (below) and reports whichever candidate actually answers. The exact node
 *   path, the `load` format it prints, and its update cadence are pending a
 *   capture on a real board — the bring-up runbook carries that capture step,
 *   and its result either confirms the list or extends it. Until then, treat
 *   every name below as a guess that the code is honest about.
 *
 * THE CANDIDATE LIST, EXACTLY
 *
 *   1. a device named `dmc` (case-insensitive exact match) — the vendor
 *      Rockchip name, checked FIRST so it wins whenever it exists;
 *   2. any device whose name CONTAINS `dmc` or `dfi`, case-insensitive
 *      (`ff620000.dmc`, `ff630000.dfi`, `dmc-noc`), in lexicographic order so
 *      the choice cannot depend on `readdir`'s arbitrary ordering.
 *
 *   Candidates are tried in that order and the FIRST one that answers all three
 *   nodes wins. A candidate with no vendor `load` node (the mainline shape) does
 *   not shadow a sibling that has one. Deliberately NOT matched: `*.gpu`,
 *   `*.npu` and every other devfreq device — they are real siblings in this
 *   directory and none of them is the DDR bus.
 *
 * WHY SYSFS AND NOT PERF EVENTS
 *
 *   The DDR PMU can be read through perf, and that is a different tool with a
 *   different cost: a privileged, per-counter, sampling interface whose event
 *   names are SoC-specific. This collector is a 5s tick that must not need
 *   elevated capabilities, so it reads only what devfreq already publishes as
 *   text. No perf event is opened, parsed, or depended on anywhere here.
 *
 * MAINLINE ABSENCE IS THE EXPECTED SHAPE, NOT A BUG
 *
 *   Upstream has no DMC devfreq driver for this SoC family, so a mainline/edge
 *   kernel has no matching device and this signal is simply OMITTED. That is
 *   the documented outcome for those images — an absent `ddr` key means "this
 *   kernel publishes no memory-controller device", never "the DDR bus is idle".
 *
 * UNITS
 *
 *   `loadPercent` is a percentage (0-100) — the `load` node's own unit.
 *   `curFreqHz` / `maxFreqHz` are Hz, devfreq's unit for `cur_freq` / `max_freq`
 *   (unlike cpufreq, which reports kHz). They are emitted unconverted; a MHz
 *   rendering is a display decision that belongs to the consumer.
 *
 * OMISSION vs ZERO
 *
 *   The reading is all-three-or-nothing: a device that answered only some of its
 *   nodes is dropped rather than half-reported, because a load with no frequency
 *   beside it invites the reader to assume a frequency. An absent tree, a tree
 *   with no candidate, and a candidate that answered nothing all omit the field
 *   entirely. A `0` that was genuinely read is kept — an idle bus is a
 *   measurement.
 */

import { logger } from "../../../helpers/logger.ts";
import type { CollectorFs } from "./fs.ts";

/** The kernel directory this collector enumerates. Absolute — resolved by the seam. */
export const DEVFREQ_DIR = "/sys/class/devfreq";

/** Vendor load percentage — the node whose presence makes a device usable here. */
const LOAD_NODE = "load";
/** Current operating frequency, in Hz. */
const CUR_FREQ_NODE = "cur_freq";
/** Frequency ceiling, in Hz. */
const MAX_FREQ_NODE = "max_freq";

/**
 * The exact device name checked first. HARDWARE-OPEN: this is the vendor name
 * we expect, not a name confirmed on a board.
 */
const PREFERRED_DEVICE = "dmc";

/**
 * Fallback name patterns, applied to the devfreq entry name (which is the DT
 * node id). `dmc` = dynamic memory controller, `dfi` = DDR PHY interface — the
 * two spellings Rockchip trees use for this block. HARDWARE-OPEN: extend this
 * list from a real capture, do not guess further.
 */
const DEVICE_PATTERNS: readonly RegExp[] = [/dmc/i, /dfi/i];

/**
 * `<percent>@<freq><unit>` — the documented vendor form of the `load` node, e.g.
 * `23@528000000Hz`. Only the percentage is used; the frequency after the `@` is
 * an echo of the frequency the load was measured at, and `cur_freq` is the
 * authoritative source for that.
 */
const LOAD_AT_FREQ = /^(\d+)@\d+[a-zA-Z]*Hz$/;

/** The other documented form: a bare integer percentage. */
const LOAD_BARE = /^(\d+)$/;

/** One memory-controller reading. All three fields, or the reading is dropped. */
export type DdrReading = {
	/** `load`, as a percentage of bus utilisation (0-100). */
	loadPercent: number;
	/** `cur_freq`, in Hz exactly as devfreq reports it. */
	curFreqHz: number;
	/** `max_freq`, in Hz exactly as devfreq reports it. */
	maxFreqHz: number;
};

/**
 * The DDR signal on the `device-stats` payload. Optional: absent means no
 * memory-controller device answered — the normal state on a mainline kernel.
 */
export type DdrStats = {
	ddr?: DdrReading;
};

/** One candidate's raw node contents; `undefined` where the read failed. */
export type DdrNodeRead = {
	load: string | undefined;
	cur: string | undefined;
	max: string | undefined;
};

/**
 * Reduce a `/sys/class/devfreq` listing to the memory-controller candidates
 * worth probing, in PROBE ORDER: the `dmc`-named device first, then every
 * dmc/dfi-patterned name in lexicographic order. Ordering is imposed here
 * precisely because `readdir` order is arbitrary — two boots of the same board
 * must probe the same device first.
 */
export function ddrCandidatesFromEntries(entries: readonly string[]): string[] {
	const preferred: string[] = [];
	const patterned: string[] = [];
	for (const entry of entries) {
		if (entry.toLowerCase() === PREFERRED_DEVICE) {
			preferred.push(entry);
			continue;
		}
		if (DEVICE_PATTERNS.some((pattern) => pattern.test(entry))) {
			patterned.push(entry);
		}
	}
	patterned.sort();
	return [...preferred, ...patterned];
}

/**
 * Parse a devfreq `load` node. BOTH documented forms are accepted — the vendor
 * `"N@FkHz"` form and a bare integer — and anything else is unparseable rather
 * than coerced. Values outside 0-100 are refused: whatever such a node meant, it
 * is not a percentage, and rendering it as one would draw a false bar.
 */
export function parseDevfreqLoad(text: string | undefined): number | undefined {
	if (text === undefined) return undefined;
	const trimmed = text.trim();
	const m = trimmed.match(LOAD_AT_FREQ) ?? trimmed.match(LOAD_BARE);
	if (m?.[1] === undefined) return undefined;
	const percent = Number.parseInt(m[1], 10);
	if (!Number.isFinite(percent) || percent > 100) return undefined;
	return percent;
}

/** Parse a one-integer sysfs node. Returns undefined for anything else. */
function parseHz(text: string | undefined): number | undefined {
	if (text === undefined) return undefined;
	const trimmed = text.trim();
	if (!/^\d+$/.test(trimmed)) return undefined;
	const value = Number.parseInt(trimmed, 10);
	return Number.isFinite(value) ? value : undefined;
}

/**
 * Reduce one candidate's raw node contents to a reading. Pure — the
 * all-three-or-nothing contract lives here and is testable with no filesystem.
 * `undefined` means "this candidate did not answer", which is what makes the
 * caller move on to the next one.
 */
export function ddrFromNodes(read: DdrNodeRead): DdrReading | undefined {
	const loadPercent = parseDevfreqLoad(read.load);
	const curFreqHz = parseHz(read.cur);
	const maxFreqHz = parseHz(read.max);
	if (
		loadPercent === undefined ||
		curFreqHz === undefined ||
		maxFreqHz === undefined
	) {
		return undefined;
	}
	return { loadPercent, curFreqHz, maxFreqHz };
}

/** Read a node, mapping any failure to `undefined` (the candidate is dropped later). */
async function readOptional(
	fs: CollectorFs,
	path: string,
): Promise<string | undefined> {
	try {
		return await fs.readText(path);
	} catch {
		// Expected: a devfreq device without the vendor `load` extension, or one
		// that went away between enumeration and read. The candidate fallthrough
		// below is the whole handling.
		return undefined;
	}
}

/**
 * Read + parse the DDR-bus load from the first devfreq candidate that answers.
 * Never throws: an absent or unreadable devfreq tree degrades to the empty shape
 * (field omitted) with a WARN, so the 5s tick that composes this collector
 * cannot be taken down by it.
 */
export async function collectDdr(
	fs: CollectorFs,
	dir: string = DEVFREQ_DIR,
): Promise<DdrStats> {
	let entries: string[];
	try {
		entries = await fs.readDir(dir);
	} catch (err) {
		// A mainline kernel has no devfreq class directory at all, so this is a
		// WARN and not an error: the tick is fine, the signal is simply absent.
		logger.warn("ddr: devfreq directory unreadable", { dir, err });
		return {};
	}

	for (const candidate of ddrCandidatesFromEntries(entries)) {
		const base = `${dir}/${candidate}`;
		const [load, cur, max] = await Promise.all([
			readOptional(fs, `${base}/${LOAD_NODE}`),
			readOptional(fs, `${base}/${CUR_FREQ_NODE}`),
			readOptional(fs, `${base}/${MAX_FREQ_NODE}`),
		]);
		const ddr = ddrFromNodes({ load, cur, max });
		if (ddr !== undefined) return { ddr };
	}
	// No candidate answered — the field is omitted, never zero-filled.
	return {};
}
