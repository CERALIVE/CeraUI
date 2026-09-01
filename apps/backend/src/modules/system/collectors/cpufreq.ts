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
 * …BUT THE KERNEL DOES SAY WHICH CPUs, WHICH GOVERNOR, AND WHICH PART
 *
 *   `policy0` is a directory name, and it is the only thing an operator was ever
 *   shown. Three more facts are sitting in the same tree and in /proc, and every
 *   one of them is READ rather than inferred:
 *
 *     - `related_cpus`     → `cpus: "0-3"` + `cpuCount: 4`
 *     - `scaling_governor` → `governor: "performance"`
 *     - /proc/cpuinfo      → `label: "Cortex-A55"` (ARM) / the x86 model name
 *
 *   `label` is the one that could be fabricated, so it is the one with the
 *   strictest rule: an ARM part number is named ONLY from a table of parts whose
 *   MIDR value has been checked, and ONLY when the implementer is ARM Ltd
 *   (`0x41`) — a vendor-implemented core may reuse a part number, and printing
 *   "Cortex-A55" over somebody else's silicon is worse than printing nothing.
 *   Every CPU of the policy must resolve to the SAME label or the field is
 *   omitted. An absent label is the honest floor, and the consumer already has
 *   the sysfs id to fall back to.
 *
 *   All three are ADDITIVE and INDEPENDENTLY optional: a node that could not be
 *   read omits its own field and changes nothing about the policy's frequencies,
 *   which are still the only fields a policy is required to answer with.
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

/** The per-CPU microarchitecture table, read once per tick. */
export const CPUINFO_PATH = "/proc/cpuinfo";

/** Current operating frequency of a policy, in kHz. */
const SCALING_CUR_FREQ = "scaling_cur_freq";
/** Hardware ceiling of a policy, in kHz (the fixed one, not `scaling_max_freq`). */
const CPUINFO_MAX_FREQ = "cpuinfo_max_freq";
/** Every CPU the policy governs, space-separated (`"0 1 2 3"`). */
const RELATED_CPUS = "related_cpus";
/** The governor currently driving the policy (`"performance"`, `"schedutil"`, …). */
const SCALING_GOVERNOR = "scaling_governor";

/** `policy<N>` — the only directory shape this collector accepts. */
const POLICY_DIR = /^policy(\d+)$/;

/**
 * A governor name as the kernel spells it. The guard exists so a truncated or
 * binary read is dropped rather than emitted as an operator-facing token.
 */
const GOVERNOR_NAME = /^[a-z][a-z0-9_-]*$/i;

/** `CPU implementer` for ARM Ltd — the only vendor whose part table is below. */
const ARM_IMPLEMENTER = "0x41";

/**
 * ARM MIDR part numbers this build is willing to NAME. Extending it requires a
 * part number checked against ARM's own documentation for that core — an
 * unlisted part yields NO label, which is the whole point of the table.
 *
 *   0xd05 / 0xd0b are RK3588's two clusters (4x A55 + 4x A76).
 */
const ARM_CPU_PARTS: ReadonlyMap<string, string> = new Map([
	["0xd05", "Cortex-A55"],
	["0xd0b", "Cortex-A76"],
]);

/**
 * One cpufreq policy as measured. Both frequencies are required: a policy that
 * could not answer both is omitted rather than half-reported. Everything else is
 * additive and independently optional — an unreadable node omits its own field.
 */
export type CpuFreqPolicy = {
	/** The kernel's own directory name, e.g. `"policy0"`. NOT a cluster name. */
	id: string;
	/** `scaling_cur_freq`, in kHz exactly as the kernel reports it. */
	curKhz: number;
	/** `cpuinfo_max_freq`, in kHz exactly as the kernel reports it. */
	maxKhz: number;
	/** `related_cpus`, compacted to ranges: `"0-3"`, `"4-5"`, `"0,2,4"`. */
	cpus?: string;
	/** How many CPUs `cpus` names. Always present when `cpus` is. */
	cpuCount?: number;
	/** `scaling_governor`, verbatim. */
	governor?: string;
	/** The microarchitecture every related CPU reports, or ABSENT. Never guessed. */
	label?: string;
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
	relatedCpus?: string | undefined;
	governor?: string | undefined;
};

/** CPU number → the microarchitecture that CPU reported, for CPUs that named one. */
export type CpuLabelIndex = ReadonlyMap<number, string>;

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

/** Parse `related_cpus` into ascending, de-duplicated CPU numbers. */
export function parseRelatedCpus(
	text: string | undefined,
): number[] | undefined {
	if (text === undefined) return undefined;
	const trimmed = text.trim();
	if (trimmed.length === 0) return undefined;
	const cpus = new Set<number>();
	for (const token of trimmed.split(/\s+/)) {
		if (!/^\d+$/.test(token)) return undefined;
		const value = Number.parseInt(token, 10);
		if (!Number.isFinite(value)) return undefined;
		cpus.add(value);
	}
	return cpus.size > 0 ? [...cpus].sort((a, b) => a - b) : undefined;
}

/** Compact ascending CPU numbers into the kernel's own range notation. */
export function formatCpuList(cpus: readonly number[]): string {
	const parts: string[] = [];
	let start: number | undefined;
	let end: number | undefined;
	const flush = () => {
		if (start === undefined || end === undefined) return;
		parts.push(start === end ? `${start}` : `${start}-${end}`);
	};
	for (const cpu of cpus) {
		if (end !== undefined && cpu === end + 1) {
			end = cpu;
			continue;
		}
		flush();
		start = cpu;
		end = cpu;
	}
	flush();
	return parts.join(",");
}

/** Accept a governor name the kernel could plausibly have written, else nothing. */
export function parseGovernor(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const trimmed = text.trim();
	return GOVERNOR_NAME.test(trimmed) ? trimmed : undefined;
}

type CpuinfoBlock = {
	implementer?: string;
	part?: string;
	modelName?: string;
};

/**
 * Name one CPU's microarchitecture, or nothing.
 *
 * The ARM branch is gated on the implementer as well as the part, because a part
 * number is only ARM's to define when ARM implemented the core.
 */
function labelForBlock(block: CpuinfoBlock): string | undefined {
	if (block.implementer === ARM_IMPLEMENTER && block.part !== undefined) {
		return ARM_CPU_PARTS.get(block.part);
	}
	if (block.modelName !== undefined && block.modelName.length > 0) {
		return block.modelName;
	}
	return undefined;
}

/**
 * Reduce `/proc/cpuinfo` to the CPUs whose microarchitecture this build can
 * name. A CPU whose block named no recognised part is simply absent from the
 * map, which is what makes an unknown part unlabellable downstream.
 */
export function cpuLabelsFromCpuinfo(text: string | undefined): CpuLabelIndex {
	const labels = new Map<number, string>();
	if (text === undefined) return labels;

	let processor: number | undefined;
	let block: CpuinfoBlock = {};
	const flush = () => {
		if (processor !== undefined) {
			const label = labelForBlock(block);
			if (label !== undefined) labels.set(processor, label);
		}
		processor = undefined;
		block = {};
	};

	for (const line of text.split("\n")) {
		const separator = line.indexOf(":");
		if (separator < 0) {
			if (line.trim().length === 0) flush();
			continue;
		}
		const key = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		if (key === "processor") {
			flush();
			if (/^\d+$/.test(value)) processor = Number.parseInt(value, 10);
		} else if (key === "cpu implementer") {
			block.implementer = value.toLowerCase();
		} else if (key === "cpu part") {
			block.part = value.toLowerCase();
		} else if (key === "model name") {
			block.modelName = value;
		}
	}
	flush();
	return labels;
}

/**
 * The label every CPU of a policy agrees on. One silent CPU, or two CPUs naming
 * different parts, yields nothing — a policy is labelled or it is not.
 */
export function labelForCpus(
	cpus: readonly number[],
	labels: CpuLabelIndex,
): string | undefined {
	let agreed: string | undefined;
	for (const cpu of cpus) {
		const label = labels.get(cpu);
		if (label === undefined) return undefined;
		if (agreed === undefined) agreed = label;
		else if (agreed !== label) return undefined;
	}
	return agreed;
}

/**
 * Reduce raw per-policy node contents to the emitted rows. Pure — the whole
 * per-policy omission contract lives here and is testable with no filesystem.
 * Input order is preserved (the caller enumerates in numeric order).
 */
export function cpuFreqFromPolicyReads(
	reads: readonly PolicyRead[],
	cpuLabels: CpuLabelIndex = new Map(),
): CpuFreqPolicy[] {
	const policies: CpuFreqPolicy[] = [];
	for (const read of reads) {
		const curKhz = parseKhz(read.cur);
		const maxKhz = parseKhz(read.max);
		// Both, or neither: a row carrying only a current frequency has no scale
		// to be read against, and inventing one would be worse than omitting it.
		if (curKhz === undefined || maxKhz === undefined) continue;

		const policy: CpuFreqPolicy = { id: read.id, curKhz, maxKhz };
		const cpus = parseRelatedCpus(read.relatedCpus);
		if (cpus !== undefined) {
			policy.cpus = formatCpuList(cpus);
			policy.cpuCount = cpus.length;
			const label = labelForCpus(cpus, cpuLabels);
			if (label !== undefined) policy.label = label;
		}
		const governor = parseGovernor(read.governor);
		if (governor !== undefined) policy.governor = governor;
		policies.push(policy);
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

	const ids = policyIdsFromEntries(entries);
	if (ids.length === 0) return {};

	const [cpuinfo, reads] = await Promise.all([
		readOptional(fs, CPUINFO_PATH),
		Promise.all(
			ids.map(async (id) => {
				const [cur, max, relatedCpus, governor] = await Promise.all([
					readOptional(fs, `${dir}/${id}/${SCALING_CUR_FREQ}`),
					readOptional(fs, `${dir}/${id}/${CPUINFO_MAX_FREQ}`),
					readOptional(fs, `${dir}/${id}/${RELATED_CPUS}`),
					readOptional(fs, `${dir}/${id}/${SCALING_GOVERNOR}`),
				]);
				return { id, cur, max, relatedCpus, governor };
			}),
		),
	]);

	const cpuFreq = cpuFreqFromPolicyReads(reads, cpuLabelsFromCpuinfo(cpuinfo));
	// Never emit `[]` — see the omission note at the top of the file.
	return cpuFreq.length > 0 ? { cpuFreq } : {};
}
