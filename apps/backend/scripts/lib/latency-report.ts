/*
    CeraUI - web UI for the CeraLive project
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

/**
 * PURE milestone arithmetic, budget evaluation and table rendering.
 *
 * Split from the capture side so the harness's own maths can be tested without
 * a board, a hub or ModemManager. The one judgement encoded here rather than in
 * the CLI is that a plug cycle is summarised by its MEDIAN, never by a single
 * run: USB re-enumeration and MM probing are visibly multi-modal on real
 * hardware (a stick can take 9 s or 40 s to come back depending on whether its
 * firmware cold-boots), so a one-shot number is noise wearing a budget's
 * clothes.
 */

/** A point on the plug-cycle timeline, on the shared epoch-ms axis. */
export type MilestoneId =
	| "udev_remove"
	| "row_removed"
	| "udev_add"
	| "mm_export"
	| "row_provisional"
	| "row_authoritative"
	| "mm_properties_changed"
	| "row_property_update";

/** Every milestone captured for one plug cycle. */
export interface CycleMilestones {
	readonly cycle: number;
	/** The udev `ID_PATH` of the device that actually moved, when observed. */
	readonly idPath: string | null;
	/** The MM index the device came back under, when it reached the bus. */
	readonly mmIndex: number | null;
	readonly times: Partial<Record<MilestoneId, number>>;
	/** Anything that made this cycle non-comparable, in the operator's words. */
	readonly notes: readonly string[];
}

/** One measured span, with the budget it answers to. */
export interface IntervalSpec {
	readonly id: string;
	readonly label: string;
	readonly from: MilestoneId;
	readonly to: MilestoneId;
	/**
	 * `true` for spans whose duration is a property of the hardware/daemon
	 * rather than of this codebase. The plan exempts MM probe time explicitly;
	 * an exempt span is still MEASURED and REPORTED, just never asserted.
	 */
	readonly exempt: boolean;
	readonly note: string;
}

/**
 * The spans the plan names, plus the two context spans needed to read them.
 *
 * `mm_probe` and `end_to_end` carry no budget: the first is the exempt one, and
 * the second is its sum with a budgeted span, so asserting it would double-count
 * the exemption and fail this harness for ModemManager's probe time.
 */
export const INTERVAL_SPECS: readonly IntervalSpec[] = [
	{
		id: "optimistic_row",
		label: "udev add → optimistic row on WS",
		from: "udev_add",
		to: "row_provisional",
		exempt: false,
		note: "todo 18; absent by construction on a pre-todo-18 build",
	},
	{
		id: "authoritative_row",
		label: "MM InterfacesAdded → authoritative row on WS",
		from: "mm_export",
		to: "row_authoritative",
		exempt: false,
		note: "todo 17; the span the D-Bus observer replaced a 30 s poll with",
	},
	{
		id: "property_to_ui",
		label: "MM PropertiesChanged → row content change on WS",
		from: "mm_properties_changed",
		to: "row_property_update",
		exempt: false,
		note: "steady-state property propagation on a standing row",
	},
	{
		id: "removal",
		label: "udev remove → row gone from WS",
		from: "udev_remove",
		to: "row_removed",
		exempt: false,
		note: "detach honesty; must not wait for a poll",
	},
	{
		id: "mm_probe",
		label: "udev add → MM InterfacesAdded (EXEMPT)",
		from: "udev_add",
		to: "mm_export",
		exempt: true,
		note: "ModemManager port probing — inherent, never this codebase's to fix",
	},
	{
		id: "end_to_end",
		label: "udev add → authoritative row (context)",
		from: "udev_add",
		to: "row_authoritative",
		exempt: true,
		note: "sum of mm_probe and authoritative_row; reported, never asserted",
	},
];

/** Budgets, keyed by `IntervalSpec.id`. A missing id is simply not asserted. */
export type BudgetTable = Readonly<Record<string, number>>;

/** Statistics for one interval across a phase's cycles. */
export interface IntervalSummary {
	readonly id: string;
	readonly label: string;
	readonly exempt: boolean;
	readonly samples: readonly number[];
	readonly medianMs: number | null;
	readonly minMs: number | null;
	readonly maxMs: number | null;
}

/** The verdict for one budgeted interval. */
export interface BudgetVerdict {
	readonly id: string;
	readonly label: string;
	readonly budgetMs: number;
	readonly medianMs: number | null;
	readonly maxMs: number | null;
	/** `false` only for a real miss — a span with no samples is `null`. */
	readonly pass: boolean | null;
	readonly reason: string;
}

/**
 * How far the three sources' clocks may disagree before an ordering is doubted.
 *
 * DERIVED, not picked. The udev axis is `/proc/uptime`, which the kernel prints
 * to 10 ms, plus the scheduling gap between the two reads that form the boot
 * offset; the bus axis is the daemon's own CLOCK_REALTIME; the WebSocket axis is
 * this process's receive time. A disagreement of a few tens of milliseconds is
 * therefore expected between a cause and the frame it produced. 1 s is two
 * orders of magnitude above that and two orders BELOW the ~100 s spacing between
 * plug cycles, so it can absorb the skew without ever admitting a neighbouring
 * cycle's event.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 1000;

/**
 * Elapsed ms for one interval in one cycle, or `null` if either end is absent.
 *
 * A SMALL negative span is clock skew, not a causality violation — the frame a
 * udev event caused can carry a receive time a few ms before the event's own
 * projected timestamp — so it is clamped to 0 rather than discarded, because
 * discarding it would silently drop the FASTEST samples and bias every median
 * upward. A span more negative than the tolerance means the milestone was paired
 * with the wrong event, and that is reported as no sample at all.
 */
export function intervalMs(
	cycle: CycleMilestones,
	spec: IntervalSpec,
): number | null {
	const from = cycle.times[spec.from];
	const to = cycle.times[spec.to];
	if (from === undefined || to === undefined) return null;
	const elapsed = to - from;
	if (elapsed < -CLOCK_SKEW_TOLERANCE_MS) return null;
	return Math.max(0, elapsed);
}

/** The median of a sample set, `null` when empty. Even counts average the pair. */
export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const upper = sorted[mid];
	if (upper === undefined) return null;
	if (sorted.length % 2 === 1) return upper;
	const lower = sorted[mid - 1];
	return lower === undefined ? upper : (lower + upper) / 2;
}

/** Per-interval statistics across every cycle of one phase. */
export function summarizeCycles(
	cycles: readonly CycleMilestones[],
	specs: readonly IntervalSpec[] = INTERVAL_SPECS,
): readonly IntervalSummary[] {
	return specs.map((spec) => {
		const samples = cycles
			.map((cycle) => intervalMs(cycle, spec))
			.filter((value): value is number => value !== null);
		return {
			id: spec.id,
			label: spec.label,
			exempt: spec.exempt,
			samples,
			medianMs: median(samples),
			minMs: samples.length > 0 ? Math.min(...samples) : null,
			maxMs: samples.length > 0 ? Math.max(...samples) : null,
		};
	});
}

/**
 * Assert the budgets against a phase's medians.
 *
 * A budgeted interval with NO samples returns `pass: null` — "not measured" is
 * a distinct verdict from "measured and within budget", and collapsing the two
 * is how a harness starts reporting green for a feature it never exercised.
 */
export function evaluateBudgets(
	summaries: readonly IntervalSummary[],
	budgets: BudgetTable,
): readonly BudgetVerdict[] {
	const verdicts: BudgetVerdict[] = [];

	for (const summary of summaries) {
		const budgetMs = budgets[summary.id];
		if (budgetMs === undefined) continue;
		if (summary.medianMs === null) {
			verdicts.push({
				id: summary.id,
				label: summary.label,
				budgetMs,
				medianMs: null,
				maxMs: null,
				pass: null,
				reason: "no samples — milestone never observed in this phase",
			});
			continue;
		}
		const pass = summary.medianMs <= budgetMs;
		verdicts.push({
			id: summary.id,
			label: summary.label,
			budgetMs,
			medianMs: summary.medianMs,
			maxMs: summary.maxMs,
			pass,
			reason: pass
				? `median ${fmtMs(summary.medianMs)} within ${fmtMs(budgetMs)}`
				: `median ${fmtMs(summary.medianMs)} EXCEEDS ${fmtMs(budgetMs)}`,
		});
	}

	return verdicts;
}

/** `true` when every budgeted interval both measured and passed. */
export function budgetsAllGreen(verdicts: readonly BudgetVerdict[]): boolean {
	return (
		verdicts.length > 0 && verdicts.every((verdict) => verdict.pass === true)
	);
}

/** Milliseconds for a human: sub-second in ms, above that in seconds. */
export function fmtMs(value: number | null): string {
	if (value === null) return "—";
	if (Math.abs(value) < 1000) return `${Math.round(value)} ms`;
	return `${(value / 1000).toFixed(2)} s`;
}

/** A markdown table; every column is padded to its widest cell. */
export function renderTable(
	headers: readonly string[],
	rows: readonly (readonly string[])[],
): string {
	const widths = headers.map((header, column) =>
		Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
	);
	const line = (cells: readonly string[]): string =>
		`| ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join(" | ")} |`;

	return [
		line(headers),
		`| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
		...rows.map(line),
	].join("\n");
}

/** Per-cycle milestone table: one row per cycle, one column per interval. */
export function renderCycleTable(
	cycles: readonly CycleMilestones[],
	specs: readonly IntervalSpec[] = INTERVAL_SPECS,
): string {
	const headers = ["cycle", "MM idx", ...specs.map((spec) => spec.id)];
	const rows = cycles.map((cycle) => [
		String(cycle.cycle),
		cycle.mmIndex === null ? "—" : String(cycle.mmIndex),
		...specs.map((spec) => fmtMs(intervalMs(cycle, spec))),
	]);
	return renderTable(headers, rows);
}

/** Phase summary table: min / median / max per interval. */
export function renderSummaryTable(
	summaries: readonly IntervalSummary[],
): string {
	return renderTable(
		["interval", "n", "min", "median", "max", "budgeted"],
		summaries.map((summary) => [
			summary.label,
			String(summary.samples.length),
			fmtMs(summary.minMs),
			fmtMs(summary.medianMs),
			fmtMs(summary.maxMs),
			summary.exempt ? "EXEMPT" : "yes",
		]),
	);
}

/** Budget verdict table. */
export function renderBudgetTable(verdicts: readonly BudgetVerdict[]): string {
	return renderTable(
		["interval", "budget", "median", "worst", "verdict"],
		verdicts.map((verdict) => [
			verdict.label,
			fmtMs(verdict.budgetMs),
			fmtMs(verdict.medianMs),
			fmtMs(verdict.maxMs),
			verdict.pass === null ? "NOT MEASURED" : verdict.pass ? "PASS" : "MISS",
		]),
	);
}
