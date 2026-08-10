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
 * Per-policy CPU frequency, read from `/sys/devices/system/cpu/cpufreq/policy*`
 * through the collector filesystem seam (`./fs.ts`). Composed by
 * `device-stats.ts` — never inlined there, same as `collectors/memory.ts`.
 *
 * WHY SYSFS AND NOT `cpupower`/`lscpu`
 *
 *   Those tools are formatters over these exact nodes. Shelling out would add a
 *   binary to the backend's allow-list (`run.ts`), add a process spawn to a tick
 *   that runs every 5s, and trade a stable one-integer-per-file ABI for a
 *   locale-dependent text table. The files ARE the interface.
 *
 * A POLICY IS NOT A CLUSTER, AND THIS MODULE DOES NOT PRETEND OTHERWISE
 *
 *   A cpufreq policy is the kernel's unit of frequency control: the set of CPUs
 *   that must share one frequency. On RK3588 that happens to line up with the
 *   big.LITTLE clusters (policy0/policy4/policy6), on a desktop x86 box it is
 *   usually one policy per CPU, and on other parts it is neither. So the emitted
 *   `id` is literally the directory name the kernel printed — `"policy0"` — with
 *   no "big"/"little" labelling, no cluster grouping, and no per-core expansion.
 *   Anything that wants to SAY "cluster" must establish that from its own
 *   knowledge of the board; this collector only reports what it read.
 *
 * UNITS: kHz, UNCONVERTED
 *
 *   `scaling_cur_freq` and `cpuinfo_max_freq` are both kHz (see
 *   Documentation/admin-guide/pm/cpufreq.rst). They are emitted as kHz, named
 *   `…Khz`, and NOT normalized — a "2.4 GHz" rendering is a display decision
 *   that belongs to the consumer, and converting here would only add a rounding
 *   step between the kernel's integer and the operator's screen.
 *
 * OMISSION vs ZERO — per policy, not per array
 *
 *   A policy is emitted only when BOTH nodes were read and parsed. One policy
 *   that is unreadable (a partial sysfs, or a directory that vanished under CPU
 *   hotplug between enumeration and read) drops THAT policy and leaves the rest
 *   of the list intact — dropping the whole array because one core went offline
 *   would blank a panel that is otherwise perfectly measured.
 *
 *   A frequency of `0` that was genuinely read is kept: that is a measurement.
 *   What is never emitted is an EMPTY array — an absent cpufreq tree, or one
 *   whose every policy failed, omits the field entirely. `[]` would read as
 *   "this board has no CPUs to report", which is a claim, not a gap.
 */

import { logger } from "../../../helpers/logger.ts";
import type { CollectorFs } from "./fs.ts";

/** The kernel directory this collector enumerates. Absolute — resolved by the seam. */
export const CPUFREQ_DIR = "/sys/devices/system/cpu/cpufreq";

/** Current operating frequency of a policy, in kHz. */
const SCALING_CUR_FREQ = "scaling_cur_freq";
/** Hardware ceiling of a policy, in kHz (the fixed one, not `scaling_max_freq`). */
const CPUINFO_MAX_FREQ = "cpuinfo_max_freq";

/** `policy<N>` — the only directory shape this collector accepts. */
const POLICY_DIR = /^policy(\d+)$/;

/**
 * One cpufreq policy as measured. Both frequencies are required: a policy that
 * could not answer both is omitted rather than half-reported.
 */
export type CpuFreqPolicy = {
	/** The kernel's own directory name, e.g. `"policy0"`. NOT a cluster name. */
	id: string;
	/** `scaling_cur_freq`, in kHz exactly as the kernel reports it. */
	curKhz: number;
	/** `cpuinfo_max_freq`, in kHz exactly as the kernel reports it. */
	maxKhz: number;
};

/**
 * The cpufreq signal on the `device-stats` payload. Optional and never empty:
 * absent means "nothing measurable", a present array has at least one policy.
 */
export type CpuFreqStats = {
	/** Per-policy frequencies, numerically ordered by policy index. */
	cpuFreq?: CpuFreqPolicy[];
};

/** One policy's raw node contents; `undefined` where the read failed. */
export type PolicyRead = {
	id: string;
	cur: string | undefined;
	max: string | undefined;
};

/**
 * Reduce a cpufreq directory listing to the policy ids worth reading, in
 * NUMERIC order. `readdir` order is arbitrary and a lexicographic sort would put
 * `policy10` between `policy1` and `policy2`, so the index is compared as a
 * number. Non-policy entries (`boost`, `policy` with no index, stray files) are
 * dropped.
 */
export function policyIdsFromEntries(entries: readonly string[]): string[] {
	const indexed: Array<{ id: string; index: number }> = [];
	for (const entry of entries) {
		const m = entry.match(POLICY_DIR);
		if (m?.[1] === undefined) continue;
		const index = Number.parseInt(m[1], 10);
		if (!Number.isFinite(index)) continue;
		indexed.push({ id: entry, index });
	}
	indexed.sort((a, b) => a.index - b.index);
	return indexed.map((p) => p.id);
}

/** Parse a one-integer sysfs node. Returns undefined for anything else. */
function parseKhz(text: string | undefined): number | undefined {
	if (text === undefined) return undefined;
	const trimmed = text.trim();
	if (!/^\d+$/.test(trimmed)) return undefined;
	const value = Number.parseInt(trimmed, 10);
	return Number.isFinite(value) ? value : undefined;
}

/**
 * Reduce raw per-policy node contents to the emitted rows. Pure — the whole
 * per-policy omission contract lives here and is testable with no filesystem.
 * Input order is preserved (the caller enumerates in numeric order).
 */
export function cpuFreqFromPolicyReads(
	reads: readonly PolicyRead[],
): CpuFreqPolicy[] {
	const policies: CpuFreqPolicy[] = [];
	for (const read of reads) {
		const curKhz = parseKhz(read.cur);
		const maxKhz = parseKhz(read.max);
		// Both, or neither: a row carrying only a current frequency has no scale
		// to be read against, and inventing one would be worse than omitting it.
		if (curKhz === undefined || maxKhz === undefined) continue;
		policies.push({ id: read.id, curKhz, maxKhz });
	}
	return policies;
}

/** Read a node, mapping any failure to `undefined` (the policy is dropped later). */
async function readOptional(
	fs: CollectorFs,
	path: string,
): Promise<string | undefined> {
	try {
		return await fs.readText(path);
	} catch {
		// Expected on a partial sysfs and on a policy that went away under
		// hotplug — the per-policy omission below is the whole handling.
		return undefined;
	}
}

/**
 * Read + parse the per-policy CPU frequencies. Never throws: an absent or
 * unreadable cpufreq tree degrades to the empty shape (field omitted) with a
 * WARN, so the 5s tick that composes this collector cannot be taken down by it.
 */
export async function collectCpuFreq(
	fs: CollectorFs,
	dir: string = CPUFREQ_DIR,
): Promise<CpuFreqStats> {
	let entries: string[];
	try {
		entries = await fs.readDir(dir);
	} catch (err) {
		logger.warn("cpufreq: policy directory unreadable", { dir, err });
		return {};
	}

	const reads = await Promise.all(
		policyIdsFromEntries(entries).map(async (id) => {
			const [cur, max] = await Promise.all([
				readOptional(fs, `${dir}/${id}/${SCALING_CUR_FREQ}`),
				readOptional(fs, `${dir}/${id}/${CPUINFO_MAX_FREQ}`),
			]);
			return { id, cur, max };
		}),
	);

	const cpuFreq = cpuFreqFromPolicyReads(reads);
	// Never emit `[]` — see the omission note at the top of the file.
	return cpuFreq.length > 0 ? { cpuFreq } : {};
}
