/**
 * The pure Ethernet-role derivation: the offering, the held display role, the
 * streaming interlock, and the honest `shared-lan` row.
 */
import type { NetifEntry } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	deriveEthernetRoleConsequence,
	deriveEthernetRoleStagedWarning,
	deriveEthernetRoleView,
	deriveSharedLanRow,
	ETHERNET_ROLES,
	ethernetRoleConsequenceKeys,
	ethernetRoleContext,
	ethernetRoleErrorKey,
	ethernetRoleLabelKey,
	ethernetRoleOpKey,
	ethernetRoleTarget,
} from "./ethernet-role-view";

function iface(overrides: Partial<NetifEntry> = {}): NetifEntry {
	return { tp: 0, enabled: true, ip: "192.168.1.50", ...overrides };
}

describe("ethernetRoleOpKey", () => {
	it("namespaces the port name", () => {
		expect(ethernetRoleOpKey("eth0")).toBe("eth-role:eth0");
	});
});

describe("ethernetRoleTarget", () => {
	it.each(ETHERNET_ROLES)("narrows the opaque op target %s", (role) => {
		expect(ethernetRoleTarget(role)).toBe(role);
	});

	it.each([undefined, null, "uplinks", 3, {}])(
		"answers undefined for %p",
		(value) => {
			expect(ethernetRoleTarget(value)).toBeUndefined();
		},
	);
});

describe("deriveEthernetRoleView — the offering", () => {
	it("is UNSUPPORTED for a row the device published no role for", () => {
		// ABSENT means "not an ethernet port, or an older backend", never `uplink`.
		const view = deriveEthernetRoleView({
			name: "dg0h",
			iface: iface(),
			phase: "idle",
		});
		expect(view.supported).toBe(false);
	});

	it("offers BOTH roles, in a fixed order, each with its own consequence", () => {
		const view = deriveEthernetRoleView({
			name: "eth0",
			iface: iface({ ethRole: "uplink" }),
			phase: "idle",
		});
		expect(view.supported).toBe(true);
		expect(view.options.map((o) => o.role)).toEqual(["uplink", "shared-lan"]);
		expect(view.options.map((o) => o.consequenceKey)).toEqual([
			"network.ethRole.uplinkConsequence",
			"network.ethRole.sharedLanConsequence",
		]);
		expect(view.options.filter((o) => o.selected).map((o) => o.role)).toEqual([
			"uplink",
		]);
	});

	it("selects the shared-lan rung when the device reports that role", () => {
		const view = deriveEthernetRoleView({
			name: "eth1",
			iface: iface({ ethRole: "shared-lan", enabled: false, ip: "10.42.0.1" }),
			phase: "idle",
		});
		expect(view.displayRole).toBe("shared-lan");
		expect(view.observedRole).toBe("shared-lan");
	});

	it("labels every rung through the shared key table", () => {
		expect(ethernetRoleLabelKey("uplink")).toBe("network.ethRole.uplink");
		expect(ethernetRoleLabelKey("shared-lan")).toBe(
			"network.ethRole.sharedLan",
		);
	});
});

describe("deriveEthernetRoleView — a pending transition HOLDS the prior role", () => {
	it("keeps the prior role selected once the observation has moved", () => {
		// The device can report the new role before its terminal frame lands;
		// flipping the control there would report an outcome that has not settled.
		const view = deriveEthernetRoleView({
			name: "eth0",
			iface: iface({ ethRole: "shared-lan" }),
			phase: "pending",
			target: "shared-lan",
		});
		expect(view.pending).toBe(true);
		expect(view.pendingTarget).toBe("shared-lan");
		expect(view.displayRole).toBe("uplink");
		expect(view.observedRole).toBe("shared-lan");
		expect(view.options.find((o) => o.role === "shared-lan")?.pending).toBe(
			true,
		);
	});

	it("shows the observation while it still disagrees with the target", () => {
		const view = deriveEthernetRoleView({
			name: "eth0",
			iface: iface({ ethRole: "uplink" }),
			phase: "pending",
			target: "shared-lan",
		});
		expect(view.displayRole).toBe("uplink");
	});

	it("carries no error while pending", () => {
		const view = deriveEthernetRoleView({
			name: "eth0",
			iface: iface({ ethRole: "uplink" }),
			phase: "pending",
			target: "shared-lan",
		});
		expect(view.errorKey).toBeUndefined();
	});
});

describe("deriveEthernetRoleView — a TERMINAL failure keeps the prior role", () => {
	it.each([
		["unknown_interface", "network.ethRole.error.unknownInterface"],
		["not_ethernet", "network.ethRole.error.notEthernet"],
		["no_connection", "network.ethRole.error.noConnection"],
		["apply_failed", "network.ethRole.error.applyFailed"],
		[
			"unavailable_in_emulated_mode",
			"network.ethRole.error.unavailableEmulated",
		],
	])("keys %s onto its own sentence", (reason, key) => {
		const view = deriveEthernetRoleView({
			name: "eth0",
			iface: iface({ ethRole: "uplink" }),
			phase: "failed",
			target: "shared-lan",
			failureReason: reason,
		});
		expect(view.errorKey).toBe(key);
		expect(view.error).toBe(reason);
		expect(view.displayRole).toBe("uplink");
	});

	it("renders an UNRECOGNISED token as the generic sentence, never raw", () => {
		expect(ethernetRoleErrorKey("some_future_token")).toBe(
			"network.ethRole.error.generic",
		);
		expect(ethernetRoleErrorKey(undefined)).toBe(
			"network.ethRole.error.generic",
		);
	});

	it("a TTL timeout is a distinct sentence from a refusal", () => {
		const timedOut = deriveEthernetRoleView({
			name: "eth0",
			iface: iface({ ethRole: "uplink" }),
			phase: "timed_out",
			target: "shared-lan",
		});
		const refused = deriveEthernetRoleView({
			name: "eth0",
			iface: iface({ ethRole: "uplink" }),
			phase: "failed",
			target: "shared-lan",
			failureReason: "apply_failed",
		});
		expect(timedOut.errorKey).toBe("network.ethRole.error.notConfirmed");
		expect(timedOut.errorKey).not.toBe(refused.errorKey);
	});
});

describe("deriveEthernetRoleConsequence — the streaming interlock", () => {
	const bondedLive = { bondedUplink: true, streaming: true };

	it("asks before taking a bonded uplink out of a LIVE stream", () => {
		expect(
			deriveEthernetRoleConsequence("uplink", "shared-lan", bondedLive),
		).toBe("drops-bonded-uplink");
	});

	it("does NOT ask when nothing is streaming", () => {
		expect(
			deriveEthernetRoleConsequence("uplink", "shared-lan", {
				bondedUplink: true,
				streaming: false,
			}),
		).toBeUndefined();
	});

	it("does NOT ask when the port carries no bonded traffic", () => {
		expect(
			deriveEthernetRoleConsequence("uplink", "shared-lan", {
				bondedUplink: false,
				streaming: true,
			}),
		).toBeUndefined();
	});

	it("does NOT ask on the additive direction back to uplink", () => {
		expect(
			deriveEthernetRoleConsequence("shared-lan", "uplink", bondedLive),
		).toBeUndefined();
	});

	it("does NOT ask when the role is unchanged", () => {
		expect(
			deriveEthernetRoleConsequence("uplink", "uplink", bondedLive),
		).toBeUndefined();
	});

	it("names three distinct copy keys for the one consequence", () => {
		const keys = ethernetRoleConsequenceKeys("drops-bonded-uplink");
		expect(new Set(Object.values(keys)).size).toBe(3);
		for (const key of Object.values(keys)) {
			expect(key.startsWith("network.ethRole.confirm.")).toBe(true);
		}
	});
});

describe("deriveEthernetRoleStagedWarning — a staged change is visible", () => {
	const idle = { bondedUplink: true, streaming: false };
	const bondedLive = { bondedUplink: true, streaming: true };

	it("warns whenever the staged role differs from the applied one", () => {
		const warning = deriveEthernetRoleStagedWarning(
			"uplink",
			"shared-lan",
			idle,
		);
		expect(warning?.target).toBe("shared-lan");
		expect(warning?.titleKey).toBe("network.ethRole.staged.title");
		expect(warning?.bodyKey).toBe("network.ethRole.staged.body");
	});

	it("warns in BOTH directions — leaving shared-LAN reconfigures the port too", () => {
		expect(
			deriveEthernetRoleStagedWarning("shared-lan", "uplink", idle)?.target,
		).toBe("uplink");
	});

	it("stays SILENT when the staged role equals the applied one", () => {
		expect(
			deriveEthernetRoleStagedWarning("uplink", "uplink", bondedLive),
		).toBeUndefined();
	});

	it("stays SILENT when nothing is staged at all", () => {
		expect(
			deriveEthernetRoleStagedWarning("uplink", undefined, bondedLive),
		).toBeUndefined();
	});

	it("carries NO live-bond sentence for an ordinary staged change", () => {
		const warning = deriveEthernetRoleStagedWarning(
			"uplink",
			"shared-lan",
			idle,
		);
		expect(warning?.consequence).toBeUndefined();
		expect(warning?.consequenceBodyKey).toBeUndefined();
	});

	it("ADDS the interlock sentence beside the reachability one, never instead of it", () => {
		const warning = deriveEthernetRoleStagedWarning(
			"uplink",
			"shared-lan",
			bondedLive,
		);
		expect(warning?.bodyKey).toBe("network.ethRole.staged.body");
		expect(warning?.consequence).toBe("drops-bonded-uplink");
		expect(warning?.consequenceBodyKey).toBe(
			ethernetRoleConsequenceKeys("drops-bonded-uplink").body,
		);
	});

	it("escalates on exactly the interlock's own verdict, never a second rule", () => {
		for (const ctx of [
			idle,
			bondedLive,
			{ bondedUplink: false, streaming: true },
		]) {
			for (const from of ETHERNET_ROLES) {
				for (const to of ETHERNET_ROLES) {
					expect(
						deriveEthernetRoleStagedWarning(from, to, ctx)?.consequence,
					).toBe(deriveEthernetRoleConsequence(from, to, ctx));
				}
			}
		}
	});
});

describe("ethernetRoleContext — bond membership mirrors the device's own rule", () => {
	it("reads a live, addressed, error-free port as a bonded uplink", () => {
		expect(
			ethernetRoleContext(iface({ ethRole: "uplink" }), true).bondedUplink,
		).toBe(true);
	});

	it.each([
		["no address", iface({ ethRole: "uplink", ip: "" })],
		["operator-excluded", iface({ ethRole: "uplink", enabled: false })],
		[
			"device-excluded",
			iface({ ethRole: "uplink", error: "duplicate IPv4 addr" }),
		],
		[
			"already shared",
			iface({ ethRole: "shared-lan", enabled: false, error: "shared LAN" }),
		],
	])("reads a %s port as NOT bonded", (_label, entry) => {
		expect(ethernetRoleContext(entry, true).bondedUplink).toBe(false);
	});

	it("reads an absent interface as NOT bonded", () => {
		expect(ethernetRoleContext(undefined, true).bondedUplink).toBe(false);
	});
});

describe("deriveSharedLanRow — the honest row", () => {
	it("answers nothing for an uplink port", () => {
		expect(deriveSharedLanRow(iface({ ethRole: "uplink" }))).toBeUndefined();
	});

	it("answers nothing for a row with NO published role", () => {
		expect(deriveSharedLanRow(iface())).toBeUndefined();
		expect(deriveSharedLanRow(undefined)).toBeUndefined();
	});

	it("reads an addressed shared port as SERVING", () => {
		const row = deriveSharedLanRow(
			iface({ ethRole: "shared-lan", enabled: false, ip: "10.42.0.1" }),
		);
		expect(row?.zone).toBe("serving");
		expect(row?.zoneLabelKey).toBe("network.ethRole.zoneServing");
	});

	it("reads an address-less shared port as STARTING, never as serving", () => {
		const row = deriveSharedLanRow(
			iface({ ethRole: "shared-lan", enabled: false, ip: "" }),
		);
		expect(row?.zone).toBe("starting");
		expect(row?.zoneLabelKey).toBe("network.ethRole.zoneStarting");
	});

	it("always names WHY the port is out of the bond", () => {
		const row = deriveSharedLanRow(
			iface({ ethRole: "shared-lan", ip: "10.42.0.1" }),
		);
		expect(row?.bondExclusionReasonKey).toBe(
			"network.ethRole.excludedFromBondReason",
		);
	});

	it("keys on the operator's ROLE, not on the device's wire error label", () => {
		// A port carrying the shared-LAN netif flag but no declared role is not the
		// operator's claim, and must not be rendered as one.
		expect(
			deriveSharedLanRow(iface({ error: "shared LAN", enabled: false })),
		).toBeUndefined();
	});
});
