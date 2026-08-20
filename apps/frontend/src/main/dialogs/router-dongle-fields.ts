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
	label: () => string;
}> = [
	{ id: "network_type", label: () => m["network.modem.networkType"]() },
	{
		id: "network_mode",
		label: () => m["network.routerCellular.networkModeLabel"](),
	},
	{ id: "provider", label: () => m["network.routerCellular.providerLabel"]() },
	{ id: "cell_id", label: () => m["network.modem.detail.cellId"]() },
	{ id: "band", label: () => m["network.modem.detail.band"]() },
	{ id: "wan_ip", label: () => m["network.routerCellular.wanIpLabel"]() },
	{ id: "imsi", label: () => m["network.routerCellular.imsiLabel"]() },
	{ id: "iccid", label: () => m["network.routerCellular.iccidLabel"]() },
	{ id: "ssid", label: () => m["network.routerCellular.ssidLabel"]() },
	{ id: "product", label: () => m["network.routerCellular.productLabel"]() },
];

function stated(
	rows: ReadonlyArray<{ id: string; label: string; value: string | undefined }>,
): DongleField[] {
	return rows
		.filter((row) => row.value !== undefined && row.value !== "")
		.map((row) => ({
			id: row.id,
			label: row.label,
			value: row.value as string,
		}));
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
		DETAIL_FIELDS.map((field) => ({
			id: field.id,
			label: field.label(),
			value: reported[field.id],
		})),
	);
}
