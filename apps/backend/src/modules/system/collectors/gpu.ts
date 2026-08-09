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
 * GPU load, read through the collector filesystem seam (`./fs.ts`). Composed by
 * `device-stats.ts` — never inlined there, same as `collectors/memory.ts`,
 * `collectors/cpufreq.ts` and `collectors/ddr.ts`.
 *
 * TWO KERNELS, TWO INTERFACES — HENCE A DUAL-PATH PROBE
 *
 *   There is no single place a Linux board publishes GPU utilisation. The two
 *   shapes this collector knows about come from the two driver stacks an RK3588
 *   image can run:
 *
 *     (a) the ARM `kbase` vendor driver, which registers a misc device (`mali0`)
 *         and hangs a plain percentage file off it;
 *     (b) the mainline `panthor`/`lima`-era stack, where the GPU appears as an
 *         ordinary devfreq device (`/sys/class/devfreq/*.gpu`) and — if the
 *         vendor `load` extension is present — publishes a load node beside its
 *         frequencies.
 *
 *   They are probed in that order: (a) first, because a board carrying kbase is
 *   a board whose devfreq GPU entry may exist but publish no `load` at all. The
 *   two paths do NOT carry the same fields, which is exactly why the order is
 *   observable: (a) yields a percentage and nothing else, while (b) can also
 *   report the current and maximum frequency.
 *
 * NEITHER PATH IS CONFIRMED ON HARDWARE — THIS IS A HARDWARE-OPEN ITEM
 *
 *   Nothing here claims to know what a board actually publishes. The kbase
 *   candidate list below is a set of SPELLINGS seen across vendor trees, not
 *   paths verified on a CeraLive device, and the devfreq GPU device name comes
 *   from the device tree. The exact node, the format it prints, and its update
 *   cadence are all pending a capture on a real board — the bring-up runbook
 *   carries that capture step, and its result either confirms the list or
 *   extends it. Until then, treat every path below as a guess the code is
 *   honest about: an unrecognised node is skipped, never guessed at.
 *
 * WHAT IS DELIBERATELY NOT HERE: PER-PROCESS `fdinfo`
 *
 *   Modern DRM drivers expose per-client engine time under
 *   `/proc/<pid>/fdinfo/<fd>` (`drm-engine-*`), and a system-wide figure can be
 *   derived by walking every process and aggregating. That is a FUTURE source,
 *   not this one: it costs a full `/proc` walk on a 5s tick, it needs per-process
 *   read access, and the numbers are cumulative nanoseconds that only become a
 *   percentage after a cross-tick delta. It is recorded here so the next reader
 *   knows the omission is a decision rather than an oversight.
 *
 * UNITS
 *
 *   `loadPercent` is a percentage (0-100) — both nodes' own unit.
 *   `curFreqHz` / `maxFreqHz` are Hz, devfreq's unit for `cur_freq` / `max_freq`
 *   (unlike cpufreq, which reports kHz). They are emitted unconverted.
 *
 * OMISSION vs ZERO
 *
 *   `loadPercent` carries the reading: no path answered it means the whole `gpu`
 *   field is OMITTED. It is never zero-filled — a fabricated 0 % would read as
 *   "the GPU is idle", which is a measurement this collector did not make. The
 *   two frequencies are INDEPENDENTLY optional: the kbase path structurally
 *   cannot report them, so a load with no frequency beside it is the normal
 *   shape here rather than a half-reading (this is where the GPU differs from
 *   `collectors/ddr.ts`, whose reading is all-three-or-nothing). A `0` that was
 *   genuinely read is kept — an idle GPU is a measurement.
 */

import { logger } from "../../../helpers/logger.ts";
import { DEVFREQ_DIR, parseDevfreqLoad } from "./ddr.ts";
import type { CollectorFs } from "./fs.ts";

/**
 * Mali `kbase` utilisation nodes, in PROBE ORDER. All absolute — resolved by the
 * seam. HARDWARE-OPEN: these are the spellings vendor trees have used, not paths
 * confirmed on a board. The device is the misc device `mali0`, whose `device`
 * link points at the platform GPU node, so one prefix covers every board that
 * registers the driver at all.
 */
export const KBASE_UTILISATION_CANDIDATES: readonly string[] = [
	// The British spelling the ARM/Rockchip kbase trees use.
	"/sys/class/misc/mali0/device/utilisation",
	// The American spelling some forks ship instead.
	"/sys/class/misc/mali0/device/utilization",
	// A third spelling seen where the node was renamed to say what it holds.
	"/sys/class/misc/mali0/device/gpu_busy_percent",
];

/** Vendor load percentage on a devfreq GPU device. */
const LOAD_NODE = "load";
/** Current operating frequency, in Hz. */
const CUR_FREQ_NODE = "cur_freq";
/** Frequency ceiling, in Hz. */
const MAX_FREQ_NODE = "max_freq";

/**
 * The devfreq entry-name shape a GPU takes: a DT node id ending in `.gpu`
 * (`fb000000.gpu`). Anchored at the end on purpose — `gpu-thermal` and
 * `mali-gpu0` are not devfreq GPUs, and a bare `contains` filter would claim
 * them.
 */
const DEVFREQ_GPU_SUFFIX = /\.gpu$/i;

/** A bare integer percentage — the kbase node's documented form. */
const KBASE_PERCENT = /^(\d+)$/;

/**
 * One GPU reading. `loadPercent` is the reading itself; the frequencies are
 * present only when the answering path published them (the kbase path cannot).
 */
export type GpuReading = {
	/** GPU utilisation as a percentage (0-100). */
	loadPercent: number;
	/** `cur_freq`, in Hz exactly as devfreq reports it. devfreq path only. */
	curFreqHz?: number;
	/** `max_freq`, in Hz exactly as devfreq reports it. devfreq path only. */
	maxFreqHz?: number;
};

/**
 * The GPU signal on the `device-stats` payload. Optional: absent means neither
 * probe path answered, which is the normal state on a kernel that publishes no
 * GPU load interface at all.
 */
export type GpuStats = {
	gpu?: GpuReading;
};

/** One devfreq candidate's raw node contents; `undefined` where the read failed. */
export type GpuDevfreqNodeRead = {
	load: string | undefined;
	cur: string | undefined;
	max: string | undefined;
};

/**
 * Reduce a `/sys/class/devfreq` listing to the GPU candidates worth probing,
 * sorted lexicographically. Ordering is imposed here precisely because `readdir`
 * order is arbitrary — two boots of the same board must probe the same device
 * first. `dmc`/`dfi` (the DDR bus, see `collectors/ddr.ts`) and `*.npu` are real
 * siblings in this directory and are deliberately never candidates.
 */
export function gpuCandidatesFromEntries(entries: readonly string[]): string[] {
	return entries.filter((entry) => DEVFREQ_GPU_SUFFIX.test(entry)).sort();
}

/**
 * Parse a Mali kbase utilisation node: a bare integer percentage. Values outside
 * 0-100 are refused — whatever such a node meant, it is not a percentage, and
 * rendering it as one would draw a false bar. HARDWARE-OPEN: if a real board
 * prints something else, this parser is extended from that capture rather than
 * guessed at now; an unrecognised body simply falls through to the devfreq path.
 */
export function parseKbaseUtilisation(
	text: string | undefined,
): number | undefined {
	if (text === undefined) return undefined;
	const m = text.trim().match(KBASE_PERCENT);
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
 * Reduce one devfreq candidate's raw node contents to a reading. Pure — the
 * load-required/frequencies-optional contract lives here and is testable with no
 * filesystem. `undefined` means "this candidate did not answer a load", which is
 * what makes the caller move on to the next one. The load format is shared with
 * the DDR collector (`parseDevfreqLoad`): same devfreq class, same two documented
 * forms, so the two must not drift apart.
 */
export function gpuFromDevfreqNodes(
	read: GpuDevfreqNodeRead,
): GpuReading | undefined {
	const loadPercent = parseDevfreqLoad(read.load);
	if (loadPercent === undefined) return undefined;
	const curFreqHz = parseHz(read.cur);
	const maxFreqHz = parseHz(read.max);
	return {
		loadPercent,
		...(curFreqHz !== undefined ? { curFreqHz } : {}),
		...(maxFreqHz !== undefined ? { maxFreqHz } : {}),
	};
}

/** Read a node, mapping any failure to `undefined` (the candidate is dropped later). */
async function readOptional(
	fs: CollectorFs,
	path: string,
): Promise<string | undefined> {
	try {
		return await fs.readText(path);
	} catch {
		// Expected: a board that does not run this driver stack, or a device that
		// went away between enumeration and read. The candidate fallthrough below
		// is the whole handling — WARNing here would fire on every 5s tick of
		// every board that simply uses the other path.
		return undefined;
	}
}

/** PATH (a): the Mali kbase misc-device candidates, in list order. */
async function probeKbase(
	fs: CollectorFs,
	candidates: readonly string[],
): Promise<GpuReading | undefined> {
	for (const candidate of candidates) {
		const loadPercent = parseKbaseUtilisation(
			await readOptional(fs, candidate),
		);
		if (loadPercent !== undefined) return { loadPercent };
	}
	return undefined;
}

/** PATH (b): a `*.gpu` devfreq device, in the deterministic candidate order. */
async function probeDevfreq(
	fs: CollectorFs,
	dir: string,
): Promise<GpuReading | undefined> {
	let entries: string[];
	try {
		entries = await fs.readDir(dir);
	} catch (err) {
		// A kernel with no devfreq class directory at all: WARN, not an error —
		// the tick is fine and the signal is simply absent. Only the ENUMERATION
		// failure warns; per-node read failures stay silent (a devfreq GPU with
		// no vendor `load` extension is an ordinary shape).
		logger.warn("gpu: devfreq directory unreadable", { dir, err });
		return undefined;
	}

	for (const candidate of gpuCandidatesFromEntries(entries)) {
		const base = `${dir}/${candidate}`;
		const [load, cur, max] = await Promise.all([
			readOptional(fs, `${base}/${LOAD_NODE}`),
			readOptional(fs, `${base}/${CUR_FREQ_NODE}`),
			readOptional(fs, `${base}/${MAX_FREQ_NODE}`),
		]);
		const gpu = gpuFromDevfreqNodes({ load, cur, max });
		if (gpu !== undefined) return gpu;
	}
	return undefined;
}

/**
 * Read + parse the GPU load from whichever probe path answers first: the Mali
 * kbase candidates, then a `*.gpu` devfreq device. Never throws — a board that
 * publishes neither degrades to the empty shape (field omitted), so the 5s tick
 * that composes this collector cannot be taken down by it.
 */
export async function collectGpu(
	fs: CollectorFs,
	kbaseCandidates: readonly string[] = KBASE_UTILISATION_CANDIDATES,
	devfreqDir: string = DEVFREQ_DIR,
): Promise<GpuStats> {
	const kbase = await probeKbase(fs, kbaseCandidates);
	if (kbase !== undefined) return { gpu: kbase };

	const devfreq = await probeDevfreq(fs, devfreqDir);
	if (devfreq !== undefined) return { gpu: devfreq };

	// Neither path answered — the field is omitted, never zero-filled.
	return {};
}
