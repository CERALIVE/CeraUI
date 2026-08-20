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
 * The NON-SIGNAL half of what a ZTE or UFI dongle states about itself (todo 23).
 *
 * Todo 20 normalized the radio quantities into their own model, because a
 * missing number there has to say WHY it is missing. These fields are different
 * in kind: they are strings the device either published or did not, so the
 * honest shape is a plain record whose absent keys are simply absent. There is
 * no "unknown" member and no placeholder — a field this dongle did not state
 * renders no row at all, which is the same rule the shipped fact strip already
 * follows.
 *
 * ── WHY THERE IS NO WRITE HERE, IN ANY FORM ─────────────────────────────────
 *
 * Both dialects are READ-ONLY by measurement, not by caution:
 * `router-cellular-admin.ts`'s header records that every operator-meaningful
 * ZTE `goform_set_cmd_process` verb answers `{"result":"failure"}` on the bench
 * firmware, and that the UFI's one observed setter removes the very interface
 * its management path runs over. This module therefore parses and nothing else,
 * and `router-read-expansion.test.ts` greps it (comment-stripped, so this
 * paragraph may name the verbs it refuses) plus enumerates its exports.
 *
 * ── WHY CANDIDATE SPELLINGS, RATHER THAN ONE KEY EACH ───────────────────────
 *
 * The ZTE keys ride ONE `multi_data` list, so asking for a second spelling of a
 * field costs no request — the device echoes whatever it does not know as an
 * empty string, which this reader already treats as "not stated". That makes a
 * short candidate ladder strictly better than one guess per field across the
 * OEM builds this fleet actually meets. The same shape is what `parseUfiSignal`
 * already does for the dBm figure that appears under two commands.
 */

import { parseJsonObject } from "./router-signal-model.ts";

/**
 * What the dongle's own admin API said about itself, beyond the radio metrics.
 *
 * Every field is optional and an absent field means the device did not state
 * it. A value here was published by the device verbatim — never translated,
 * never defaulted, and never a placeholder the vendor uses for "unset".
 */
export type RouterAdminDetails = {
	/** Radio access technology as the device names it (ZTE `network_type`). */
	network_type?: string;
	/** The operator the device says it is on (ZTE `network_provider`, UFI `carrier`). */
	provider?: string;
	/** Serving-cell identifier, as published — never re-based or re-formatted. */
	cell_id?: string;
	/** Band label as the device names it, e.g. `B4`. */
	band?: string;
	/** The UFI's own radio-mode selection (`getnetworkmode` `netmode`). */
	network_mode?: string;
	/** WAN-side address the dongle holds on the carrier's network. */
	wan_ip?: string;
	imsi?: string;
	iccid?: string;
	/** The dongle's own WiFi network name, where it runs one. */
	ssid?: string;
	/** The vendor's product record (`getproduceinfo`). */
	product?: string;
};

/**
 * The vendor's own "unset" placeholders. The bench UFI answers `-` for a WAN
 * address, an IMSI and an ICCID it does not have, and publishing that as a
 * reading would put a dash on screen that reads like a real value.
 */
const PLACEHOLDERS: ReadonlySet<string> = new Set(["-", "--", "n/a", "N/A"]);

/**
 * A stated value, or `undefined`. Numbers are accepted because the UFI answers
 * some fields numerically; they are stringified rather than reformatted, so the
 * operator sees exactly what the device published.
 */
function detailValue(raw: unknown): string | undefined {
	if (typeof raw === "number") {
		return Number.isFinite(raw) ? String(raw) : undefined;
	}
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (trimmed === "" || PLACEHOLDERS.has(trimmed)) return undefined;
	return trimmed;
}

/** The FIRST candidate key the device stated wins; order is evidential. */
function firstStated(
	source: Record<string, unknown>,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const value = detailValue(source[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

/**
 * Build the block, or `undefined` when the device stated none of it. An EMPTY
 * object would reach the wire as a detail surface with nothing in it, which
 * reads as a failed read rather than as a device that had nothing to add.
 */
function compact(details: RouterAdminDetails): RouterAdminDetails | undefined {
	return Object.keys(details).length === 0 ? undefined : details;
}

function assign(
	details: RouterAdminDetails,
	key: keyof RouterAdminDetails,
	value: string | undefined,
): void {
	if (value !== undefined) details[key] = value;
}

// ── ZTE ─────────────────────────────────────────────────────────────────────

/**
 * The detail keys this dialect asks for, appended to the ONE `multi_data` list
 * the probe already sends. Exported so the request and the reader cannot
 * disagree about which keys were requested.
 */
export const ZTE_DETAIL_KEYS: readonly string[] = [
	"network_type",
	"network_provider",
	"provider",
	"cell_id",
	"lte_band",
	"band",
];

export function parseZteDetails(body: string): RouterAdminDetails | undefined {
	const parsed = parseJsonObject(body);
	if (parsed === undefined) return undefined;

	const details: RouterAdminDetails = {};
	assign(details, "network_type", firstStated(parsed, ["network_type"]));
	assign(
		details,
		"provider",
		firstStated(parsed, ["network_provider", "provider"]),
	);
	assign(details, "cell_id", firstStated(parsed, ["cell_id"]));
	assign(details, "band", firstStated(parsed, ["lte_band", "band"]));
	return compact(details);
}

// ── Qualcomm / HiMI UFI ─────────────────────────────────────────────────────

/** The command responses this reader draws on, keyed by the command that made them. */
export type UfiDetailBodies = {
	readonly overview?: string;
	readonly status?: string;
	readonly networkMode?: string;
	readonly produceInfo?: string;
};

/**
 * `params` of a `himiapi` response, or `undefined` for a body that was refused
 * (`SessionOut`), unreadable, or shaped some other way. A refusal is NOT a
 * device with nothing to say — it is simply nothing we may report.
 */
function ufiParams(
	body: string | undefined,
): Record<string, unknown> | undefined {
	if (body === undefined) return undefined;
	const parsed = parseJsonObject(body);
	const params = parsed?.params;
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		return undefined;
	}
	return params as Record<string, unknown>;
}

/**
 * The product record's key names were not transcribed on the bench (the command
 * was recorded as answering, not as answering WITH), so the plausible spellings
 * are tried and a device using none of them contributes nothing rather than a
 * guessed value.
 */
const UFI_PRODUCT_KEYS = [
	"product",
	"PRODUCT",
	"productname",
	"ProductName",
	"model",
	"MODEL",
];

export function parseUfiDetails(
	bodies: UfiDetailBodies,
): RouterAdminDetails | undefined {
	const overview = ufiParams(bodies.overview);
	const status = ufiParams(bodies.status);
	const networkMode = ufiParams(bodies.networkMode);
	const produceInfo = ufiParams(bodies.produceInfo);

	const details: RouterAdminDetails = {};
	if (status !== undefined) {
		assign(details, "provider", firstStated(status, ["carrier"]));
	}
	if (networkMode !== undefined) {
		assign(details, "network_mode", firstStated(networkMode, ["netmode"]));
	}
	if (overview !== undefined) {
		assign(details, "wan_ip", firstStated(overview, ["WANIP"]));
		assign(details, "imsi", firstStated(overview, ["IMSI"]));
		assign(details, "iccid", firstStated(overview, ["ICCID"]));
		assign(details, "ssid", firstStated(overview, ["SSID"]));
	}
	if (produceInfo !== undefined) {
		assign(details, "product", firstStated(produceInfo, UFI_PRODUCT_KEYS));
	}
	return compact(details);
}
