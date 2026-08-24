/**
 * ethernet-role-view.ts — the ONE derivation behind the wired-port role control
 * and the honest `shared-lan` row (todo 15).
 *
 * The backend's contract (todo 8, `apps/backend/AGENTS.md` → THE ETHERNET PORT
 * ROLE) is that `netifEntry.ethRole` is published EXPLICITLY on every ethernet
 * row, `uplink` included — so ABSENT means "not an ethernet port, or an older
 * backend", and is never read as `uplink`. That asymmetry is why `supported`
 * exists here rather than a `?? "uplink"` default at a render site: claiming a
 * role for a row the device made no claim about is the same class of lie as the
 * bond toggle that used to look live on a link the device refuses.
 *
 * Pure and rune-free: it takes the interface snapshot plus the keyed async-op
 * phase, never a store, so both surfaces (the dialog's control and the section's
 * row) can be tested without mounting either.
 */

import type { EthernetRole, NetifEntry } from "@ceraui/rpc/schemas";

import type { AsyncOpPhase } from "$lib/rpc/async-operation.svelte";
import { isBondMember } from "$lib/stores/hud/link-status";

/** The op-key prefix the per-port role transition is registered under. */
export const ETHERNET_ROLE_OP_PREFIX = "eth-role";

/** The role-change op key for a wired interface name. */
export function ethernetRoleOpKey(name: string): string {
	return `${ETHERNET_ROLE_OP_PREFIX}:${name}`;
}

/**
 * Display order. Fixed so the dialog's control and any future surface cannot
 * list the same two roles differently.
 */
export const ETHERNET_ROLES: readonly EthernetRole[] = [
	"uplink",
	"shared-lan",
] as const;

const ROLE_LABEL_KEY: Record<EthernetRole, string> = {
	uplink: "network.ethRole.uplink",
	"shared-lan": "network.ethRole.sharedLan",
};

/**
 * The ONE-LINE CONSEQUENCE each role carries. This is the copy the plan calls
 * for: a role is not a preference, it decides whether the port carries bonded
 * stream traffic or serves internet to whatever is plugged into it, and an
 * operator must read that before they choose rather than after.
 */
const ROLE_CONSEQUENCE_KEY: Record<EthernetRole, string> = {
	uplink: "network.ethRole.uplinkConsequence",
	"shared-lan": "network.ethRole.sharedLanConsequence",
};

/**
 * `ethernetRoleErrorSchema`'s five members plus the two the transport can add.
 * None is collapsible — each names a different thing the operator can do about
 * it, which is the reason the backend refused to collapse them either.
 */
const ERROR_KEY: Record<string, string> = {
	unknown_interface: "network.ethRole.error.unknownInterface",
	not_ethernet: "network.ethRole.error.notEthernet",
	no_connection: "network.ethRole.error.noConnection",
	apply_failed: "network.ethRole.error.applyFailed",
	unavailable_in_emulated_mode: "network.ethRole.error.unavailableEmulated",
};

/** i18n dot-path for the role's own name. */
export function ethernetRoleLabelKey(role: EthernetRole): string {
	return ROLE_LABEL_KEY[role];
}

/** i18n dot-path for the one-line consequence of choosing the role. */
export function ethernetRoleConsequenceKey(role: EthernetRole): string {
	return ROLE_CONSEQUENCE_KEY[role];
}

/**
 * i18n dot-path for a transition failure.
 *
 * An unrecognised token resolves to the generic sentence rather than being
 * rendered raw — a machine token is never operator copy.
 */
export function ethernetRoleErrorKey(reason: string | undefined): string {
	if (reason === undefined) return "network.ethRole.error.generic";
	return ERROR_KEY[reason] ?? "network.ethRole.error.generic";
}

/** Narrow the async-op store's opaque `target`; anything else is no target. */
export function ethernetRoleTarget(value: unknown): EthernetRole | undefined {
	return ETHERNET_ROLES.includes(value as EthernetRole)
		? (value as EthernetRole)
		: undefined;
}

/** The other member of the two-value enum. */
function otherRole(role: EthernetRole): EthernetRole {
	return role === "uplink" ? "shared-lan" : "uplink";
}

/** What the port is doing right now, from the operator's point of view. */
export interface EthernetRoleContext {
	/**
	 * The port currently carries bonded SRTLA traffic — the frontend mirror of
	 * `genSrtlaIpList()` (`isBondMember`), so the UI and the device cannot
	 * disagree about which links are in the pool.
	 */
	bondedUplink: boolean;
	/** A stream is live right now. */
	streaming: boolean;
}

/** What changing to a role costs the operator, when it costs anything. */
export type EthernetRoleConsequence = "drops-bonded-uplink";

const CONSEQUENCE_KEY: Record<
	EthernetRoleConsequence,
	{ title: string; body: string; confirm: string }
> = {
	"drops-bonded-uplink": {
		title: "network.ethRole.confirm.dropsBondedUplinkTitle",
		body: "network.ethRole.confirm.dropsBondedUplinkBody",
		confirm: "network.ethRole.confirm.dropsBondedUplinkAction",
	},
};

/** The three i18n dot-paths a destructive transition's confirm renders. */
export function ethernetRoleConsequenceKeys(
	consequence: EthernetRoleConsequence,
): { title: string; body: string; confirm: string } {
	return CONSEQUENCE_KEY[consequence];
}

/**
 * Whether moving `from` → `to` destroys something the operator is using RIGHT
 * NOW.
 *
 * The STREAMING INTERLOCK, and it is deliberately narrow. Handing a port to the
 * client zone always removes it from the bond — that is what the role means and
 * the consequence line already says so — but it only costs a live broadcast
 * bandwidth when the port is CURRENTLY a bonded member AND a stream is up.
 * Confirming every transition is how operators learn to click a confirm through
 * without reading it (the same rule `deriveWifiModeConsequence` follows).
 *
 * `shared-lan → uplink` is additive: a shared port is already out of the bond,
 * so restoring its candidacy takes nothing away.
 */
export function deriveEthernetRoleConsequence(
	from: EthernetRole,
	to: EthernetRole,
	ctx: EthernetRoleContext,
): EthernetRoleConsequence | undefined {
	if (from === to) return undefined;
	if (to !== "shared-lan") return undefined;
	if (!ctx.bondedUplink || !ctx.streaming) return undefined;
	return "drops-bonded-uplink";
}

/**
 * Read the interlock context straight off the interface snapshot plus the live
 * streaming flag, so no render site re-derives bond membership by hand.
 */
export function ethernetRoleContext(
	iface: NetifEntry | undefined,
	streaming: boolean,
): EthernetRoleContext {
	return { bondedUplink: isBondMember(iface), streaming };
}

/** One rendered rung of the role control. */
export interface EthernetRoleOptionView {
	role: EthernetRole;
	/** The role the control shows as chosen. Exactly one option carries it. */
	selected: boolean;
	labelKey: string;
	consequenceKey: string;
	/** Set while this option is the target of an in-flight transition. */
	pending: boolean;
}

/** Everything the role control needs, derived once. */
export interface EthernetRoleView {
	name: string;
	/**
	 * The device published a role for this row. ABSENT means "not an ethernet
	 * port, or an older backend" — never `uplink` — so a surface renders NO
	 * control rather than offering one the device may not honour.
	 */
	supported: boolean;
	/**
	 * The role to DISPLAY. Held on the prior role while a transition is pending,
	 * so a raw `netif` tick cannot flip the control before the device has
	 * confirmed — and so a failed transition leaves the prior role on screen.
	 */
	displayRole: EthernetRole;
	/** The role the device reports right now, unheld. */
	observedRole: EthernetRole;
	/** Both roles, always, in {@link ETHERNET_ROLES} order. */
	options: EthernetRoleOptionView[];
	pending: boolean;
	pendingTarget?: EthernetRole;
	/** Present on a TERMINAL failure; the control still shows `displayRole`. */
	errorKey?: string;
	/** The raw failure token, for a machine-readable assertion. */
	error?: string;
}

/** The inputs a surface hands the derivation. */
export interface EthernetRoleInput {
	name: string;
	iface: NetifEntry | undefined;
	/** The `eth-role:<name>` async-op phase. */
	phase: AsyncOpPhase;
	/** The role the in-flight transition is driving toward. */
	target?: EthernetRole;
	/** The failure reason recorded on a terminal `failed` phase. */
	failureReason?: string;
}

export function deriveEthernetRoleView(
	input: EthernetRoleInput,
): EthernetRoleView {
	const published = input.iface?.ethRole;
	const observedRole: EthernetRole = published ?? "uplink";
	const pending = input.phase === "pending";

	// A pending transition holds the PRIOR role, and so does a failed one: the
	// device kept its previous role, so showing the requested one would report an
	// outcome that did not happen. With exactly two roles the prior is
	// unambiguous — an observation that has already reached the target means the
	// transition is mid-flight, not settled.
	const displayRole =
		pending && input.target !== undefined && observedRole === input.target
			? otherRole(input.target)
			: observedRole;

	const options = ETHERNET_ROLES.map<EthernetRoleOptionView>((role) => ({
		role,
		selected: role === displayRole,
		labelKey: ROLE_LABEL_KEY[role],
		consequenceKey: ROLE_CONSEQUENCE_KEY[role],
		pending: pending && input.target === role,
	}));

	const failed = input.phase === "failed" || input.phase === "timed_out";
	return {
		name: input.name,
		supported: published !== undefined,
		displayRole,
		observedRole,
		options,
		pending,
		...(pending && input.target !== undefined
			? { pendingTarget: input.target }
			: {}),
		...(failed
			? {
					errorKey:
						input.phase === "timed_out"
							? "network.ethRole.error.notConfirmed"
							: ethernetRoleErrorKey(input.failureReason),
					...(input.failureReason !== undefined
						? { error: input.failureReason }
						: {}),
				}
			: {}),
	};
}

// ─────────────────── the honest `shared-lan` ROW ───────────────────

/**
 * The client-zone state of a `shared-lan` port, and it is deliberately COARSE.
 *
 * NetworkManager's `ipv4.method shared` leases the port its own gateway address
 * and runs DHCP/DNS behind it, so the address IS the evidence that the zone is
 * up. A CLIENT COUNT is NOT derivable here — nothing on the `netif` wire carries
 * one — and inventing "0 clients" for a zone we have not measured would be the
 * same fabrication as rendering a busy/idle encoder core as a percentage.
 */
export type EthernetClientZoneState = "serving" | "starting";

const ZONE_LABEL_KEY: Record<EthernetClientZoneState, string> = {
	serving: "network.ethRole.zoneServing",
	starting: "network.ethRole.zoneStarting",
};

/** Everything the section row needs to render a `shared-lan` port honestly. */
export interface SharedLanRowView {
	zone: EthernetClientZoneState;
	zoneLabelKey: string;
	/**
	 * Why the port is not in the bond, in words. It rides the disabled bond
	 * toggle's accessible name AND an on-screen line — the shipped kiosk
	 * touchscreen cannot hover to reveal a `title`.
	 */
	bondExclusionReasonKey: string;
}

/**
 * The `shared-lan` row view, or `undefined` for every other row.
 *
 * Keyed on the operator's own declared `ethRole`, never on the wire's
 * `NETIF_ERR_SHAREDLAN` label: the flag is the device's ENFORCEMENT of the role
 * and the role is the CLAIM, so reading the label would make the row's honesty
 * depend on a string the backend is free to reword.
 */
export function deriveSharedLanRow(
	iface: NetifEntry | undefined,
): SharedLanRowView | undefined {
	if (iface?.ethRole !== "shared-lan") return undefined;
	const zone: EthernetClientZoneState = iface.ip ? "serving" : "starting";
	return {
		zone,
		zoneLabelKey: ZONE_LABEL_KEY[zone],
		bondExclusionReasonKey: "network.ethRole.excludedFromBondReason",
	};
}
