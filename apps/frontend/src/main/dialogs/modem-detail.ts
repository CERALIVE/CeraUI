/**
 * ModemConfigDialog's read-only detail derivations — PURE and rune-free.
 *
 * The dialog is the ADVANCED surface for one modem: everything `CellularSection`
 * deliberately keeps off its calm summary row lives here. Every field these
 * helpers read is a Phase-B ADDITIVE-OPTIONAL wire field, so the one property
 * that matters more than any layout decision is:
 *
 *   ABSENCE RENDERS AS ABSENCE — never as a zero, a dash, or a fabricated unit.
 *
 * An old backend (or the mmcli path, which reports none of this) omits the whole
 * `cell_info` / `esim` / `data_usage` object; a newer one can omit any individual
 * key inside it. Both must degrade to "that row is not there", and the card that
 * owned it must vanish rather than render an empty frame. Each helper therefore
 * answers with an EMPTY LIST or `undefined` rather than a partially-populated
 * shape the component would have to re-check.
 *
 * Two derivations here are decisions, not formatting:
 *
 *  - `defaultAutoApn` implements the annex "Automatic (recommended)" default, and
 *    it is deliberately NOT `autoconfig ?? true`. A modem carrying a stored manual
 *    APN with no explicit `autoconfig` flag is an OLD CONFIG the operator wrote,
 *    and flipping it to Automatic on open would silently discard their APN on the
 *    next save. Only a genuinely unconfigured modem gets the new default.
 *  - `usageView` never divides by a zero advisory limit and never clamps the
 *    OVER-limit verdict away: the bar stops at full, the verdict does not. The
 *    limit is advisory in both directions — it gates nothing.
 */

import type {
	ModemCellInfo,
	ModemConfig,
	ModemDataUsage,
	ModemEsim,
} from "@ceraui/rpc/schemas";

const DETAIL = "network.modem.detail";

/**
 * Serving-cell metrics, in the order an operator reads them: what radio, where
 * on it, which cell, then the four quality figures.
 *
 * `snr` and `sinr` are BOTH kept and are never folded together — LTE reports a
 * signal-to-noise ratio and NR reports signal-to-interference-plus-noise, so a
 * surface that renders one under the other's label reports a number the radio
 * never produced (the schema states this; this is the render side of it).
 */
export type CellMetricKey =
	| "tech"
	| "band"
	| "cell_id"
	| "rsrp"
	| "rsrq"
	| "snr"
	| "sinr";

export interface CellMetricRow {
	readonly key: CellMetricKey;
	/** i18n dot-path for the row's label. */
	readonly labelKey: string;
	/** Literal value for a string/number metric. Mutually exclusive with `valueKey`. */
	readonly value?: string;
	/** i18n dot-path for an ENUM-valued metric (`tech`). Never rendered raw. */
	readonly valueKey?: string;
	/** SI unit symbol, appended verbatim — a symbol is not translated copy. */
	readonly unit?: string;
}

const TECH_VALUE_KEY = {
	lte: `${DETAIL}.techLte`,
	nr: `${DETAIL}.techNr`,
	unknown: `${DETAIL}.techUnknown`,
} as const;

/** A finite number is a reading; anything else was not reported. */
function reading(value: number | undefined): string | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? String(value)
		: undefined;
}

/** A blank string is not a cell id — it is a field the adapter could not fill. */
function text(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function cellMetricRows(
	cell: ModemCellInfo | undefined,
): CellMetricRow[] {
	if (!cell) return [];
	const rows: CellMetricRow[] = [];

	if (cell.tech !== undefined) {
		rows.push({
			key: "tech",
			labelKey: `${DETAIL}.tech`,
			valueKey: TECH_VALUE_KEY[cell.tech],
		});
	}

	const band = text(cell.band);
	if (band !== undefined) {
		rows.push({ key: "band", labelKey: `${DETAIL}.band`, value: band });
	}

	const cellId = text(cell.cell_id);
	if (cellId !== undefined) {
		rows.push({ key: "cell_id", labelKey: `${DETAIL}.cellId`, value: cellId });
	}

	// RSRP is an absolute power (dBm); RSRQ/SNR/SINR are ratios (dB). Do not
	// share one unit across the four — they are not the same quantity.
	const rsrp = reading(cell.rsrp);
	if (rsrp !== undefined) {
		rows.push({
			key: "rsrp",
			labelKey: `${DETAIL}.rsrp`,
			value: rsrp,
			unit: "dBm",
		});
	}

	const rsrq = reading(cell.rsrq);
	if (rsrq !== undefined) {
		rows.push({
			key: "rsrq",
			labelKey: `${DETAIL}.rsrq`,
			value: rsrq,
			unit: "dB",
		});
	}

	const snr = reading(cell.snr);
	if (snr !== undefined) {
		rows.push({
			key: "snr",
			labelKey: `${DETAIL}.snr`,
			value: snr,
			unit: "dB",
		});
	}

	const sinr = reading(cell.sinr);
	if (sinr !== undefined) {
		rows.push({
			key: "sinr",
			labelKey: `${DETAIL}.sinr`,
			value: sinr,
			unit: "dB",
		});
	}

	return rows;
}

/**
 * When the serving-cell reading was taken, in epoch milliseconds.
 *
 * The wire says only "an integer"; a producer may reasonably send either epoch
 * seconds or epoch milliseconds. A seconds value is ~1e9 and a milliseconds
 * value ~1e12 for every date this product will ever see, so the magnitude
 * discriminates them without a wire change. A non-positive or non-finite stamp
 * is NOT a time and yields `undefined`, which renders the honest
 * "the modem did not say when" line rather than 1970.
 */
const EPOCH_MS_FLOOR = 1e12;

export function cellObservedAtMs(
	cell: ModemCellInfo | undefined,
): number | undefined {
	const raw = cell?.provenance?.observed_at;
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
		return undefined;
	}
	return raw < EPOCH_MS_FLOOR ? raw * 1000 : raw;
}

/**
 * The read-only eSIM facts. There is NO management affordance anywhere on this
 * path by design: the EID is a redaction class and is not on the wire, and
 * profile management belongs to the carrier's own flow — a button here could
 * only ever lie about what it would do.
 */
export interface EsimView {
	/** i18n dot-path naming the SIM kind. Always present when the view exists. */
	readonly typeKey: string;
	/** i18n dot-path naming the profile state. Absent when unreported. */
	readonly statusKey?: string;
	/** True only for a positively-reported eSIM — drives the emphasis, not the row. */
	readonly isEsim: boolean;
}

const SIM_TYPE_KEY = {
	physical: `${DETAIL}.simTypePhysical`,
	esim: `${DETAIL}.simTypeEsim`,
	unknown: `${DETAIL}.simTypeUnknown`,
} as const;

const ESIM_STATUS_KEY = {
	"no-profiles": `${DETAIL}.esimNoProfiles`,
	"with-profiles": `${DETAIL}.esimWithProfiles`,
	unknown: `${DETAIL}.esimStatusUnknown`,
} as const;

export function esimView(esim: ModemEsim | undefined): EsimView | undefined {
	if (!esim) return undefined;
	const { sim_type: simType, esim_status: status } = esim;
	// A profile state with no SIM kind is still worth showing — but an object
	// carrying neither is an empty observation, and an empty badge is noise.
	if (simType === undefined && status === undefined) return undefined;

	return {
		typeKey: SIM_TYPE_KEY[simType ?? "unknown"],
		...(status === undefined ? {} : { statusKey: ESIM_STATUS_KEY[status] }),
		isEsim: simType === "esim",
	};
}

/**
 * The usage meter's rendered shape.
 *
 * Both counters are REQUIRED inside the optional `data_usage` object, so a
 * usage card either has both figures or does not exist — there is no
 * half-populated state to render. `cycle_day` and `threshold_bytes` are the
 * operator's configured meter bounds and are READ-ONLY on this wire; see the
 * card's own comment for why no control writes them.
 */
export interface UsageView {
	readonly sessionBytes: number;
	readonly cycleBytes: number;
	readonly cycleDay?: number;
	readonly thresholdBytes?: number;
	/** 0–100 share of the advisory limit. Absent when no usable limit was reported. */
	readonly thresholdPercent?: number;
	/** The cycle has passed the advisory limit. Advisory ONLY — it gates nothing. */
	readonly overThreshold: boolean;
}

export function usageView(
	usage: ModemDataUsage | undefined,
): UsageView | undefined {
	if (!usage) return undefined;
	const { session_bytes: session, cycle_bytes: cycle } = usage;
	if (!Number.isFinite(session) || !Number.isFinite(cycle)) return undefined;

	const threshold = usage.threshold_bytes;
	const hasThreshold =
		typeof threshold === "number" && Number.isFinite(threshold);
	// A zero limit has no denominator, so it draws no bar — but "you are past it"
	// is still true and must survive, which is why the verdict is computed
	// independently of the percentage rather than derived from it.
	const percent =
		hasThreshold && threshold > 0
			? Math.min(100, Math.round((cycle / threshold) * 100))
			: undefined;

	return {
		sessionBytes: session,
		cycleBytes: cycle,
		...(usage.cycle_day === undefined ? {} : { cycleDay: usage.cycle_day }),
		...(hasThreshold ? { thresholdBytes: threshold } : {}),
		...(percent === undefined ? {} : { thresholdPercent: percent }),
		overThreshold: hasThreshold && cycle > threshold,
	};
}

/**
 * The annex "Automatic (recommended)" default, applied ONLY to a modem nobody
 * has configured.
 *
 * `autoconfig ?? true` would be wrong: a config carrying a manual APN and no
 * explicit flag predates the flag, and opening the dialog on it would show
 * Automatic — so the operator's stored APN would be discarded by the very next
 * Save, silently. An explicit flag always wins; absent a flag, a stored APN
 * means manual and an empty one means unconfigured.
 */
export function defaultAutoApn(config: ModemConfig | undefined): boolean {
	if (!config) return true;
	if (typeof config.autoconfig === "boolean") return config.autoconfig;
	return config.apn.trim().length === 0;
}

/**
 * Whether the detail card has anything to say. An empty framed section with a
 * heading and no rows is worse than no section: it reads as a load failure.
 */
export function hasModemDetail(input: {
	cell_info?: ModemCellInfo | undefined;
	esim?: ModemEsim | undefined;
	firmware_revision?: string | undefined;
}): boolean {
	return (
		cellMetricRows(input.cell_info).length > 0 ||
		text(input.firmware_revision) !== undefined ||
		esimView(input.esim) !== undefined
	);
}

/** The firmware string, or `undefined` when the modem reported none. */
export function firmwareRevision(
	value: string | undefined,
): string | undefined {
	return text(value);
}

/**
 * Refusals that will answer IDENTICALLY on every retry, so the control that
 * triggers them must stop being offered once the device has said so.
 *
 * `uncertified` is the important one and is not a stopgap: the certified
 * catalog ships EMPTY pending real evidence bundles, so it is what every real
 * modem answers today and will keep answering until certification lands. A red
 * "error" band that invites a retry would be a lie about what a retry does —
 * this is a standing property of the device, rendered calmly, with the active
 * mode still working. `provisioning_disabled` is the same shape: a device-level
 * setting, not a transient failure.
 *
 * Everything else (`streaming_active`, `transition_in_progress`,
 * `transition_failed`, …) names a condition that can change, so those keep the
 * error treatment AND keep the button.
 */
export function isStandingUsbRefusal(
	refusal: string | undefined,
): refusal is "uncertified" | "provisioning_disabled" {
	return refusal === "uncertified" || refusal === "provisioning_disabled";
}
