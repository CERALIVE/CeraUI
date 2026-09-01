/**
 * CPU frequency as rows an operator can read — the render side of the
 * `device-stats` `cpuFreq` signal.
 *
 * The panel used to print the collector's payload verbatim: one row per policy,
 * headed by the sysfs directory name (`policy0`, `policy4`, `policy6`) and
 * nothing else. That is honest and unreadable — the directory name says nothing
 * about which cores it governs or what they are, and on a per-core x86 box it
 * produced a dozen near-identical bars.
 *
 * The collector now carries what the kernel actually said (`cpus`, `cpuCount`,
 * `governor`, and a `label` derived from a checked MIDR part table), so this
 * module turns those into rows. Three shapes, and the discriminator is
 * STRUCTURAL rather than a board guess:
 *
 *   cluster  — one row per policy, named by its label. A policy that governs
 *              several CPUs IS the interesting unit; RK3588's three policies
 *              read "Cortex-A55 x4" / "Cortex-A76 x2" / "Cortex-A76 x2".
 *   per-core — every policy governs exactly ONE CPU, so a policy is not an
 *              interesting unit at all and identical ones are folded into one
 *              row per (label, ceiling) group with the current-clock RANGE.
 *   raw      — the device sent no metadata. Byte-identical to what shipped
 *              before: one row per policy under its sysfs id.
 *
 * NOTHING HERE INVENTS A NAME. A row is named by the device's own `label` or by
 * the sysfs id, never by list position, never by core count, and never by a
 * board model. Aggregation likewise requires a label on every policy — folding
 * twelve rows under `policy0` would be a worse lie than twelve honest rows.
 */

import type { CpuFreqPolicy } from "@ceraui/rpc/schemas";

/** How the policy list was folded — also published as `data-cpufreq-shape`. */
export type CpuFreqShape = "cluster" | "per-core" | "raw";

/** A span narrower than this is invisible, so a flat group still shows a mark. */
const MIN_SPAN_PERCENT = 2;

export interface CpuFreqRow {
	/** Stable `{#each}` key and testid suffix — the row's first policy id. */
	key: string;
	/** What the row is called: the device's own label, else the sysfs id. */
	name: string;
	/** True when `name` came from the device rather than from a directory name. */
	named: boolean;
	/** The sysfs policies folded into this row, in payload order. */
	policyIds: readonly string[];
	/** Every CPU the row covers, in the kernel's range notation (`"0-3"`). */
	cpus?: string;
	/** How many CPUs `cpus` names. */
	cpuCount?: number;
	/** Lowest current clock across the row, kHz. */
	curMinKhz: number;
	/** Highest current clock across the row, kHz — equal to the low for one policy. */
	curMaxKhz: number;
	/** The hardware ceiling every policy in the row shares, kHz. */
	maxKhz: number;
	/** Present only when every policy in the row reported the SAME governor. */
	governor?: string;
}

export interface CpuFreqView {
	shape: CpuFreqShape;
	rows: CpuFreqRow[];
}

/** The bar geometry a row justifies. `null` ⇒ no ceiling, so nothing to draw. */
export interface CpuFreqBar {
	kind: "fill" | "span";
	startPercent: number;
	sizePercent: number;
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, Math.round(value)));
}

/** Expand the kernel's range notation back into CPU numbers. */
export function parseCpuSpec(spec: string | undefined): number[] {
	if (spec === undefined) return [];
	const cpus: number[] = [];
	for (const part of spec.split(",")) {
		const [from, to] = part.split("-");
		const start = Number.parseInt(from ?? "", 10);
		if (!Number.isFinite(start)) continue;
		const end = to === undefined ? start : Number.parseInt(to, 10);
		if (!Number.isFinite(end) || end < start) {
			cpus.push(start);
			continue;
		}
		for (let cpu = start; cpu <= end; cpu++) cpus.push(cpu);
	}
	return cpus;
}

/** Compact ascending CPU numbers into the kernel's own range notation. */
export function formatCpuSpec(cpus: readonly number[]): string {
	const sorted = [...new Set(cpus)].sort((a, b) => a - b);
	const parts: string[] = [];
	let start: number | undefined;
	let end: number | undefined;
	const flush = () => {
		if (start === undefined || end === undefined) return;
		parts.push(start === end ? `${start}` : `${start}-${end}`);
	};
	for (const cpu of sorted) {
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

function rowFromPolicy(policy: CpuFreqPolicy): CpuFreqRow {
	const row: CpuFreqRow = {
		key: policy.id,
		name: policy.label ?? policy.id,
		named: policy.label !== undefined,
		policyIds: [policy.id],
		curMinKhz: policy.curKhz,
		curMaxKhz: policy.curKhz,
		maxKhz: policy.maxKhz,
	};
	if (policy.cpus !== undefined) row.cpus = policy.cpus;
	if (policy.cpuCount !== undefined) row.cpuCount = policy.cpuCount;
	if (policy.governor !== undefined) row.governor = policy.governor;
	return row;
}

function rowFromGroup(group: readonly CpuFreqPolicy[]): CpuFreqRow {
	const first = group[0];
	if (first === undefined) throw new Error("cpu-freq: empty policy group");

	const cpus: number[] = [];
	let curMin = first.curKhz;
	let curMax = first.curKhz;
	let cpuCount = 0;
	let governor: string | undefined = first.governor;
	for (const policy of group) {
		cpus.push(...parseCpuSpec(policy.cpus));
		cpuCount += policy.cpuCount ?? 0;
		curMin = Math.min(curMin, policy.curKhz);
		curMax = Math.max(curMax, policy.curKhz);
		if (policy.governor !== governor) governor = undefined;
	}

	const row: CpuFreqRow = {
		key: first.id,
		name: first.label ?? first.id,
		named: first.label !== undefined,
		policyIds: group.map((policy) => policy.id),
		curMinKhz: curMin,
		curMaxKhz: curMax,
		maxKhz: first.maxKhz,
	};
	const spec = formatCpuSpec(cpus);
	if (spec.length > 0) row.cpus = spec;
	if (cpuCount > 0) row.cpuCount = cpuCount;
	if (governor !== undefined) row.governor = governor;
	return row;
}

/**
 * A per-core board is one where NO policy governs more than a single CPU, so the
 * policy has stopped being the unit worth a row. Folding is additionally gated
 * on every policy carrying a label: a group has to be called something, and the
 * first policy's directory name is not a name for the eleven behind it.
 */
function isPerCoreShape(policies: readonly CpuFreqPolicy[]): boolean {
	return (
		policies.length > 1 &&
		policies.every(
			(policy) => policy.cpuCount === 1 && policy.label !== undefined,
		)
	);
}

function hasMetadata(policies: readonly CpuFreqPolicy[]): boolean {
	return policies.some(
		(policy) =>
			policy.label !== undefined ||
			policy.cpuCount !== undefined ||
			policy.cpus !== undefined ||
			policy.governor !== undefined,
	);
}

export function deriveCpuFreqRows(
	policies: readonly CpuFreqPolicy[] | undefined,
): CpuFreqView {
	if (policies === undefined || policies.length === 0) {
		return { shape: "raw", rows: [] };
	}

	if (isPerCoreShape(policies)) {
		const groups = new Map<string, CpuFreqPolicy[]>();
		for (const policy of policies) {
			const groupKey = `${policy.label ?? policy.id}\u0000${policy.maxKhz}`;
			const group = groups.get(groupKey);
			if (group === undefined) groups.set(groupKey, [policy]);
			else group.push(policy);
		}
		return {
			shape: "per-core",
			rows: [...groups.values()].map(rowFromGroup),
		};
	}

	return {
		shape: hasMetadata(policies) ? "cluster" : "raw",
		rows: policies.map(rowFromPolicy),
	};
}

/**
 * A single policy draws its clock as a fill from zero. A folded group draws the
 * SPAN its members currently occupy, because one filled bar for twelve cores
 * would have to pick a core to be about.
 */
export function cpuFreqBar(row: CpuFreqRow): CpuFreqBar | null {
	if (row.maxKhz <= 0) return null;
	if (row.policyIds.length === 1) {
		return {
			kind: "fill",
			startPercent: 0,
			sizePercent: clampPercent((row.curMaxKhz / row.maxKhz) * 100),
		};
	}
	const startPercent = clampPercent((row.curMinKhz / row.maxKhz) * 100);
	const endPercent = clampPercent((row.curMaxKhz / row.maxKhz) * 100);
	return {
		kind: "span",
		startPercent,
		sizePercent: Math.min(
			100 - startPercent,
			Math.max(MIN_SPAN_PERCENT, endPercent - startPercent),
		),
	};
}
