/**
 * The router-family ACTION surface, as pure rules.
 *
 * Three operations answer three different ways, and the whole point of this
 * module is that each answer is provable without mounting a dialog:
 *
 *   · a firmware that REFUSED to name its network-mode catalog is `blocked`
 *     with the code, never `absent` — hiding the control would report a modem
 *     that answered as a modem that has no network mode at all;
 *   · the LAN-subnet rewrite is offered only where a write was PROVEN, and the
 *     evidence for that is already on the wire;
 *   · Wi-Fi and reboot have no write anywhere in the pinned control package, so
 *     they carry an operator sentence and nothing that could be clicked.
 */
import type { SetRouterSubnetOutput } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	isSubnetTargetValid,
	NET_MODE_BLOCKED_REASON_KEY,
	netModeSectionView,
	ROUTER_UNAVAILABLE_OPERATIONS,
	subnetOutcome,
	subnetRewriteRequest,
	subnetRewriteView,
} from "./router-dongle-actions";
import type { NetModeView, RouterAdminView } from "./router-dongle-fields";

const admin = (extra: Partial<RouterAdminView> = {}): RouterAdminView =>
	({
		admin_url: "http://192.168.8.1",
		reachable: true,
		...extra,
	}) as RouterAdminView;

const refused: SetRouterSubnetOutput = {
	status: "refused",
	error: "subnet_conflict",
	conflict: "eth1",
};

describe("netModeSectionView", () => {
	it("blocks — never hides — a firmware that refused the question", () => {
		// The bench unit's own `112008`. The catalog could not be read, which is a
		// READING about the device: the section stays on screen, disabled, with the
		// refusal beside it, because `absent` would claim this modem has no
		// network mode rather than that its firmware declined to say.
		const view = netModeSectionView({
			modes: [],
			selectable: false,
			reason:
				"This firmware refuses to report its network modes (error 112008).",
		} satisfies NetModeView);

		expect(view.mode).toBe("blocked");
		expect(view).toEqual({
			mode: "blocked",
			reasonKey: NET_MODE_BLOCKED_REASON_KEY,
		});
	});

	it("carries a REAL key on the view, so dropping the code loses no truth", () => {
		// The rendered sentence interpolates the firmware's error code and is
		// passed as an already-resolved override; this key is the generic form of
		// the same fact, so the worst degradation is a lost code.
		expect(NET_MODE_BLOCKED_REASON_KEY).toBe(
			"network.routerCellular.netMode.refusedUnknown",
		);
	});

	it("offers the catalog when the firmware named one", () => {
		expect(
			netModeSectionView({
				modes: [{ id: "03", label: "LTE ONLY", named: true, current: true }],
				selectable: true,
			}),
		).toEqual({ mode: "available" });
	});

	it("renders nothing at all when the capability was never read", () => {
		expect(netModeSectionView(undefined)).toEqual({ mode: "absent" });
	});
});

describe("subnetRewriteView", () => {
	it("offers the rewrite only where a write to this dongle was proven", () => {
		expect(
			subnetRewriteView(
				admin({ controls: { mobile_data: true, roaming_autoconnect: false } }),
			),
		).toEqual({ mode: "available" });
	});

	it("renders zero nodes for a dialect with no proven write", () => {
		// A ZTE/UFI dongle publishes readings and no `controls`; the device answers
		// `unsupported` before it builds a request document, so an offer here could
		// only ever be an affordance that fails on click.
		expect(subnetRewriteView(admin())).toEqual({ mode: "absent" });
	});

	it("withholds the rewrite from a dongle we have not signed in to", () => {
		// A standing lock makes the device withhold `controls`, and withholding a
		// journaled write from a device we cannot authenticate against is the
		// correct answer rather than a side effect.
		expect(subnetRewriteView(undefined)).toEqual({ mode: "absent" });
	});

	it("never answers `blocked` — the controls ARE the children", () => {
		const views = [
			subnetRewriteView(undefined),
			subnetRewriteView(admin()),
			subnetRewriteView(
				admin({ controls: { mobile_data: false, roaming_autoconnect: false } }),
			),
		];
		expect(views.some((view) => view.mode === "blocked")).toBe(false);
	});
});

describe("ROUTER_UNAVAILABLE_OPERATIONS", () => {
	it("states Wi-Fi and reboot rather than omitting them", () => {
		expect(ROUTER_UNAVAILABLE_OPERATIONS.map((op) => op.id)).toEqual([
			"wifi",
			"reboot",
		]);
	});

	it("gives every entry its own operator name AND its own reason", () => {
		for (const operation of ROUTER_UNAVAILABLE_OPERATIONS) {
			expect(operation.titleKey).toMatch(
				/^network\.routerCellular\.unavailable\./,
			);
			expect(operation.reasonKey).toMatch(
				/^network\.routerCellular\.unavailable\./,
			);
			expect(operation.reasonKey).not.toBe(operation.titleKey);
		}
	});

	it("carries no control of any kind — it is a statement, not an affordance", () => {
		// Nothing on an unavailability row may be dispatchable. The shape has no
		// slot for one, and this is the assertion that keeps it that way.
		for (const operation of ROUTER_UNAVAILABLE_OPERATIONS) {
			expect(Object.keys(operation).sort()).toEqual([
				"id",
				"reasonKey",
				"titleKey",
			]);
		}
	});

	it("is frozen, because it describes the STACK and not the attached device", () => {
		expect(Object.isFrozen(ROUTER_UNAVAILABLE_OPERATIONS)).toBe(true);
		for (const operation of ROUTER_UNAVAILABLE_OPERATIONS) {
			expect(Object.isFrozen(operation)).toBe(true);
		}
	});
});

describe("isSubnetTargetValid", () => {
	it.each(["192.168.9.1", "10.0.5.1", "172.16.9.254", "172.31.0.1"])(
		"accepts the private gateway address %s",
		(address) => {
			expect(isSubnetTargetValid(address)).toBe(true);
		},
	);

	it.each([
		["8.8.8.8", "routable"],
		["172.32.0.1", "outside the RFC1918 172.16/12 block"],
		["192.168.9.0", "names the network, not a gateway"],
		["192.168.9.255", "names the broadcast address"],
		["192.168.9", "not a dotted quad"],
		["192.168.9.256", "octet out of range"],
		["", "empty"],
		["192.168.9.1/24", "carries a prefix"],
	])("refuses %s (%s)", (address) => {
		expect(isSubnetTargetValid(address)).toBe(false);
	});

	it("tolerates surrounding whitespace, because an operator types this", () => {
		expect(isSubnetTargetValid("  192.168.9.1  ")).toBe(true);
	});
});

describe("subnetRewriteRequest", () => {
	it("always carries the device's own confirmation literal", () => {
		// `setRouterSubnetInputSchema` is `.strict()` with `confirm: z.literal(true)`
		// — a request without it never reaches the handler. Building the request in
		// one place is what stops a call site from constructing one that omits it.
		expect(subnetRewriteRequest("7", "192.168.9.1")).toEqual({
			device: "7",
			address: "192.168.9.1",
			confirm: true,
		});
	});

	it("trims the typed address rather than sending it verbatim", () => {
		expect(subnetRewriteRequest("7", " 192.168.9.1 ").address).toBe(
			"192.168.9.1",
		);
	});
});

describe("subnetOutcome", () => {
	it("reports an applied rewrite as applied", () => {
		expect(subnetOutcome({ status: "applied" })).toEqual({
			kind: "applied",
			key: "network.routerCellular.subnet.applied",
		});
	});

	it("reports an auto-restored rewrite as refused, not as a failure", () => {
		// `reverted` means the restore was reconfirmed at the OLD address, so
		// nothing is outstanding — the operator's change simply did not take.
		expect(subnetOutcome({ status: "reverted", detail: "restored" })).toEqual({
			kind: "refused",
			key: "network.routerCellular.subnet.reverted",
		});
	});

	it("reports a blocked rewrite as UNKNOWN, never as applied or refused", () => {
		// The device answered at NEITHER address, so nothing about the write can be
		// asserted in either direction. `refused` would claim the old settings are
		// intact; `applied` would claim the new ones are.
		expect(subnetOutcome({ status: "blocked", detail: "unreachable" })).toEqual(
			{
				kind: "unknown",
				key: "network.routerCellular.subnet.blocked",
			},
		);
	});

	it("carries the colliding interface through a subnet_conflict refusal", () => {
		expect(subnetOutcome(refused)).toEqual({
			kind: "refused",
			key: "network.routerCellular.subnet.refused.subnet_conflict",
			conflict: "eth1",
		});
	});

	it("gives every device-stated refusal its own sentence", () => {
		const errors = [
			"unsupported",
			"unreachable",
			"unreadable",
			"unsupported_netmask",
			"invalid_target",
			"no_change",
			"state_drifted",
			"unknown_device",
		] as const;
		const keys = errors.map(
			(error) => subnetOutcome({ status: "refused", error }).key,
		);
		expect(new Set(keys).size).toBe(errors.length);
		for (const key of keys) expect(key).not.toContain("interlock");
	});

	it("falls back to the interlock sentence for a mutation-safety refusal", () => {
		// The seven shared refusals arrive as `mutationRefusal` with no `error`.
		// What the shared sentence says truthfully is the part that matters most:
		// nothing was written.
		expect(
			subnetOutcome({ status: "refused", mutationRefusal: "streaming_active" }),
		).toEqual({
			kind: "refused",
			key: "network.routerCellular.subnet.refused.interlock",
		});
	});
});
