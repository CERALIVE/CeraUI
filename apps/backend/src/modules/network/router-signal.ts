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
 * Reading each vendor dialect's own admin-API bodies into the normalized signal
 * model (todo 20).
 *
 * The model itself — the metric algebra, the per-dialect support matrix, and
 * the whole-device degradations — is `router-signal-model.ts`, re-exported here
 * so a consumer has one import. This file holds only the part that changes when
 * a vendor firmware does: which endpoint carries which quantity, and under what
 * name.
 *
 * Every function here is pure, so the whole matrix is provable against the
 * bodies the bench dongles actually returned.
 */

import {
	AUTH_EXPIRED,
	barsFrom,
	buildSignalModel,
	MALFORMED,
	metricFrom,
	NOT_REPORTED,
	parseJsonObject,
	type RouterSignalMetric,
	type RouterSignalModel,
	ZTE_BAR_SCALE,
} from "./router-signal-model.ts";
import { xmlValue } from "./vendor-xml.ts";

export * from "./router-signal-model.ts";

// ── HiLink ──────────────────────────────────────────────────────────────────

/**
 * `125002` is the code EVERY HiLink endpoint answers without a valid session
 * token — measured on both bench twins. It is an authentication refusal, not a
 * statement about the radio, so it must never read as "no signal".
 */
const HILINK_AUTH_REFUSED_RE = /<code>\s*125002\s*<\/code>/;
const HILINK_RESPONSE_RE = /<response>/i;

export function hilinkAuthRefused(body: string): boolean {
	return HILINK_AUTH_REFUSED_RE.test(body);
}

export type HilinkSignalBodies = {
	/** `/api/monitoring/status` — the bar count and the device's own scale. */
	readonly status: string;
	/** `/api/device/signal` — the radio quantities. */
	readonly signal: string;
};

export function parseHilinkSignal(
	bodies: HilinkSignalBodies,
): RouterSignalModel {
	const statusRefused = hilinkAuthRefused(bodies.status);
	const signalRefused = hilinkAuthRefused(bodies.signal);
	const fromStatus = (tag: string): RouterSignalMetric =>
		statusRefused ? AUTH_EXPIRED : barsFrom(xmlValue(bodies.status, tag));
	const fromSignal = (tag: string): RouterSignalMetric =>
		signalRefused ? AUTH_EXPIRED : metricFrom(xmlValue(bodies.signal, tag));

	// A refusal is not a read, and neither is an empty body. Only a document the
	// device actually answered with makes this cycle's reading `live`.
	const answered =
		HILINK_RESPONSE_RE.test(bodies.status) ||
		HILINK_RESPONSE_RE.test(bodies.signal);

	return buildSignalModel({
		dialect: "hilink",
		freshness: answered ? "live" : "unknown",
		fallback: "not-reported",
		metrics: {
			bars: fromStatus("SignalIcon"),
			max_bars: fromStatus("maxsignal"),
			dbm: fromSignal("rssi"),
			rsrp: fromSignal("rsrp"),
			rsrq: fromSignal("rsrq"),
			sinr: fromSignal("sinr"),
		},
	});
}

// ── ZTE ─────────────────────────────────────────────────────────────────────

export function parseZteSignal(body: string): RouterSignalModel {
	const parsed = parseJsonObject(body);
	if (parsed === undefined) {
		// An empty body is nothing to parse; anything else was a body the device
		// sent that this dialect cannot read — a login page, an error document.
		return buildSignalModel({
			dialect: "zte",
			freshness: "unknown",
			fallback: body.trim() === "" ? "not-reported" : "malformed",
		});
	}
	const bars = barsFrom(parsed.signalbar);

	return buildSignalModel({
		dialect: "zte",
		freshness: "live",
		fallback: "not-reported",
		metrics: {
			bars,
			max_bars:
				bars.state === "known"
					? { state: "known", value: ZTE_BAR_SCALE }
					: NOT_REPORTED,
			dbm: metricFrom(parsed.rssi),
			rsrp: metricFrom(parsed.lte_rsrp),
			rsrq: metricFrom(parsed.lte_rsrq),
			snr: metricFrom(parsed.lte_snr),
		},
	});
}

// ── Qualcomm / HiMI UFI ─────────────────────────────────────────────────────

/** What every `himiapi` command answers before login or after expiry. */
const UFI_SESSION_OUT = "SessionOut";

export type UfiSignalBodies = {
	readonly sysinfo: string;
	readonly overview: string;
	readonly status: string;
};

/**
 * The dBm figure appears in more than one command's payload on this firmware,
 * so the reads are tried in order and the FIRST that states a number wins. The
 * order is evidential: `getsysinfo` is where the bench unit carried `SIGNAL`.
 */
export function parseUfiSignal(bodies: UfiSignalBodies): RouterSignalModel {
	const candidates: ReadonlyArray<readonly [string, string]> = [
		[bodies.sysinfo, "SIGNAL"],
		[bodies.overview, "SIGNAL"],
		[bodies.status, "signalStrength"],
	];

	let answered = false;
	let refused = false;
	let degraded: RouterSignalMetric | undefined;

	for (const [body, key] of candidates) {
		const parsed = parseJsonObject(body);
		if (parsed === undefined) {
			if (body.trim() !== "") degraded ??= MALFORMED;
			continue;
		}
		if (parsed.reply === UFI_SESSION_OUT) {
			refused = true;
			continue;
		}
		const params = parsed.params;
		if (
			typeof params !== "object" ||
			params === null ||
			Array.isArray(params)
		) {
			continue;
		}
		answered = true;
		const metric = metricFrom((params as Record<string, unknown>)[key]);
		if (metric.state === "known") {
			return buildSignalModel({
				dialect: "ufi",
				freshness: "live",
				fallback: "not-reported",
				metrics: { dbm: metric },
			});
		}
		degraded ??= metric;
	}

	// A command that answered and simply omitted the field outranks a refusal
	// elsewhere: we DID reach the device, it just said nothing about the radio.
	const dbm = degraded ?? (refused ? AUTH_EXPIRED : NOT_REPORTED);
	return buildSignalModel({
		dialect: "ufi",
		freshness: answered ? "live" : "unknown",
		fallback: "not-reported",
		metrics: { dbm },
	});
}
