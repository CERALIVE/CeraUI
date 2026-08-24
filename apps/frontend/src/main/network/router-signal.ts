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
 * Rendering todo 20's normalized router-dongle signal — pure, rune-free.
 *
 * A `router-ethernet` row has NO `status` block and never will: the backend
 * deliberately omits it rather than fabricate a zeroed one, because a dongle
 * running its own embedded router exposes no radio telemetry to the host at all.
 * So the row drew no signal glyph, and "attached with a full-strength radio" and
 * "attached with no SIM in it" looked identical from here.
 *
 * What the dongle DOES publish is its own admin API's reading, normalized by
 * `apps/backend/src/modules/network/router-signal-model.ts` and carried on the
 * wire as `router_admin.signal`. This module renders THAT, and nothing else.
 *
 * ── THE THREE RULES ─────────────────────────────────────────────────────────
 *
 * 1. **PROVENANCE IS NEVER ERASED.** This reading came from a vendor's web
 *    admin API over a USB LAN link; `status.signal` comes from ModemManager's
 *    radio stack. They are DIFFERENT INSTRUMENTS reading different devices, and
 *    the model carries `provenance` precisely so a consumer that renders both
 *    on one surface must still say which it has. The two are mutually exclusive
 *    per row by construction (a router row has no `status`, an MM row has no
 *    `router_admin`), and the component renders them through separate branches
 *    with separate testids so they can never be confused for one another.
 *
 * 2. **NOTHING IS FABRICATED.** A tier is derived ONLY from a metric the device
 *    actually published. `none` is reserved for a device-stated ZERO bars — a
 *    dBm figure, however weak, is a measurement that was taken, so it can never
 *    resolve to "no signal". A metric the DIALECT cannot express at all
 *    (`unsupported`) renders as visually ABSENT, never as a dash or a zero:
 *    "this API has no such field" is a fact about the protocol, and a dash in a
 *    metric row reads as "the radio reported nothing".
 *
 * 3. **A NON-READING IS A WORD, NOT A MARK.** A reading is a glyph (matching the
 *    MM row's existing treatment); everything else — an unreachable admin API, a
 *    refused session, an unreadable body — renders its own sentence on screen.
 *    The device ships with a kiosk touchscreen that cannot hover to reveal a
 *    tooltip, so a state carried only by an icon or a colour is a state the
 *    operator cannot read. There is deliberately no spinner anywhere in here: a
 *    30 s poll that has not answered yet is `not-reported`, which is a fact, not
 *    a wait.
 */
import type {
	Modem,
	RouterSignal,
	RouterSignalMetric,
} from "@ceraui/rpc/schemas";

import { type ModemSignalTier, resolveSignalTier } from "./cellular-row";

export type RouterSignalProvenance = RouterSignal["provenance"];
export type RouterSignalFreshness = RouterSignal["freshness"];
export type RouterSignalUnknownReason = Extract<
	RouterSignalMetric,
	{ state: "unknown" }
>["reason"];

/**
 * What the row-level chip says.
 *
 * There is deliberately NO `no-sim` variant. An empty slot is a fact about the
 * CARD, not about the radio, and it is owned end-to-end by one component —
 * `NoSimBadge`, which every modem class draws (see `CeraUI/AGENTS.md` → "…AND
 * THE 'No SIM' TAG IS ONE COMPONENT"). This module used to carry a third
 * spelling of it, and no surface has rendered that spelling since the tag was
 * unified: the row guards its chip on `isSimlessModem`, and the section set
 * folds the same variant back into "unreadable". A readout state nothing can
 * render is a state that can only ever drift away from the one that ships.
 */
export type RouterSignalReadout =
	| {
			readonly kind: "reading";
			readonly provenance: RouterSignalProvenance;
			readonly freshness: RouterSignalFreshness;
			readonly tier: ModemSignalTier;
			/** Which published quantity the tier was derived from. */
			readonly basis: "bars" | "dbm";
	  }
	| {
			readonly kind: "unknown";
			readonly provenance: RouterSignalProvenance;
			readonly freshness: RouterSignalFreshness;
			readonly reason: RouterSignalUnknownReason;
	  };

export type RouterSignalMetricId =
	| "bars"
	| "dbm"
	| "rsrp"
	| "rsrq"
	| "snr"
	| "sinr";

/**
 * One line of the detail strip. An `unsupported` metric produces NO row at all
 * — see rule 2 — so a reason can never be `unsupported` here.
 */
export type RouterSignalMetricRow =
	| {
			readonly id: RouterSignalMetricId;
			readonly labelKey: string;
			readonly state: "known";
			readonly value: string;
	  }
	| {
			readonly id: RouterSignalMetricId;
			readonly labelKey: string;
			readonly state: "unknown";
			readonly reasonKey: string;
	  };

/** Display order: the device's own scale first, then power, then quality. */
const METRIC_IDS: readonly RouterSignalMetricId[] = [
	"bars",
	"dbm",
	"rsrp",
	"rsrq",
	"snr",
	"sinr",
];

/**
 * `rsrp` is a received POWER (dBm); the three ratios are dB. Folding them onto
 * one unit is the same class of error as folding `snr` into `sinr`.
 */
const METRIC_UNITS: Readonly<Record<RouterSignalMetricId, string>> = {
	bars: "",
	dbm: "dBm",
	rsrp: "dBm",
	rsrq: "dB",
	snr: "dB",
	sinr: "dB",
};

/**
 * Which unknown reason the CHIP reports when several metrics disagree.
 *
 * Ordered by how much of the read failed, widest first: a device that did not
 * answer at all outranks a refused session, which outranks an unreadable body,
 * which outranks a field the device simply left blank. `unsupported` is last
 * because it is the only one that says nothing about this cycle.
 */
const REASON_PRECEDENCE: readonly RouterSignalUnknownReason[] = [
	"unreachable",
	"auth-expired",
	"malformed",
	"not-reported",
	"unsupported",
];

const REASON_KEYS: Readonly<Record<RouterSignalUnknownReason, string>> = {
	unsupported: "network.routerCellular.signal.reason.unsupported",
	"not-reported": "network.routerCellular.signal.reason.notReported",
	malformed: "network.routerCellular.signal.reason.malformed",
	"auth-expired": "network.routerCellular.signal.reason.authExpired",
	unreachable: "network.routerCellular.signal.reason.unreachable",
};

const METRIC_LABEL_KEYS: Readonly<Record<RouterSignalMetricId, string>> = {
	bars: "network.routerCellular.signal.metric.bars",
	dbm: "network.routerCellular.signal.metric.dbm",
	rsrp: "network.routerCellular.signal.metric.rsrp",
	rsrq: "network.routerCellular.signal.metric.rsrq",
	snr: "network.routerCellular.signal.metric.snr",
	sinr: "network.routerCellular.signal.metric.sinr",
};

const TIER_LABEL_KEYS: Readonly<Record<ModemSignalTier, string>> = {
	high: "network.cellular.signal.high",
	medium: "network.cellular.signal.medium",
	low: "network.cellular.signal.low",
	none: "network.cellular.signal.none",
};

export function routerSignalReasonKey(
	reason: RouterSignalUnknownReason,
): string {
	return REASON_KEYS[reason];
}

/**
 * A bar count on the device's OWN scale, so the tier is the RATIO — never the
 * raw count. A vendor publishing 3-of-4 and one publishing 3-of-5 do not mean
 * the same thing, which is exactly why `max_bars` is on the wire beside it.
 *
 * A scale with no bars on it, a non-integral count, or a count with no scale
 * yields `undefined` — the caller falls through to the dBm reading rather than
 * inventing a denominator.
 */
export function tierFromBars(
	bars: number,
	max: number,
): ModemSignalTier | undefined {
	if (!Number.isFinite(bars) || !Number.isFinite(max)) return undefined;
	if (max <= 0 || bars < 0) return undefined;
	// A device-stated ZERO is the one honest route to "No signal". Nothing else
	// in this module can produce it.
	if (bars === 0) return "none";
	const ratio = bars / max;
	if (ratio >= 0.7) return "high";
	if (ratio >= 0.4) return "medium";
	return "low";
}

/**
 * Received power in dBm. The floor is `low`, deliberately — a number the device
 * published is a measurement that was taken, so a very weak reading is WEAK and
 * never "no signal". Only a stated zero-bar count means nothing is being heard.
 */
export function tierFromDbm(dbm: number): ModemSignalTier | undefined {
	if (!Number.isFinite(dbm)) return undefined;
	if (dbm >= -70) return "high";
	if (dbm >= -85) return "medium";
	return "low";
}

export function dominantUnknownReason(
	signal: RouterSignal,
): RouterSignalUnknownReason {
	const seen = new Set<RouterSignalUnknownReason>();
	for (const id of METRIC_IDS) {
		const metric = metricOf(signal, id);
		if (metric.state === "unknown") seen.add(metric.reason);
	}
	// `max_bars` is not in METRIC_IDS (it is the scale, not a reading), but a
	// refusal that hit it hit the whole cycle, so its reason still counts.
	if (signal.max_bars.state === "unknown") seen.add(signal.max_bars.reason);
	for (const reason of REASON_PRECEDENCE) {
		if (seen.has(reason)) return reason;
	}
	return "not-reported";
}

function metricOf(
	signal: RouterSignal,
	id: RouterSignalMetricId,
): RouterSignalMetric {
	return signal[id];
}

/**
 * The row-level readout, or `undefined` when there is nothing to say.
 *
 * `undefined` covers THREE different absences and all three must render nothing
 * HERE: a row that is not a router dongle at all, a backend that predates todo
 * 20 and publishes no normalized model, and a device that stated its SIM slot is
 * empty. Absence renders as absence — the legacy bar scalars keep their place in
 * the detail strip either way.
 *
 * The empty slot is the third one BY OWNERSHIP, not by convenience. It still
 * outranks every metric, so a `SimStatus 255` HiLink publishing `0` bars can
 * never resolve to a `none` tier — that is rule 2 and it is unchanged. What
 * changed is who SAYS so: the fact belongs to `NoSimBadge` (row) and `SimBlock`
 * (dialog), each of which already states it exactly once, so this module answers
 * only the question it owns — what the RADIO reported — and answers "nothing"
 * when there is no card for a radio to be reporting on.
 */
export function resolveRouterSignalReadout(
	modem: Modem,
): RouterSignalReadout | undefined {
	const admin = modem.router_admin;
	const signal = admin?.signal;
	if (signal === undefined) return undefined;
	if (admin?.sim === "absent") return undefined;

	const { provenance, freshness } = signal;

	if (signal.bars.state === "known" && signal.max_bars.state === "known") {
		const tier = tierFromBars(signal.bars.value, signal.max_bars.value);
		if (tier !== undefined) {
			return { kind: "reading", provenance, freshness, tier, basis: "bars" };
		}
	}
	if (signal.dbm.state === "known") {
		const tier = tierFromDbm(signal.dbm.value);
		if (tier !== undefined) {
			return { kind: "reading", provenance, freshness, tier, basis: "dbm" };
		}
	}

	return {
		kind: "unknown",
		provenance,
		freshness,
		reason: dominantUnknownReason(signal),
	};
}

/**
 * WHICH of the two instruments this row may draw — exactly one, ever (rule 1).
 *
 * It exists because both consumers used to state that exclusion for themselves,
 * and two copies of one precedence rule are two chances to answer differently
 * about a row that published both — which is the instrument confusion
 * `provenance` exists to prevent.
 *
 * `none` is a third answer, not a degenerate `device-admin`: no instrument
 * published anything renderable, which is what "unreadable" is derived from.
 */
export type SignalInstrument =
	| { readonly kind: "device-stack"; readonly tier: ModemSignalTier }
	| { readonly kind: "device-admin"; readonly readout: RouterSignalReadout }
	| { readonly kind: "none" };

export function resolveSignalInstrument(modem: Modem): SignalInstrument {
	const tier = resolveSignalTier(modem.status?.signal);
	if (tier !== undefined) return { kind: "device-stack", tier };

	const readout = resolveRouterSignalReadout(modem);
	return readout === undefined
		? { kind: "none" }
		: { kind: "device-admin", readout };
}

/**
 * The chip's own sentence. A reading resolves to its tier word (the SAME four
 * this section already uses for an MM radio, so one vocabulary covers both
 * instruments); everything else names the state.
 */
export function routerSignalStateKey(readout: RouterSignalReadout): string {
	if (readout.kind === "reading") return TIER_LABEL_KEYS[readout.tier];
	return REASON_KEYS[readout.reason];
}

/** A carried-over reading is labelled as the past tense it is (todo 20). */
export function isStaleReadout(readout: RouterSignalReadout): boolean {
	return readout.kind === "reading" && readout.freshness === "stale";
}

function formatMetric(id: RouterSignalMetricId, value: number): string {
	const unit = METRIC_UNITS[id];
	return unit === "" ? `${value}` : `${value} ${unit}`;
}

/**
 * The detail strip, in display order.
 *
 * Two omissions are the point rather than gaps:
 *
 *  - an `unsupported` metric produces NO ROW. The dialect has no such field, so
 *    a row saying "—" would report the radio as silent about something it was
 *    never asked;
 *  - the `bars` row needs BOTH the count and the device's own scale, because a
 *    bar count with no maximum is a number rather than a signal level. When one
 *    of the pair is unknown the row reports THAT, so the operator still learns
 *    the read was attempted.
 */
export function routerSignalMetricRows(
	signal: RouterSignal,
): RouterSignalMetricRow[] {
	const rows: RouterSignalMetricRow[] = [];
	for (const id of METRIC_IDS) {
		const labelKey = METRIC_LABEL_KEYS[id];
		if (id === "bars") {
			const barsRow = barsMetricRow(signal, labelKey);
			if (barsRow !== undefined) rows.push(barsRow);
			continue;
		}
		const metric = metricOf(signal, id);
		if (metric.state === "known") {
			rows.push({
				id,
				labelKey,
				state: "known",
				value: formatMetric(id, metric.value),
			});
			continue;
		}
		if (metric.reason === "unsupported") continue;
		rows.push({
			id,
			labelKey,
			state: "unknown",
			reasonKey: REASON_KEYS[metric.reason],
		});
	}
	return rows;
}

function barsMetricRow(
	signal: RouterSignal,
	labelKey: string,
): RouterSignalMetricRow | undefined {
	const { bars, max_bars: max } = signal;
	if (bars.state === "known" && max.state === "known" && max.value > 0) {
		return {
			id: "bars",
			labelKey,
			state: "known",
			value: `${bars.value} / ${max.value}`,
		};
	}
	const reason =
		bars.state === "unknown"
			? bars.reason
			: max.state === "unknown"
				? max.reason
				: undefined;
	if (reason === undefined || reason === "unsupported") return undefined;
	return {
		id: "bars",
		labelKey,
		state: "unknown",
		reasonKey: REASON_KEYS[reason],
	};
}
