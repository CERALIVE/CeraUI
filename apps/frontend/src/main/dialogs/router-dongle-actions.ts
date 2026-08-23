/**
 * What a router-mode dongle can be ASKED TO DO, and what it provably cannot.
 *
 * `router-dongle-fields.ts` is the READING half of this dialog — the tables the
 * dongle's own admin API filled in. This is the ACTION half, and it is pure and
 * rune-free for the same reason: the decision about whether an operation may be
 * offered has to be assertable without mounting a dialog.
 *
 * ── THREE OPERATIONS, THREE DIFFERENT ANSWERS ───────────────────────────────
 *
 * The router family's write surface is not one capability, and rendering it as
 * one would flatten three genuinely different facts:
 *
 *   network mode   the firmware NAMES its own catalog, or REFUSES the question.
 *                  A refusal is a READING (the bench unit answers `112008`), so
 *                  it renders BLOCKED-WITH-THE-CODE — heading, refusal on screen,
 *                  no control. It is never `absent`: hiding the control would say
 *                  this modem has no network mode, which is the opposite of what
 *                  the device reported.
 *   LAN subnet     a real, journaled write this build performs — for the ONE
 *                  dialect whose writes were proven by round-trip. It is offered
 *                  behind an explicit confirmation, never as a switch.
 *   Wi-Fi / reboot NO operation exists, in any provider, for any dialect. They
 *                  render as an honest unavailability sentence and NOTHING else.
 *
 * ── WHY Wi-Fi IS EVIDENCE-ONLY, PERMANENTLY FOR THIS EFFORT ─────────────────
 *
 * `@ceralive/modem-control`'s Huawei provider exposes EXACTLY four operations —
 * `status`, `signal`, `mode`, `data` (`huawei-hilink/runtime.ts`) — and none of
 * them touches the radio's Wi-Fi. The other two dialects publish no write at all.
 * So there is no Wi-Fi write anywhere in the stack to gate, and a control here
 * could only ever be an affordance that fails on click.
 *
 * A successful READ is not evidence either. The dongle happily reports its SSID
 * and its associated-client count (`router-dongle-fields.ts` renders both), and
 * inferring a write from those readings is precisely the hearsay the whole
 * router-admin surface was built to refuse.
 *
 * **This stays true even if a hardware drill later proves a write.** By the time
 * such a drill can run, the capability-truth matrix and both dialog migrations
 * are sealed, so a control added afterwards would bypass the gate that exists to
 * keep this surface honest. The drill's verdict is recorded as follow-up work,
 * not shipped as a late toggle.
 *
 * ── THE SUBNET REWRITE IS GATED ON A PROVEN WRITE, NOT ON A DIALECT NAME ────
 *
 * `router_admin.controls` is published ONLY for a dongle whose writes were
 * observed to land on real hardware, which is the same HiLink dialect
 * `prepareSubnetRewrite` accepts — every other device answers `unsupported`
 * before a request document is built. So the presence of that block is the
 * truthful, already-on-the-wire gate, and it carries the lock model for free: a
 * signed-out dongle withholds `controls`, and withholding the rewrite from a
 * device we have not authenticated against is the correct answer rather than a
 * side effect.
 */

import type { SetRouterSubnetOutput } from "@ceraui/rpc/schemas";

import type { CapabilityView } from "$lib/modem/sections";

import type { NetModeView, RouterAdminView } from "./router-dongle-fields";

/**
 * The GENERIC form of the net-mode refusal, carried on the view itself.
 *
 * The rendered sentence normally interpolates the firmware's own error code, so
 * the caller passes it to `CapabilitySection` as an already-resolved `reason`.
 * This key is what the section falls back to if that override is ever dropped —
 * a degradation that loses the code and never the truth.
 */
export const NET_MODE_BLOCKED_REASON_KEY =
	"network.routerCellular.netMode.refusedUnknown";

/**
 * The net-mode capability as the shared four-state ladder sees it.
 *
 * `blocked` rather than `absent` for a refusal is the load-bearing choice: the
 * firmware ANSWERED, and what it answered is that it will not discuss its
 * network modes. That is a reading about the device, so it belongs on screen.
 * Because the caller passes the chips as `children` (which render at `available`
 * alone) and passes NO `control` snippet, `blocked` renders a heading plus the
 * refusal and no control of any kind — satisfying both halves of the ladder's
 * contract at once.
 */
export function netModeSectionView(
	netMode: NetModeView | undefined,
): CapabilityView {
	if (netMode === undefined) return { mode: "absent" };
	if (netMode.selectable) return { mode: "available" };
	return { mode: "blocked", reasonKey: NET_MODE_BLOCKED_REASON_KEY };
}

/** One operation this build ships no write for, and the reason it says so. */
export type RouterUnavailableOperation = {
	readonly id: string;
	/** i18n dot-path key — the operator's name for the operation. */
	readonly titleKey: string;
	/** i18n dot-path key — WHY it is unavailable, in the operator's own terms. */
	readonly reasonKey: string;
};

/**
 * The operations a router dongle does NOT get, stated rather than omitted.
 *
 * Silence is not honesty here: an operator who came looking for the Wi-Fi switch
 * they can see in the vendor's own web interface needs to be told this device
 * will not offer one, and where the setting does live. Omitting the row leaves
 * them hunting through a dialog that simply does not mention it.
 *
 * Frozen because it is a statement about the SHIPPED stack, not about the device
 * in front of the operator — every router dongle answers the same way, and a
 * per-device variation here would imply an evidence source that does not exist.
 */
export const ROUTER_UNAVAILABLE_OPERATIONS: readonly RouterUnavailableOperation[] =
	Object.freeze([
		Object.freeze({
			id: "wifi",
			titleKey: "network.routerCellular.unavailable.wifi.title",
			reasonKey: "network.routerCellular.unavailable.wifi.reason",
		}),
		Object.freeze({
			id: "reboot",
			titleKey: "network.routerCellular.unavailable.reboot.title",
			reasonKey: "network.routerCellular.unavailable.reboot.reason",
		}),
	]);

/**
 * Whether the LAN-subnet rewrite may be offered for this dongle.
 *
 * Two states only — `available` or `absent`, never `blocked`. The controls ARE
 * the children here (an address field plus a confirmation), and `blocked`
 * suppresses `children`, so a refusal rendered that way would take the surface
 * off screen at the moment an operator most needs to read it. That is the same
 * three-state rule `ussdCapabilityView` follows, minus the `unknown` arm this
 * capability has no evidence source for.
 */
export function subnetRewriteView(
	admin: RouterAdminView | undefined,
): CapabilityView {
	return admin?.controls === undefined
		? { mode: "absent" }
		: { mode: "available" };
}

const DOTTED_QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Whether an address is a plausible NEW LAN address for the dongle.
 *
 * The device re-checks every one of these and more (it owns the /24 rule, the
 * RFC1918 rule and the host-subnet collision check), so this is a courtesy gate
 * that keeps a doomed request out of a journaled mutation — it is deliberately
 * NARROWER than nothing and never WIDER than the device: an address this accepts
 * can still be refused, and an address this rejects would certainly have been.
 *
 * RFC1918 only, because a dongle's LAN is a private network by construction and
 * pointing one at a routable range is a mistake nobody makes on purpose. The
 * host octet excludes `0` and `255`, which name the network and its broadcast
 * address rather than a gateway.
 */
export function isSubnetTargetValid(address: string): boolean {
	const match = DOTTED_QUAD.exec(address.trim());
	if (match === null) return false;
	const octets = match.slice(1, 5).map((part) => Number(part));
	if (octets.length !== 4) return false;
	if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
		return false;
	}
	const first = octets[0] ?? -1;
	const second = octets[1] ?? -1;
	const host = octets[3] ?? -1;
	if (host === 0 || host === 255) return false;
	if (first === 10) return true;
	if (first === 192 && second === 168) return true;
	return first === 172 && second >= 16 && second <= 31;
}

/** How the operator is told what a subnet rewrite did. */
export type SubnetOutcomeView = {
	/** Maps onto `MutationOutcomeBand`'s three kinds. */
	readonly kind: "applied" | "refused" | "unknown";
	/** i18n dot-path key for the sentence. */
	readonly key: string;
	/** The interface already holding the requested subnet, when that is the refusal. */
	readonly conflict?: string;
};

const SUBNET_REFUSAL_KEYS: Readonly<Record<string, string>> = Object.freeze({
	unsupported: "network.routerCellular.subnet.refused.unsupported",
	unreachable: "network.routerCellular.control.unreachable",
	unreadable: "network.routerCellular.subnet.refused.unreadable",
	unsupported_netmask:
		"network.routerCellular.subnet.refused.unsupported_netmask",
	invalid_target: "network.routerCellular.subnet.refused.invalid_target",
	no_change: "network.routerCellular.subnet.refused.no_change",
	subnet_conflict: "network.routerCellular.subnet.refused.subnet_conflict",
	state_drifted: "network.routerCellular.subnet.refused.state_drifted",
	unknown_device: "network.routerCellular.adminOpenReason.unknown_device",
});

/**
 * The mutation-safety refusals share ONE sentence here, and that is a recorded
 * narrowing rather than an oversight.
 *
 * The seven shared tokens each name a different operator action, and every other
 * mutating modem surface spells them out. This one does not YET, because the
 * pre-existing router write path (`refusalMessage` in the dialog) already
 * collapses them the same way — giving the subnet rewrite its own seven-sentence
 * taxonomy while its two siblings keep one would make the same refusal read
 * differently depending on which control produced it. What the shared sentence
 * does say truthfully is the part that matters most: nothing was written.
 */
const SUBNET_INTERLOCK_KEY = "network.routerCellular.subnet.refused.interlock";

/**
 * Turn the device's own four-status answer into an operator sentence.
 *
 * `blocked` is deliberately `unknown` rather than `refused`: the device answered
 * at NEITHER its old nor its new address, so nothing about the write can be
 * asserted in either direction — which is exactly what the outcome band's
 * `unknown` kind exists to say. Reporting it as a refusal would claim the
 * previous settings are intact, and reporting it as applied would claim the new
 * ones are.
 */
export function subnetOutcome(
	result: SetRouterSubnetOutput,
): SubnetOutcomeView {
	if (result.status === "applied") {
		return { kind: "applied", key: "network.routerCellular.subnet.applied" };
	}
	if (result.status === "reverted") {
		return { kind: "refused", key: "network.routerCellular.subnet.reverted" };
	}
	if (result.status === "blocked") {
		return { kind: "unknown", key: "network.routerCellular.subnet.blocked" };
	}
	const key =
		result.error === undefined
			? SUBNET_INTERLOCK_KEY
			: (SUBNET_REFUSAL_KEYS[result.error] ?? SUBNET_INTERLOCK_KEY);
	return result.error === "subnet_conflict" && result.conflict !== undefined
		? { kind: "refused", key, conflict: result.conflict }
		: { kind: "refused", key };
}

/**
 * The wire input for a subnet rewrite, with the confirmation the schema demands.
 *
 * `confirm: true` is a `z.literal(true)` on `setRouterSubnetInputSchema` and the
 * object is `.strict()`, so this is the ONE shape the device will accept — the
 * TOCTOU boundary the write's own contract sets, reproduced here so no call site
 * can construct a request that omits it.
 */
export function subnetRewriteRequest(
	device: string,
	address: string,
): { device: string; address: string; confirm: true } {
	return { device, address: address.trim(), confirm: true };
}

/** Type-level proof the request always carries the device's own confirmation. */
export type SubnetRewriteRequest = ReturnType<typeof subnetRewriteRequest>;
