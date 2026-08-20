/**
 * What a router-mode dongle's own admin API said about itself, as rows.
 *
 * Pure and rune-free, the same split `modem-detail.ts` already uses for the
 * modem dialog: the tables and the absence rule are testable without mounting a
 * dialog, and the component keeps only its controls.
 *
 * ONE rule governs both tables: a field the device did not state produces NO
 * ROW. Not a dash, not an empty value — a dash reads as "the dongle reported
 * nothing for this", which is a different claim from "this dialect has no such
 * field", and the dialog is entitled to neither.
 */

import { m } from "@ceraui/i18n/svelte";
import type { Modem } from "@ceraui/rpc/schemas";

export type RouterAdminView = NonNullable<Modem["router_admin"]>;
type RouterDetailsView = NonNullable<RouterAdminView["details"]>;
type NetModeCapabilityView = NonNullable<
	RouterAdminView["capabilities"]
>["net_mode"];
type NetModeUnavailable = Extract<
	NetModeCapabilityView,
	{ state: "unavailable" }
>["reason"];

export type DongleField = {
	readonly id: string;
	readonly label: string;
	readonly value: string;
	/**
	 * A caveat the operator must read WITH the value, rendered on screen rather
	 * than in a `title` — the shipped kiosk touchscreen cannot hover. Only the
	 * UFI's opaque `bsid` carries one today: the device documents nothing about
	 * what it identifies, so the row must not be read as a claim.
	 */
	readonly note?: string;
};

/** Who this unit IS — the fields that separate two same-model twins. */
const IDENTITY_FIELDS: ReadonlyArray<{
	id: string;
	label: () => string;
	value: (admin: RouterAdminView) => string | undefined;
}> = [
	{
		id: "model",
		label: () => m["network.routerCellular.modelLabel"](),
		value: (admin) => admin.model,
	},
	{
		id: "firmware",
		label: () => m["network.routerCellular.firmwareLabel"](),
		value: (admin) => admin.firmware,
	},
	{
		id: "hardware",
		label: () => m["network.routerCellular.hardwareLabel"](),
		value: (admin) => admin.hardware,
	},
	{
		id: "imei",
		label: () => m["network.routerCellular.imeiLabel"](),
		value: (admin) => admin.imei,
	},
	{
		id: "serial",
		label: () => m["network.routerCellular.serialLabel"](),
		value: (admin) => admin.serial,
	},
];

/**
 * What its NETWORK is doing, ordered radio → carrier → cell, then the UFI's
 * WAN/SIM identifiers and its product record. The list is a SUPERSET of any one
 * dialect — the ZTE fills the first four and the UFI fills a different set — so
 * it is never a promise that a given row will appear.
 */
const DETAIL_FIELDS: ReadonlyArray<{
	id: keyof RouterDetailsView;
	label: (value: string) => string;
	note?: (value: string) => string | undefined;
}> = [
	{ id: "network_type", label: () => m["network.modem.networkType"]() },
	{
		id: "network_mode",
		label: () => m["network.routerCellular.networkModeLabel"](),
	},
	// Whether the carrier ACCEPTED this radio, which is a different question from
	// whether a SIM is seated — the bench HiLink twins hold a valid slot reading
	// and answer `NO SERVICE` here.
	{
		id: "registration",
		label: () => m["network.routerCellular.detail.registration"](),
	},
	// A DIALECT MAY ANSWER THIS WITH A NAME OR WITH A NUMBER, AND THE ROW MUST
	// NOT CALL THE NUMBER A NAME. See `decomposePlmn` — the label and the caveat
	// follow the value the dongle actually stated.
	{
		id: "provider",
		label: (value) =>
			decomposePlmn(value) === undefined
				? m["network.routerCellular.providerLabel"]()
				: m["network.routerCellular.detail.networkCode"](),
		note: (value) => {
			const plmn = decomposePlmn(value);
			return plmn === undefined
				? undefined
				: m["network.routerCellular.detail.networkCodeNote"]({
						mcc: plmn.mcc,
						mnc: plmn.mnc,
					});
		},
	},
	{
		id: "mcc",
		label: () => m["network.routerCellular.detail.mcc"](),
	},
	{
		id: "mnc",
		label: () => m["network.routerCellular.detail.mnc"](),
	},
	{
		id: "roaming",
		label: () => m["network.routerCellular.detail.roaming"](),
	},
	{ id: "cell_id", label: () => m["network.modem.detail.cellId"]() },
	{
		id: "pci",
		label: () => m["network.routerCellular.detail.pci"](),
	},
	{ id: "band", label: () => m["network.modem.detail.band"]() },
	{
		id: "network_band",
		label: () => m["network.routerCellular.detail.networkBand"](),
	},
	{
		id: "bandwidth",
		label: () => m["network.routerCellular.detail.bandwidth"](),
	},
	{
		id: "carrier_aggregation",
		label: () => m["network.routerCellular.detail.carrierAggregation"](),
	},
	{
		id: "pcell_arfcn",
		label: () => m["network.routerCellular.detail.pcellArfcn"](),
	},
	{
		id: "pcell_band",
		label: () => m["network.routerCellular.detail.pcellBand"](),
	},
	{
		id: "pcell_bandwidth",
		label: () => m["network.routerCellular.detail.pcellBandwidth"](),
	},
	{
		id: "scell_arfcn",
		label: () => m["network.routerCellular.detail.scellArfcn"](),
	},
	{
		id: "scell_band",
		label: () => m["network.routerCellular.detail.scellBand"](),
	},
	{
		id: "scell_bandwidth",
		label: () => m["network.routerCellular.detail.scellBandwidth"](),
	},
	{ id: "wan_ip", label: () => m["network.routerCellular.wanIpLabel"]() },
	{ id: "imsi", label: () => m["network.routerCellular.imsiLabel"]() },
	{ id: "iccid", label: () => m["network.routerCellular.iccidLabel"]() },
	{ id: "ssid", label: () => m["network.routerCellular.ssidLabel"]() },
	// The device names this `bsid` and documents nothing about it, so the row
	// carries the caveat rather than a meaning the device never stated.
	{
		id: "station_id",
		label: () => m["network.routerCellular.detail.stationId"](),
		note: () => m["network.routerCellular.detail.stationIdNote"](),
	},
	{
		id: "cpu_temp",
		label: () => m["network.routerCellular.detail.cpuTemp"](),
	},
	{
		id: "wifi_clients",
		label: () => m["network.routerCellular.detail.wifiClients"](),
	},
	{
		id: "eth_clients",
		label: () => m["network.routerCellular.detail.ethClients"](),
	},
	{
		id: "web_version",
		label: () => m["network.routerCellular.detail.webVersion"](),
	},
	{ id: "product", label: () => m["network.routerCellular.productLabel"]() },
];

/**
 * The dongle's OWN traffic accounting, kept in its own table so no render site
 * can print it beside a radio reading as if the two were the same kind of fact.
 * It is NOT the bond's throughput — `BondedLinksSection` reports that from the
 * sender's own measurement — and every surface that shows these must say so.
 */
const TRAFFIC_FIELDS: ReadonlyArray<{
	id: keyof RouterDetailsView;
	label: () => string;
}> = [
	{
		id: "monthly_tx_bytes",
		label: () => m["network.routerCellular.traffic.monthlyTx"](),
	},
	{
		id: "monthly_rx_bytes",
		label: () => m["network.routerCellular.traffic.monthlyRx"](),
	},
	{
		id: "monthly_time",
		label: () => m["network.routerCellular.traffic.monthlyTime"](),
	},
	{
		id: "monthly_period",
		label: () => m["network.routerCellular.traffic.monthlyPeriod"](),
	},
	{
		id: "session_tx_bytes",
		label: () => m["network.routerCellular.traffic.sessionTx"](),
	},
	{
		id: "session_rx_bytes",
		label: () => m["network.routerCellular.traffic.sessionRx"](),
	},
	{
		id: "session_tx_rate",
		label: () => m["network.routerCellular.traffic.sessionTxRate"](),
	},
	{
		id: "session_rx_rate",
		label: () => m["network.routerCellular.traffic.sessionRxRate"](),
	},
	{
		id: "session_time",
		label: () => m["network.routerCellular.traffic.sessionTime"](),
	},
];

/**
 * An E.212 PLMN identity as the dongle stated it, split into its two halves —
 * or `undefined` when the value is not one.
 *
 * WHY THIS EXISTS: the ZTE dialect answers `network_provider` with a NUMBER when
 * its `network_provider_fullname` is empty, and that firmware's fullname is empty.
 * Measured on the bench rack, the MF79U reports `732103` — so an "Operator" row
 * read `Operator 732103`, a label promising a name over a value that is not one.
 *
 * THE SPLIT IS ARITHMETIC ON A FIXED-WIDTH FORMAT, NEVER A LOOKUP. E.212 fixes
 * the MCC at three digits, so a 5- or 6-digit numeric string decomposes with no
 * ambiguity and no data. Nothing here maps a code to a carrier NAME: no such
 * table ships with this app, the device holds no observed code→name mapping to
 * join against, and deriving one from a community list would print a guess in
 * the operator's own words. Rendering the code, correctly labelled, is the
 * honest answer until a first-party mapping exists.
 */
export function decomposePlmn(
	value: string,
): { readonly mcc: string; readonly mnc: string } | undefined {
	if (!/^\d{5,6}$/.test(value)) return undefined;
	return { mcc: value.slice(0, 3), mnc: value.slice(3) };
}

function stated(
	rows: ReadonlyArray<{
		id: string;
		label: string;
		value: string | undefined;
		note?: string;
	}>,
): DongleField[] {
	return rows
		.filter((row) => row.value !== undefined && row.value !== "")
		.map((row) => {
			const field: DongleField = {
				id: row.id,
				label: row.label,
				value: row.value as string,
			};
			return row.note === undefined ? field : { ...field, note: row.note };
		});
}

export function identityFields(
	admin: RouterAdminView | undefined,
): DongleField[] {
	if (admin === undefined) return [];
	return stated(
		IDENTITY_FIELDS.map((field) => ({
			id: field.id,
			label: field.label(),
			value: field.value(admin),
		})),
	);
}

/**
 * A network mode the firmware advertised, as a chip.
 *
 * Whether a chip is PRESSABLE is not a property of the chip — it is
 * `NetModeView.selectable`, which is true only when the firmware named a catalog
 * at all. A firmware that declined the question (the bench unit answers `112008`)
 * yields the reason arm below and no chips, so it can never render a control that
 * promises an action nothing behind it performs.
 */
export type NetModeChip = {
	readonly id: string;
	readonly label: string;
	readonly current: boolean;
};

export type NetModeView = {
	readonly modes: readonly NetModeChip[];
	/**
	 * Whether this firmware's own catalog may be WRITTEN (Stage B).
	 *
	 * It is exactly "the capability read came back `reported`" — the SAME gate the
	 * device-side write re-applies in its own cycle before it builds any request
	 * document. The two agree by construction because both read one capability
	 * block; the UI never decides writability on its own, and a firmware whose
	 * catalog could not be read is never offered a control.
	 */
	readonly selectable: boolean;
	/**
	 * Rendered INSTEAD of the chips: the reason the firmware's own catalog could
	 * not be read, already resolved to operator copy.
	 */
	readonly reason?: string;
};

/**
 * The four non-refusal reasons deliberately REUSE the signal strip's vocabulary
 * — the same conditions, described to the operator in the same words, so one
 * dongle never explains an unreadable session two different ways.
 */
const NET_MODE_REASONS: Record<NetModeUnavailable, () => string> = {
	refused: () => m["network.routerCellular.netMode.refusedUnknown"](),
	"auth-expired": () => m["network.routerCellular.signal.reason.authExpired"](),
	"not-reported": () => m["network.routerCellular.signal.reason.notReported"](),
	malformed: () => m["network.routerCellular.signal.reason.malformed"](),
	unreachable: () => m["network.routerCellular.signal.reason.unreachable"](),
};

export function netModeCapability(
	admin: RouterAdminView | undefined,
): NetModeView | undefined {
	const capability = admin?.capabilities?.net_mode;
	if (capability === undefined) return undefined;
	if (capability.state === "unavailable") {
		const reason =
			capability.reason === "refused" && capability.code !== undefined
				? m["network.routerCellular.netMode.refused"]({
						code: capability.code,
					})
				: NET_MODE_REASONS[capability.reason]();
		return { modes: [], selectable: false, reason };
	}
	return {
		selectable: true,
		modes: capability.modes.map((mode) => ({
			id: mode.id,
			label: mode.name ?? mode.id,
			current: mode.id === capability.current,
		})),
	};
}

export function detailFields(
	admin: RouterAdminView | undefined,
): DongleField[] {
	const reported = admin?.details;
	if (reported === undefined) return [];
	return stated(
		DETAIL_FIELDS.map((field) => {
			const value = reported[field.id];
			if (value === undefined || value === "") {
				return { id: field.id, label: "", value: undefined };
			}
			const note = field.note?.(value);
			return {
				id: field.id,
				label: field.label(value),
				value,
				...(note === undefined ? {} : { note }),
			};
		}),
	);
}

export function trafficFields(
	admin: RouterAdminView | undefined,
): DongleField[] {
	const reported = admin?.details;
	if (reported === undefined) return [];
	return stated(
		TRAFFIC_FIELDS.map((field) => ({
			id: field.id,
			label: field.label(),
			value: reported[field.id],
		})),
	);
}
