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
import { xmlValue } from "./vendor-xml.ts";

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

	// ── Registration + serving cell (the enrichment pass) ───────────────────
	/**
	 * Whether the radio is actually ON a network, in the device's own words —
	 * HiLink `workmode`, which reads `NO SERVICE` on a SIM-less bench unit and
	 * names the RAT (`LTE`, `WCDMA`, …) when it is registered. This is the fact
	 * that separates "a SIM is seated" from "the carrier accepted us", and it is
	 * deliberately NOT folded into `network_type`: a device can report a RAT it
	 * merely SUPPORTS while carrying no service.
	 */
	registration?: string;
	/** Physical cell id (ZTE `lte_pci`, HiLink `/api/device/signal` `pci`). */
	pci?: string;
	/** Mobile country code, as published (ZTE `rmcc`). */
	mcc?: string;
	/** Mobile network code, as published (ZTE `rmnc`). */
	mnc?: string;
	/** Whether the device says it is roaming, in its own words (ZTE `simcard_roam`). */
	roaming?: string;
	/** The band the WAN leg is active on (ZTE `wan_active_band`). */
	network_band?: string;
	/** Serving-cell channel bandwidth (HiLink `/api/device/signal` `lte_bandwidth`). */
	bandwidth?: string;
	/** The device's own carrier-aggregation flag (ZTE `wan_lte_ca`), verbatim. */
	carrier_aggregation?: string;
	/** Primary component carrier, as the device publishes it (ZTE `lte_ca_pcell_*`). */
	pcell_arfcn?: string;
	pcell_band?: string;
	pcell_bandwidth?: string;
	/** Secondary component carrier — present only while aggregation is up. */
	scell_arfcn?: string;
	scell_band?: string;
	scell_bandwidth?: string;

	// ── UFI device diagnostics ──────────────────────────────────────────────
	/**
	 * The UFI's `bsid`, verbatim and OPAQUE.
	 *
	 * The name suggests a base-station identifier and the vendor documents
	 * nothing, so this build makes NO claim about what it counts — it is carried
	 * and labelled as an unexplained device identifier. Do not rename this to
	 * anything that asserts a meaning the device never stated.
	 */
	station_id?: string;
	/** SoC temperature the UFI reports for itself (`getsysinfo` `cputemp`). */
	cpu_temp?: string;
	/** Clients on the dongle's own WiFi (`getsysinfo` `wifinum`). */
	wifi_clients?: string;
	/** Clients on the dongle's own Ethernet/USB leg (`getsysinfo` `ethnum`). */
	eth_clients?: string;
	/** The vendor web-UI build (`getoverview` `WEBVER`), distinct from firmware. */
	web_version?: string;

	// ── The DONGLE'S OWN traffic counters ───────────────────────────────────
	/**
	 * These are the dongle's LOCAL accounting, not CeraLive's, and they are NOT
	 * the bond's rate — `BondedLinksSection` owns that from the sender's own
	 * measurement. They are carried because a dongle's own monthly figure is what
	 * an operator compares against their carrier's bill, and nothing else in this
	 * stack can see it. Every render site must label them as the device's own.
	 */
	monthly_tx_bytes?: string;
	monthly_rx_bytes?: string;
	monthly_time?: string;
	monthly_period?: string;
	session_tx_bytes?: string;
	session_rx_bytes?: string;
	session_tx_rate?: string;
	session_rx_rate?: string;
	session_time?: string;
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
	"network_provider_fullname",
	"network_provider",
	"provider",
	"cell_id",
	"lte_band",
	"band",
	"lte_pci",
	"rmcc",
	"rmnc",
	"simcard_roam",
	"wan_active_band",
	"wan_lte_ca",
	"lte_ca_pcell_arfcn",
	"lte_ca_pcell_band",
	"lte_ca_pcell_bandwidth",
	"lte_ca_scell_arfcn",
	"lte_ca_scell_band",
	"lte_ca_scell_bandwidth",
	"monthly_tx_bytes",
	"monthly_rx_bytes",
	"monthly_time",
	"date_month",
	"realtime_tx_bytes",
	"realtime_rx_bytes",
	"realtime_tx_thrpt",
	"realtime_rx_thrpt",
	"realtime_time",
];

import { modemControlFunction } from "../modem-control-compat.ts";

const packagedParseZteDetails = modemControlFunction<
	typeof parseZteDetails | undefined
>("parseZteDetails", undefined);

export function parseZteDetails(body: string): RouterAdminDetails | undefined {
	if (packagedParseZteDetails !== undefined) {
		return packagedParseZteDetails(body);
	}
	const parsed = parseJsonObject(body);
	if (parsed === undefined) return undefined;

	const details: RouterAdminDetails = {};
	assign(details, "network_type", firstStated(parsed, ["network_type"]));
	// A NAME outranks the numeric PLMN the bench firmware answers under
	// `network_provider` (`732103`), which is an operator CODE rather than an
	// operator. Both are published verbatim; only the order between them is ours.
	assign(
		details,
		"provider",
		firstStated(parsed, [
			"network_provider_fullname",
			"network_provider",
			"provider",
		]),
	);
	assign(details, "cell_id", firstStated(parsed, ["cell_id"]));
	assign(details, "band", firstStated(parsed, ["lte_band", "band"]));
	assign(details, "pci", firstStated(parsed, ["lte_pci"]));
	assign(details, "mcc", firstStated(parsed, ["rmcc"]));
	assign(details, "mnc", firstStated(parsed, ["rmnc"]));
	assign(details, "roaming", firstStated(parsed, ["simcard_roam"]));
	assign(details, "network_band", firstStated(parsed, ["wan_active_band"]));
	assign(details, "carrier_aggregation", firstStated(parsed, ["wan_lte_ca"]));
	assign(details, "pcell_arfcn", firstStated(parsed, ["lte_ca_pcell_arfcn"]));
	assign(details, "pcell_band", firstStated(parsed, ["lte_ca_pcell_band"]));
	assign(
		details,
		"pcell_bandwidth",
		firstStated(parsed, ["lte_ca_pcell_bandwidth"]),
	);
	assign(details, "scell_arfcn", firstStated(parsed, ["lte_ca_scell_arfcn"]));
	assign(details, "scell_band", firstStated(parsed, ["lte_ca_scell_band"]));
	assign(
		details,
		"scell_bandwidth",
		firstStated(parsed, ["lte_ca_scell_bandwidth"]),
	);
	assign(
		details,
		"monthly_tx_bytes",
		firstStated(parsed, ["monthly_tx_bytes"]),
	);
	assign(
		details,
		"monthly_rx_bytes",
		firstStated(parsed, ["monthly_rx_bytes"]),
	);
	assign(details, "monthly_time", firstStated(parsed, ["monthly_time"]));
	assign(details, "monthly_period", firstStated(parsed, ["date_month"]));
	assign(
		details,
		"session_tx_bytes",
		firstStated(parsed, ["realtime_tx_bytes"]),
	);
	assign(
		details,
		"session_rx_bytes",
		firstStated(parsed, ["realtime_rx_bytes"]),
	);
	assign(
		details,
		"session_tx_rate",
		firstStated(parsed, ["realtime_tx_thrpt"]),
	);
	assign(
		details,
		"session_rx_rate",
		firstStated(parsed, ["realtime_rx_thrpt"]),
	);
	assign(details, "session_time", firstStated(parsed, ["realtime_time"]));
	return compact(details);
}

// ── Huawei HiLink ───────────────────────────────────────────────────────────

/**
 * The bodies this reader draws on — ALL of them already fetched by the existing
 * probe cycle, so the enrichment costs ZERO extra requests and zero extra
 * single-use session tokens.
 *
 * That is a measured decision, not a convenience. The endpoints the obvious
 * design would have added are refused by the bench firmware
 * (`22.333.01.00.00`): `/api/net/cell-info` answers error `100002`, and
 * `/api/net/current-plmn` and `/api/net/register` both answer `-1`. The
 * serving-cell and registration facts they were wanted for are published by
 * `/api/device/signal` and `/api/device/information` instead, which this cycle
 * already reads.
 */
export type HilinkDetailBodies = {
	readonly information?: string;
	readonly signal?: string;
};

export function parseHilinkDetails(
	bodies: HilinkDetailBodies,
): RouterAdminDetails | undefined {
	const information = bodies.information ?? "";
	const signal = bodies.signal ?? "";
	const fromXml = (body: string, tag: string): string | undefined =>
		detailValue(xmlValue(body, tag));

	const details: RouterAdminDetails = {};
	assign(details, "registration", fromXml(information, "workmode"));
	assign(details, "imsi", fromXml(information, "Imsi"));
	assign(details, "iccid", fromXml(information, "Iccid"));
	assign(details, "wan_ip", fromXml(information, "WanIPAddress"));
	assign(details, "network_type", fromXml(signal, "mode"));
	assign(details, "cell_id", fromXml(signal, "cell_id"));
	assign(details, "pci", fromXml(signal, "pci"));
	assign(details, "band", fromXml(signal, "lte_bandinfo"));
	assign(details, "bandwidth", fromXml(signal, "lte_bandwidth"));
	return compact(details);
}

// ── Qualcomm / HiMI UFI ─────────────────────────────────────────────────────

/** The command responses this reader draws on, keyed by the command that made them. */
export type UfiDetailBodies = {
	readonly overview?: string;
	readonly status?: string;
	readonly networkMode?: string;
	readonly produceInfo?: string;
	readonly sysinfo?: string;
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
	const sysinfo = ufiParams(bodies.sysinfo);

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
		assign(details, "web_version", firstStated(overview, ["WEBVER"]));
	}
	if (sysinfo !== undefined) {
		assign(details, "cell_id", firstStated(sysinfo, ["cellid"]));
		assign(details, "station_id", firstStated(sysinfo, ["bsid"]));
		assign(details, "cpu_temp", firstStated(sysinfo, ["cputemp"]));
		assign(details, "wifi_clients", firstStated(sysinfo, ["wifinum"]));
		assign(details, "eth_clients", firstStated(sysinfo, ["ethnum"]));
	}
	if (produceInfo !== undefined) {
		assign(details, "product", firstStated(produceInfo, UFI_PRODUCT_KEYS));
	}
	return compact(details);
}
