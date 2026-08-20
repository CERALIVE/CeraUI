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

/*
 * The vocabulary of the normalized router-dongle signal (todo 20).
 *
 * This half owns WHAT a reading is — the metric algebra, which quantity each
 * vendor dialect can express at all, and the three whole-device degradations.
 * `router-signal.ts` owns HOW each dialect's bodies are read into it. They are
 * split because the per-dialect parsers change whenever a firmware does, while
 * the rules below are the contract every consumer renders against.
 *
 * ── THE ONE RULE ────────────────────────────────────────────────────────────
 *
 * A metric is `known` ONLY when the device stated it. Everything else is
 * `unknown` WITH A REASON, and the reason is the whole point — five of them are
 * genuinely different operator facts:
 *
 *   unsupported   this DIALECT cannot express the quantity at all
 *   not-reported  the dialect can; the device left it blank this cycle
 *   malformed     the device sent something that is not a number
 *   auth-expired  the session was refused, so nothing was read
 *   unreachable   the admin API did not answer at all
 *
 * There is deliberately no path from any of them to a number. A `0` here is a
 * bar count or a dBm figure the device published — never a placeholder, never a
 * floor, never "we don't know so call it nothing".
 *
 * ── WHY `snr` AND `sinr` ARE SEPARATE FIELDS ────────────────────────────────
 *
 * The same rule `modemCellInfoSchema` already carries: LTE reports a
 * signal-to-noise ratio and NR reports signal-to-interference-plus-noise, and a
 * consumer reading one on a cell that published the other reads nothing. The
 * ZTE key is literally `lte_snr` and Huawei's is `sinr`, so each dialect fills
 * exactly one of the two and declares the other UNSUPPORTED. Folding them would
 * make the two dongles look interchangeable when they are not.
 */
import type {
	RouterAdminDialect,
	RouterAdminReading,
} from "./router-cellular-admin.ts";

/** Why a quantity is not a number. See the header — these are not synonyms. */
export type RouterSignalUnknownReason =
	| "unsupported"
	| "not-reported"
	| "malformed"
	| "auth-expired"
	| "unreachable";

export type RouterSignalMetric =
	| { readonly state: "known"; readonly value: number }
	| { readonly state: "unknown"; readonly reason: RouterSignalUnknownReason };

/**
 * `live` — this cycle's read reached the device.
 * `stale` — carried over from the PREVIOUS cycle because this one failed.
 * `unknown` — nothing was read, and nothing older was worth carrying.
 */
export type RouterSignalFreshness = "live" | "stale" | "unknown";

/**
 * Which vendor admin API produced the reading. It exists so a consumer can
 * distinguish a dongle's own web API from ModemManager's radio telemetry —
 * they are different instruments and must never be rendered as one.
 */
export type RouterSignalProvenance =
	| "hilink-admin-api"
	| "zte-goform"
	| "ufi-himiapi";

export type RouterSignalMetricId =
	| "bars"
	| "max_bars"
	| "dbm"
	| "rsrp"
	| "rsrq"
	| "snr"
	| "sinr";

export type RouterSignalModel = {
	readonly provenance: RouterSignalProvenance;
	readonly freshness: RouterSignalFreshness;
	/** Vendor bar count on the device's OWN scale — never rescaled here. */
	readonly bars: RouterSignalMetric;
	/** That scale's maximum, as the device stated it. */
	readonly max_bars: RouterSignalMetric;
	/** Received power in dBm (HiLink `rssi`, ZTE `rssi`, UFI `SIGNAL`). */
	readonly dbm: RouterSignalMetric;
	readonly rsrp: RouterSignalMetric;
	readonly rsrq: RouterSignalMetric;
	/** LTE signal-to-noise ratio. NOT interchangeable with `sinr`. */
	readonly snr: RouterSignalMetric;
	/** Signal-to-interference-plus-noise ratio. NOT interchangeable with `snr`. */
	readonly sinr: RouterSignalMetric;
};

const METRIC_IDS = [
	"bars",
	"max_bars",
	"dbm",
	"rsrp",
	"rsrq",
	"snr",
	"sinr",
] as const;

/**
 * What each dialect can express AT ALL — measured from the bodies the bench
 * dongles returned, not from a vendor datasheet. A quantity outside its
 * dialect's set is `unsupported` in every reading that dialect ever produces,
 * including an unreachable one: "this API has no such field" is a fact about
 * the protocol, not about today's connectivity.
 */
const SUPPORTED: Readonly<
	Record<RouterAdminDialect, ReadonlySet<RouterSignalMetricId>>
> = {
	// `/api/monitoring/status` → SignalIcon + maxsignal;
	// `/api/device/signal` → rssi/rsrp/rsrq/sinr. No snr key exists.
	hilink: new Set(["bars", "max_bars", "dbm", "rsrp", "rsrq", "sinr"]),
	// `goform_get_cmd_process` → signalbar/rssi/lte_rsrp/lte_rsrq/lte_snr.
	zte: new Set(["bars", "max_bars", "dbm", "rsrp", "rsrq", "snr"]),
	// `himiapi` publishes ONE scalar (`SIGNAL` / `signalStrength`) in dBm and no
	// bar scale whatsoever — inventing one would be the fabricated reading this
	// module exists to prevent.
	ufi: new Set(["dbm"]),
};

const PROVENANCE: Readonly<Record<RouterAdminDialect, RouterSignalProvenance>> =
	{
		hilink: "hilink-admin-api",
		zte: "zte-goform",
		ufi: "ufi-himiapi",
	};

/**
 * The ZTE web UI's own fixed scale. The device states a `signalbar` and never a
 * maximum, so this is published ONLY alongside a bar count it explains — a
 * scale with nothing on it tells an operator nothing and would read as a
 * measurement that was taken.
 */
export const ZTE_BAR_SCALE = 5;

export const UNSUPPORTED: RouterSignalMetric = {
	state: "unknown",
	reason: "unsupported",
};
export const NOT_REPORTED: RouterSignalMetric = {
	state: "unknown",
	reason: "not-reported",
};
export const MALFORMED: RouterSignalMetric = {
	state: "unknown",
	reason: "malformed",
};
export const AUTH_EXPIRED: RouterSignalMetric = {
	state: "unknown",
	reason: "auth-expired",
};

/** Vendors suffix their own unit onto the value (`-93dBm`, `-9dB`). */
const UNIT_SUFFIX_RE = /\s*dbm?$/i;
const NUMERIC_RE = /^[+-]?\d+(?:\.\d+)?$/;

export function metricFrom(raw: unknown): RouterSignalMetric {
	if (raw === undefined || raw === null) return NOT_REPORTED;
	if (typeof raw === "number") {
		return Number.isFinite(raw) ? { state: "known", value: raw } : MALFORMED;
	}
	if (typeof raw !== "string") return MALFORMED;
	const trimmed = raw.trim();
	if (trimmed === "") return NOT_REPORTED;
	const bare = trimmed.replace(UNIT_SUFFIX_RE, "").trim();
	if (!NUMERIC_RE.test(bare)) return MALFORMED;
	return { state: "known", value: Number(bare) };
}

/** A bar count is an index into a scale, so a fraction or a negative is drift. */
export function barsFrom(raw: unknown): RouterSignalMetric {
	const metric = metricFrom(raw);
	if (metric.state !== "known") return metric;
	return Number.isInteger(metric.value) && metric.value >= 0
		? metric
		: MALFORMED;
}

type SignalModelInput = {
	readonly dialect: RouterAdminDialect;
	readonly freshness: RouterSignalFreshness;
	/** Applied to every SUPPORTED metric this read did not resolve itself. */
	readonly fallback: RouterSignalUnknownReason;
	readonly metrics?: Partial<Record<RouterSignalMetricId, RouterSignalMetric>>;
};

export function buildSignalModel(input: SignalModelInput): RouterSignalModel {
	const supported = SUPPORTED[input.dialect];
	const fallback: RouterSignalMetric = {
		state: "unknown",
		reason: input.fallback,
	};
	const resolved = {} as Record<RouterSignalMetricId, RouterSignalMetric>;
	for (const id of METRIC_IDS) {
		resolved[id] = supported.has(id)
			? (input.metrics?.[id] ?? fallback)
			: UNSUPPORTED;
	}
	return {
		provenance: PROVENANCE[input.dialect],
		freshness: input.freshness,
		...resolved,
	};
}

export function parseJsonObject(
	body: string,
): Record<string, unknown> | undefined {
	if (body.trim() === "") return undefined;
	try {
		const value: unknown = JSON.parse(body);
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return undefined;
		}
		return value as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

// ── Whole-device degradation ────────────────────────────────────────────────

/** The admin API did not answer. Nothing was read; nothing may be claimed. */
export function unreachableSignal(
	dialect: RouterAdminDialect,
): RouterSignalModel {
	return buildSignalModel({
		dialect,
		freshness: "unknown",
		fallback: "unreachable",
	});
}

/** The session was refused. Distinct from unreachable — the device is there. */
export function authExpiredSignal(
	dialect: RouterAdminDialect,
): RouterSignalModel {
	return buildSignalModel({
		dialect,
		freshness: "unknown",
		fallback: "auth-expired",
	});
}

/** Re-serve a previous cycle's reading, labelled as the past tense it is. */
export function markSignalStale(model: RouterSignalModel): RouterSignalModel {
	return model.freshness === "stale" ? model : { ...model, freshness: "stale" };
}

/**
 * Carry ONE cycle's worth of last-known signal across a failed probe.
 *
 * A dongle that misses a single 30 s poll has not stopped transmitting, and
 * blanking its row on the first missed read makes the surface flicker. But a
 * carried value is not a measurement, so it is re-labelled `stale` and — the
 * load-bearing half — it is only ever carried from a `live` predecessor. A
 * stale reading therefore CANNOT renew itself: the second consecutive failure
 * drops it and the row reports the honest `unreachable`. There is no path here
 * that keeps a value alive indefinitely.
 */
export function carryForwardStaleSignals(
	previous: ReadonlyMap<string, RouterAdminReading>,
	next: ReadonlyMap<string, RouterAdminReading>,
): ReadonlyMap<string, RouterAdminReading> {
	const merged = new Map<string, RouterAdminReading>();
	for (const [ifname, reading] of next) {
		const priorSignal = previous.get(ifname)?.signal;
		const carryable =
			reading.signal !== undefined &&
			reading.signal.freshness === "unknown" &&
			priorSignal !== undefined &&
			priorSignal.freshness === "live";
		merged.set(
			ifname,
			carryable
				? { ...reading, signal: markSignalStale(priorSignal) }
				: reading,
		);
	}
	return merged;
}
