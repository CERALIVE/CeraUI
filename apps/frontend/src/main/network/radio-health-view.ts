/**
 * What the Radio health panel says, derived from one cached `RadioHealth`
 * record. Pure so the wording rules are testable without rendering.
 *
 * The backend reports one of three findings or `unknown`. `unknown` is not a
 * verdict on its own: only a registered modem whose row is connected reads OK,
 * a registered one without a data connection reads as registered, and a
 * missing or unknown registration says the check could not run. A missing SIM
 * outranks any cached finding. Signal is never a diagnosis here.
 */
import type { RadioHealth, RadioMetric } from "@ceraui/rpc/schemas";

export type RadioStatusKind =
	| "ok"
	| "registered"
	| "sim-account"
	| "data-path"
	| "disturbed"
	| "no-sim"
	| "not-registered"
	| "unchecked";

export type RadioTone = "success" | "warning" | "error" | "neutral";

export const RADIO_STATUS_TONE: Readonly<Record<RadioStatusKind, RadioTone>> = {
	ok: "success",
	registered: "neutral",
	"sim-account": "error",
	"data-path": "error",
	disturbed: "warning",
	"no-sim": "warning",
	"not-registered": "warning",
	unchecked: "neutral",
};

/** Exactly the states the backend's own data-path rule treats as registered. */
const REGISTERED = new Set(["home", "roaming", "registered", "connected"]);

export function isRegistered(value: RadioMetric["value"]): boolean {
	return typeof value === "string" && REGISTERED.has(value);
}

/**
 * Registered, but outside the backend's data-path rule: SMS-only service, or a
 * registration where the network prefers no circuit-switched fallback.
 * ModemManager reports these as registered; they never read OK here.
 */
const LIMITED = new Set([
	"home-sms-only",
	"roaming-sms-only",
	"home-csfb-not-preferred",
	"roaming-csfb-not-preferred",
]);

export function isLimitedRegistration(value: RadioMetric["value"]): boolean {
	return typeof value === "string" && LIMITED.has(value);
}

export type RegistrationWord =
	| "home"
	| "roaming"
	| "registered"
	| "sms-only"
	| "searching"
	| "idle"
	| "denied"
	| "other";

export function registrationWord(
	value: RadioMetric["value"],
): RegistrationWord {
	if (typeof value !== "string") return "other";
	if (value === "home") return "home";
	if (value === "roaming") return "roaming";
	if (value.endsWith("-sms-only")) return "sms-only";
	if (value.endsWith("-csfb-not-preferred")) return "registered";
	if (value === "registered" || value === "connected") return "registered";
	if (value === "searching") return "searching";
	if (value === "idle") return "idle";
	if (value === "denied") return "denied";
	return "other";
}

export function radioStatus(
	radio: RadioHealth,
	row: { noSim: boolean; connected: boolean },
): RadioStatusKind {
	if (row.noSim) return "no-sim";
	const kind = radio.finding.kind;
	if (kind !== "unknown") return kind;
	const reg = radio.registration.value;
	if (reg === null || reg === "unknown") return "unchecked";
	if (isRegistered(reg)) return row.connected ? "ok" : "registered";
	if (isLimitedRegistration(reg)) return "registered";
	return "not-registered";
}

/** "LTE + NR (NSA)" → "5G NSA"; unrecognised values pass through. */
export function networkType(value: RadioMetric["value"]): string | null {
	if (value === null) return null;
	const text = String(value);
	if (/NR \(SA\)|NR5G-SA/i.test(text)) return "5G SA";
	if (/NSA/i.test(text)) return "5G NSA";
	if (/^lte$/i.test(text)) return "LTE";
	if (/^(5gnr|nr)$/i.test(text)) return "5G";
	return text;
}

/** "LTE B3 + NR n78" → "B3 + n78": the band letter already names the layer. */
export function bandLabel(value: RadioMetric["value"]): string | null {
	if (value === null) return null;
	return String(value)
		.replace(/\bLTE\s+(?=B\d)/g, "")
		.replace(/\bNR\s+(?=n\d)/g, "");
}

export type SignalLevel = "high" | "medium" | "low";

/**
 * A rough guide on RSRP in dBm, the same for LTE and NR. It picks the bars and
 * the word in the readings dialog; it never produces a finding.
 */
export function signalLevel(dbm: number): SignalLevel {
	if (dbm >= -90) return "high";
	if (dbm >= -105) return "medium";
	return "low";
}

export interface SignalReading {
	tech: "lte" | "nr" | "other";
	dbm: number;
	level: SignalLevel;
}

/** RSRP per layer, preferring the serving-cell read over ModemManager's. */
export function signalReadings(radio: RadioHealth): SignalReading[] {
	const pick = (...keys: string[]): number | undefined => {
		for (const key of keys) {
			const metric = radio.metrics[key];
			if (metric && typeof metric.value === "number" && metric.unit === "dBm")
				return metric.value;
		}
		return undefined;
	};
	const out: SignalReading[] = [];
	const lte = pick("lte.rsrp");
	const nr = pick("nr.rsrp");
	if (lte !== undefined)
		out.push({ tech: "lte", dbm: lte, level: signalLevel(lte) });
	if (nr !== undefined)
		out.push({ tech: "nr", dbm: nr, level: signalLevel(nr) });
	if (out.length === 0) {
		const any = pick("mm.rsrp", "rsrp");
		if (any !== undefined)
			out.push({ tech: "other", dbm: any, level: signalLevel(any) });
	}
	return out;
}

/**
 * The status poll that refreshes these readings runs about every 30 s, with
 * up to 10 % jitter (the backend's STATUS_POLL_INTERVAL_MS). The countdown is
 * an estimate from the last reading; at zero the panel says it is checking.
 */
export const RADIO_POLL_MS = 30_000;

/** Whole seconds until the next reading is expected, or null without a reading. */
export function secondsToNextReading(
	capturedAt: number,
	now: number,
): number | null {
	if (!(capturedAt > 0) || now < capturedAt) return null;
	return Math.max(0, Math.ceil((capturedAt + RADIO_POLL_MS - now) / 1000));
}

/** "lte.rsrp" → "LTE RSRP", "nr.sinr" → "5G SINR", "lteTxPower" → "LTE TX". */
export function metricLabel(key: string): string {
	if (key === "lteTxPower") return "LTE TX";
	const [prefix, name] = key.includes(".") ? key.split(".", 2) : ["", key];
	const layer = prefix === "lte" ? "LTE " : prefix === "nr" ? "5G " : "";
	return `${layer}${(name ?? key).toUpperCase()}`;
}

/**
 * A serving-cell field the AT lease could not read carries a fixed reason in
 * its source: "QENG servingcell · not available: not-released". Split it so
 * the panel can show the reason in words; the token stays for support.
 */
export function splitSourceReason(source: string): {
	source: string;
	reason: string | null;
} {
	const match = source.match(
		/^(.*) · (?:not available|no reading): ([a-z-]+)$/,
	);
	return match?.[1] && match[2]
		? { source: match[1], reason: match[2] }
		: { source, reason: null };
}

export function formatValue(metric: RadioMetric): string | null {
	if (metric.value === null) return null;
	if (metric.unit === "raw") return `${metric.value} (raw)`;
	if (typeof metric.value === "number" && metric.unit && metric.unit !== "band")
		return `${metric.value} ${metric.unit}`;
	return String(metric.value);
}
