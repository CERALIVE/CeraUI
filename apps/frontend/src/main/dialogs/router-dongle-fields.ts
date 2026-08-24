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

import { redactDiagnosticRows } from "$lib/modem/diagnostics-redaction";
import { isMachineIdentifier } from "$lib/modem/operator-labels";

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

type DetailFieldSpec = {
	id: keyof RouterDetailsView;
	label: (value: string) => string;
	note?: (value: string) => string | undefined;
	/**
	 * The device answers this field from a VOCABULARY of its own, so a value that
	 * turns out to be a wire token is rerouted into the diagnostics table rather
	 * than printed (§3 OL-2). One dialect answers `network_type` with `LTE` and
	 * the next with `hspa-plus`; only the value can say which.
	 *
	 * It is opt-in per field because most of this table is NOT a vocabulary. An
	 * `ssid` is the operator's own text, a `provider` is a carrier's name, a
	 * `wan_ip` is an address — rerouting one of those on its shape would hide the
	 * operator's own setting from them, which is the opposite of this rule.
	 */
	vocabulary?: true;
};

/**
 * What its NETWORK is doing, in the operator's own terms — ordered radio →
 * carrier → address → local network. The list is a SUPERSET of any one dialect
 * (the ZTE fills a handful and the UFI fills a different set), so it is never a
 * promise that a given row will appear.
 *
 * WHAT IS NOT HERE IS THE POINT (`DESIGN.md` §3 OL-2/OL-3). Every row whose
 * VALUE is a raw vendor or 3GPP token an operator cannot act on — the band
 * family (`B4`, `LTE_BAND_3`), the serving-cell identifiers, the ARFCNs and
 * bandwidths, the vendor's numeric `network_mode` index, the subscriber
 * identifiers — moved to `DIAGNOSTIC_DETAIL_FIELDS` below. Nothing was deleted:
 * a field engineer still reads every one of them, verbatim and in the device's
 * own spelling, one disclosure away.
 */
const OPERATOR_DETAIL_FIELDS: ReadonlyArray<DetailFieldSpec> = [
	{
		id: "network_type",
		label: () => m["network.modem.networkType"](),
		vocabulary: true,
	},
	// Whether the carrier ACCEPTED this radio, which is a different question from
	// whether a SIM is seated — the bench HiLink twins hold a valid slot reading
	// and answer `NO SERVICE` here.
	{
		id: "registration",
		label: () => m["network.routerCellular.detail.registration"](),
		vocabulary: true,
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
		vocabulary: true,
	},
	{ id: "wan_ip", label: () => m["network.routerCellular.wanIpLabel"]() },
	{ id: "ssid", label: () => m["network.routerCellular.ssidLabel"]() },
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
	{ id: "product", label: () => m["network.routerCellular.productLabel"]() },
];

/**
 * The same readings, in the device's own spelling — the DIAGNOSTICS half.
 *
 * Every row here has a value an operator cannot act on and, in most cases,
 * cannot read: `band` arrives as `B4` from one dialect and `LTE_BAND_3` from
 * another, `network_mode` as the vendor's numeric index (`1` on the bench UFI),
 * `station_id` as an opaque `bsid` the device documents nothing about. Printing
 * those beside "Registration: NO SERVICE" is exactly the raw-token leak §3
 * forbids — a label an operator can read over a value only a field engineer can.
 *
 * THEY ARE RELOCATED, NEVER DELETED (OL-3). Values stay verbatim and in the
 * device's own order; a diagnostics value that has been tidied is no longer the
 * thing you compare against a vendor table. The block that renders them is
 * marked and collapsed (OL-4), which is also what removes them from the
 * operator-text scan the truthfulness gate runs.
 */
const DIAGNOSTIC_DETAIL_FIELDS: ReadonlyArray<DetailFieldSpec> = [
	{
		id: "network_mode",
		label: () => m["network.routerCellular.networkModeLabel"](),
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
	{ id: "imsi", label: () => m["network.routerCellular.imsiLabel"]() },
	{ id: "iccid", label: () => m["network.routerCellular.iccidLabel"]() },
	// The device names this `bsid` and documents nothing about it, so the row
	// carries the caveat rather than a meaning the device never stated.
	{
		id: "station_id",
		label: () => m["network.routerCellular.detail.stationId"](),
		note: () => m["network.routerCellular.detail.stationIdNote"](),
	},
	{
		id: "web_version",
		label: () => m["network.routerCellular.detail.webVersion"](),
	},
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
	// The IMEI in this table is a subscriber-adjacent identifier and crosses the
	// SAME disclosure boundary as the diagnostics dump below — the unit table is
	// a quieter dump, not a different kind of surface.
	return redactDiagnosticRows(
		stated(
			IDENTITY_FIELDS.map((field) => ({
				id: field.id,
				label: field.label(),
				value: field.value(admin),
			})),
		),
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
 *
 * `label` IS NEVER THE RAW `id` (§3 OL-2). `name` is optional in the firmware's
 * own catalog, so the former `mode.name ?? mode.id` fallback printed a vendor
 * machine token — `lte-only`, `0302` — as the operator's word for that mode,
 * giving a button an accessible name nobody can read before pressing it. An
 * unnamed mode takes a positional label, and its raw id is RELOCATED (never
 * deleted, OL-3) into the marked diagnostics table by {@link diagnosticFields}.
 */
export type NetModeChip = {
	readonly id: string;
	readonly label: string;
	/** Did the FIRMWARE name this mode, or is `label` the positional stand-in? */
	readonly named: boolean;
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
		modes: capability.modes.map((mode, index) => {
			const named = mode.name?.trim() ?? "";
			return {
				id: mode.id,
				label:
					named === ""
						? m["network.routerCellular.netMode.unnamed"]({
								index: String(index + 1),
							})
						: named,
				named: named !== "",
				current: mode.id === capability.current,
			};
		}),
	};
}

/**
 * The firmware's own network-mode catalog, in its own spelling.
 *
 * This is the other half of the OL-3 bargain the chip labels make: a mode the
 * firmware did not name is shown positionally, and the identifier it withheld a
 * name for is still on screen, verbatim, one disclosure away.
 */
function netModeDiagnosticRows(admin: RouterAdminView): DongleField[] {
	const capability = admin.capabilities?.net_mode;
	if (capability === undefined || capability.state !== "reported") return [];
	const rows: DongleField[] = [
		{
			id: "net_mode_catalog",
			label: m["network.routerCellular.netMode.catalogLabel"](),
			value: capability.modes.map((mode) => mode.id).join(" "),
		},
	];
	if (capability.current !== undefined && capability.current !== "") {
		rows.push({
			id: "net_mode_current",
			label: m["network.routerCellular.netMode.currentIdLabel"](),
			value: capability.current,
		});
	}
	return rows.filter((row) => row.value !== "");
}

function statedFrom(
	admin: RouterAdminView | undefined,
	specs: ReadonlyArray<DetailFieldSpec>,
): DongleField[] {
	const reported = admin?.details;
	if (reported === undefined) return [];
	return stated(
		specs.map((field) => {
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

/**
 * A `vocabulary` field whose value came back as a wire token belongs in the
 * OTHER table. Split rather than filtered, so the two callers below cannot
 * disagree about where a given row went — which is what would turn a relocation
 * into a deletion.
 */
function partitionOperatorRows(admin: RouterAdminView | undefined): {
	operator: DongleField[];
	relocated: DongleField[];
} {
	const tokenized = new Set(
		OPERATOR_DETAIL_FIELDS.filter((field) => field.vocabulary === true).map(
			(field) => field.id as string,
		),
	);
	const operator: DongleField[] = [];
	const relocated: DongleField[] = [];
	for (const row of statedFrom(admin, OPERATOR_DETAIL_FIELDS)) {
		if (tokenized.has(row.id) && isMachineIdentifier(row.value)) {
			relocated.push(row);
		} else {
			operator.push(row);
		}
	}
	return { operator, relocated };
}

export function detailFields(
	admin: RouterAdminView | undefined,
): DongleField[] {
	return partitionOperatorRows(admin).operator;
}

export function diagnosticFields(
	admin: RouterAdminView | undefined,
): DongleField[] {
	if (admin === undefined) return [];
	// `DIAGNOSTIC_DETAIL_FIELDS` deliberately collects `imsi` and `iccid`, so this
	// return is the disclosure boundary rather than a precaution: retaining a
	// subscriber identifier and DISPLAYING it are separate decisions, and only
	// the first is this table's to make.
	return redactDiagnosticRows([
		...statedFrom(admin, DIAGNOSTIC_DETAIL_FIELDS),
		...netModeDiagnosticRows(admin),
		...partitionOperatorRows(admin).relocated,
	]);
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
