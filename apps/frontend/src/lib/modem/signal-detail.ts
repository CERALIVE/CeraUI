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
 * Rendering the ModemManager side of the normalized reading — pure, rune-free
 * and locale-free, so every arm is drivable without mounting a dialog.
 *
 * `main/network/router-signal.ts` is the twin of this file for the DONGLE
 * dialects; this one renders the three blocks the D-Bus backend publishes for a
 * directly-managed radio (`signal_detail`, `registration_context`,
 * `sim_presence_evidence`). Both consume a metric that is a value OR a typed
 * reason, and both refuse to collapse the reasons — that is the whole point of
 * the wire shape.
 *
 * ── EVERY METRIC RENDERS A ROW, INCLUDING AN `unsupported` ONE ──────────────
 *
 * This is the ONE place this file deliberately diverges from its router twin,
 * and the divergence is a property of the two wire shapes rather than a taste
 * difference. `routerSignalMetricRows` DROPS an `unsupported` metric, because a
 * dongle dialect's metric set genuinely differs per vendor — the HiLink strip
 * has no SNR field at all — so a row there would report the radio as silent
 * about something it was never asked.
 *
 * `modemSignalDetailSchema` is TOTAL: the same four metrics are published for
 * every modem, always, precisely so a metric can be lowered again. A dropped row
 * would therefore silently shrink a fixed-shape strip, and an operator comparing
 * two modems would read the shorter one as a partial render. So each metric
 * keeps its row and each unknown reason gets its OWN word.
 *
 * ── AND A REASON IS A WORD, NEVER A MARK ───────────────────────────────────
 *
 * The seven reasons lead to genuinely different operator actions — the wire
 * schema states three of them explicitly (hide the control / wait for the next
 * sample / prime the read) — so rendering them all as an em-dash discards the
 * only information the block adds over a bare `null`. A `0` is worse still: it
 * is a reading the radio never took.
 *
 * Two reasons are load-bearing on today's fleet and must NOT be read as faults:
 *
 *  - `sinr` answers `not-reported` on every LTE/NR modem. ModemManager 1.24.2
 *    gives `sinr` to `Signal.Evdo` alone; `Lte`/`Nr5g` publish `snr`, a
 *    different quantity. So the metric is a READ-class unknown, not a
 *    capability claim ModemManager would disprove.
 *  - `cell_id` and `tac` answer `not-observed` on every board. ModemManager
 *    masks the `Location` property unless `Location.Setup` ran with
 *    `signal_location = true`, which is permanently forbidden here. That is the
 *    honest fence rendered honestly — nobody looked — and it is not a gap to
 *    close from this file.
 */

import type {
	ModemFlagMetric,
	ModemMetricUnknownReason,
	ModemNumberMetric,
	ModemRegistrationContext,
	ModemSignalDetail,
	ModemSimPresenceEvidence,
	ModemTextMetric,
} from "@ceraui/rpc/schemas";

const DETAIL = "network.modem.detail";
const EVIDENCE = "network.modem.simEvidence";

/**
 * One operator sentence per unknown reason. TOTAL over the wire enum, so an
 * eighth reason fails the typecheck rather than reaching an operator as its own
 * dotted path.
 */
export const MODEM_METRIC_REASON_KEYS: Readonly<
	Record<ModemMetricUnknownReason, string>
> = {
	unsupported: `${DETAIL}.reason.unsupported`,
	"not-reported": `${DETAIL}.reason.notReported`,
	"not-observed": `${DETAIL}.reason.notObserved`,
	malformed: `${DETAIL}.reason.malformed`,
	"auth-expired": `${DETAIL}.reason.authExpired`,
	refused: `${DETAIL}.reason.refused`,
	unreachable: `${DETAIL}.reason.unreachable`,
};

export function modemMetricReasonKey(reason: ModemMetricUnknownReason): string {
	return MODEM_METRIC_REASON_KEYS[reason];
}

/** One rendered line of a metric strip. */
export type ModemMetricRow<Id extends string> =
	| {
			readonly id: Id;
			readonly labelKey: string;
			readonly state: "known";
			/** Already formatted, unit included. Never a bare number for a ratio. */
			readonly value: string;
	  }
	| {
			readonly id: Id;
			readonly labelKey: string;
			readonly state: "unknown";
			readonly reason: ModemMetricUnknownReason;
			readonly reasonKey: string;
	  };

// ── The extended radio measurements ─────────────────────────────────────────

export type ModemSignalMetricId = "rsrp" | "rsrq" | "snr" | "sinr";

/**
 * Display order: received POWER first, then the three quality ratios.
 *
 * `rsrp` is dBm and the ratios are dB — folding them onto one unit is the same
 * class of error as folding `snr` into `sinr`, which the wire schema keeps apart
 * for exactly this reason.
 */
const SIGNAL_METRICS: readonly {
	readonly id: ModemSignalMetricId;
	readonly unit: string;
}[] = [
	{ id: "rsrp", unit: "dBm" },
	{ id: "rsrq", unit: "dB" },
	{ id: "snr", unit: "dB" },
	{ id: "sinr", unit: "dB" },
];

const SIGNAL_LABEL_KEYS: Readonly<Record<ModemSignalMetricId, string>> = {
	rsrp: `${DETAIL}.rsrp`,
	rsrq: `${DETAIL}.rsrq`,
	snr: `${DETAIL}.snr`,
	sinr: `${DETAIL}.sinr`,
};

/**
 * A `known` metric whose value is not a finite number reads as `malformed`.
 *
 * The `modems` broadcast is CAST rather than parsed, so a producer bug can put a
 * non-number behind `state: 'known'`. Rendering it verbatim would print `NaN`
 * where a measurement belongs; `malformed` is the reason the wire vocabulary
 * already carries for "the source answered with something this layer could not
 * decode", so it is the honest landing place rather than a new one.
 */
function numberRow<Id extends string>(
	id: Id,
	labelKey: string,
	metric: ModemNumberMetric,
	unit: string,
): ModemMetricRow<Id> {
	if (metric.state === "known") {
		return Number.isFinite(metric.value)
			? { id, labelKey, state: "known", value: `${metric.value} ${unit}` }
			: unknownRow(id, labelKey, "malformed");
	}
	return unknownRow(id, labelKey, metric.reason);
}

function unknownRow<Id extends string>(
	id: Id,
	labelKey: string,
	reason: ModemMetricUnknownReason,
): ModemMetricRow<Id> {
	return {
		id,
		labelKey,
		state: "unknown",
		reason,
		reasonKey: MODEM_METRIC_REASON_KEYS[reason],
	};
}

/**
 * The four extended measurements, in display order.
 *
 * An absent BLOCK yields an empty list — the mmcli backend reads no
 * `Modem.Signal` interface at all, so publishing four `not-observed` rows for it
 * would claim a read it never attempted. An absent block is "this backend did
 * not observe it", never "the modem has none".
 */
export function signalDetailRows(
	detail: ModemSignalDetail | undefined,
): ModemMetricRow<ModemSignalMetricId>[] {
	if (!detail) return [];
	return SIGNAL_METRICS.map(({ id, unit }) =>
		numberRow(id, SIGNAL_LABEL_KEYS[id], detail[id], unit),
	);
}

// ── When the modem last MEASURED, which is not when we last READ ────────────

/**
 * The recency indicator.
 *
 * `quality_recent` is the `b` of ModemManager's `SignalQuality` `(ub)` and is a
 * fact about the MODEM's own measurement, not about the freshness of our
 * envelope — the two are independent, and `getIsConnected()`-driven staleness
 * already covers the second. A stale 40% and a live 40% are indistinguishable
 * without it, which is precisely the case an operator diagnosing a marginal link
 * is trying to tell apart.
 */
export type ModemQualityRecency =
	| { readonly state: "recent"; readonly labelKey: string }
	| { readonly state: "cached"; readonly labelKey: string }
	| {
			readonly state: "unknown";
			readonly reason: ModemMetricUnknownReason;
			readonly labelKey: string;
	  };

export function qualityRecency(
	detail: ModemSignalDetail | undefined,
): ModemQualityRecency | undefined {
	if (!detail) return undefined;
	return recencyOf(detail.quality_recent);
}

function recencyOf(metric: ModemFlagMetric): ModemQualityRecency {
	if (metric.state === "known") {
		return metric.value
			? { state: "recent", labelKey: `${DETAIL}.recencyLive` }
			: { state: "cached", labelKey: `${DETAIL}.recencyCached` };
	}
	return {
		state: "unknown",
		reason: metric.reason,
		labelKey: MODEM_METRIC_REASON_KEYS[metric.reason],
	};
}

// ── Which NETWORK and which CELL ────────────────────────────────────────────

export type ModemRegistrationMetricId =
	| "operator_name"
	| "operator_code"
	| "cell_id"
	| "tac";

/** Coarsest first: the network, its code, then the cell inside it. */
const REGISTRATION_METRICS: readonly ModemRegistrationMetricId[] = [
	"operator_name",
	"operator_code",
	"cell_id",
	"tac",
];

const REGISTRATION_LABEL_KEYS: Readonly<
	Record<ModemRegistrationMetricId, string>
> = {
	operator_name: `${DETAIL}.operatorName`,
	operator_code: `${DETAIL}.operatorCode`,
	cell_id: `${DETAIL}.cellId`,
	tac: `${DETAIL}.tac`,
};

/**
 * A blank string behind `state: 'known'` is not an identifier — it is a field
 * the producer could not fill, so it lands on `malformed` rather than rendering
 * an empty cell that reads as a successful read of nothing.
 */
function textRow<Id extends string>(
	id: Id,
	labelKey: string,
	metric: ModemTextMetric,
): ModemMetricRow<Id> {
	if (metric.state === "known") {
		const value = metric.value.trim();
		return value.length > 0
			? { id, labelKey, state: "known", value }
			: unknownRow(id, labelKey, "malformed");
	}
	return unknownRow(id, labelKey, metric.reason);
}

/**
 * Operator name/code plus the serving cell's identifiers.
 *
 * `operator_name` duplicates `status.network` DELIBERATELY: `status` omits the
 * field when the modem reported none, which destroys the distinction between
 * "not registered yet" and "this backend never looked". The row here keeps the
 * reason; the legacy field keeps its shape.
 */
export function registrationRows(
	context: ModemRegistrationContext | undefined,
): ModemMetricRow<ModemRegistrationMetricId>[] {
	if (!context) return [];
	return REGISTRATION_METRICS.map((id) =>
		textRow(id, REGISTRATION_LABEL_KEYS[id], context[id]),
	);
}

/**
 * Metric keys the normalized block SUPERSEDES on the legacy `cell_info` strip.
 *
 * Both blocks can express the same four quantities, and two rows labelled RSRP
 * carrying different numbers is worse than either alone. The normalized block
 * wins because it is the only one that can say WHY a value is missing — the same
 * precedence `router-signal` applies to the legacy `signal_bars` scalars. When
 * the block is absent the legacy strip is untouched.
 */
export const SUPERSEDED_CELL_METRIC_KEYS: readonly string[] = [
	"rsrp",
	"rsrq",
	"snr",
	"sinr",
];

// ── WHICH FACT decided the SIM verdict ──────────────────────────────────────

/**
 * The evidence hint, resolved to keyed copy.
 *
 * It exists because the no-SIM banner is BINARY — it renders the bond gate's
 * verdict, and bonding is binary — so it cannot distinguish a slot the modem
 * positively reported empty from a slot nothing could read. `absent` is
 * reachable through exactly ONE evidence kind (`state-failed-reason`), which is
 * what makes that distinction verifiable rather than a promise.
 *
 * The evidence `value` fields carry D-Bus object paths and ModemManager's own
 * failed-reason token. NONE of them is rendered: a machine identifier in
 * operator copy is the OL-2 defect, and the KIND is the whole of what an
 * operator can act on. The raw values stay available through the marked
 * diagnostics block, which is where relocation puts them.
 */
export interface ModemSimEvidenceHint {
	readonly kind: ModemSimPresenceEvidence["kind"];
	readonly key: string;
	readonly params?: Readonly<Record<string, unknown>>;
	/** True only for the one kind that positively states an empty slot. */
	readonly statesEmptySlot: boolean;
}

const EVIDENCE_KEYS: Readonly<
	Record<ModemSimPresenceEvidence["kind"], string>
> = {
	"sim-object-path": `${EVIDENCE}.simObjectPath`,
	"sim-slot-object-path": `${EVIDENCE}.simSlotObjectPath`,
	"state-failed-reason": `${EVIDENCE}.stateFailedReason`,
	"no-evidence": `${EVIDENCE}.noEvidence`,
	"vendor-code-unclaimed": `${EVIDENCE}.vendorCodeUnclaimed`,
};

export function simPresenceEvidenceHint(
	evidence: ModemSimPresenceEvidence | undefined,
): ModemSimEvidenceHint | undefined {
	if (!evidence) return undefined;
	const key = EVIDENCE_KEYS[evidence.kind];
	const statesEmptySlot = evidence.kind === "state-failed-reason";
	if (evidence.kind === "no-evidence") {
		// The COUNT, never the field names: `simSlots`/`failedReason` are wire
		// identifiers, and how many places were checked is the part that tells an
		// operator whether the read was thorough.
		return {
			kind: evidence.kind,
			key,
			params: { count: evidence.inspected.length },
			statesEmptySlot,
		};
	}
	return { kind: evidence.kind, key, statesEmptySlot };
}

/**
 * Whether the normalized blocks have anything to render.
 *
 * The detail card is gated on its own evidence, like every other card on this
 * surface: a modem that published a `Modem.Signal` reading is worth the card
 * even when it reported no cell info, no eSIM and no firmware.
 */
export function hasNormalizedReading(modem: {
	signal_detail?: ModemSignalDetail | undefined;
	registration_context?: ModemRegistrationContext | undefined;
}): boolean {
	return (
		modem.signal_detail !== undefined ||
		modem.registration_context !== undefined
	);
}
