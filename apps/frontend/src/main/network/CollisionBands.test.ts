// @vitest-environment jsdom
/**
 * CollisionBands — subnet-collision + policy-route health surfacing (Task 13).
 *
 * Proves the three states derived from the additive-optional netif fields
 * (`same_subnet_group` — Todo 11; `policy_route_missing` — Todo 12):
 *
 *   (a) same_subnet_group set  → calm INFORMATIONAL band (never warning-styled).
 *   (b) policy_route_missing   → amber WARNING band.
 *   (c) duplicate-IPv4 `error` set alone → NEITHER new band (dup-IP surfaces via
 *       a backend notification, entirely separate; the two new states are
 *       orthogonal to it and must not fire for a pure dup-IP payload).
 *
 * Neither new state is a functional gate — this component renders bands only.
 */

import type { NetifEntry, NetifMessage } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import CollisionBands from "./CollisionBands.svelte";

function entry(partial: Partial<NetifEntry>): NetifEntry {
	return { tp: 0, enabled: true, ...partial };
}

describe("CollisionBands — subnet collision + policy-route surfacing (Task 13)", () => {
	it("(a) renders the calm same-subnet-info band when an interface has same_subnet_group", () => {
		const netif: NetifMessage = {
			usb0: entry({ ip: "192.168.0.10", same_subnet_group: "192.168.0.0/24" }),
			usb1: entry({ ip: "192.168.0.11", same_subnet_group: "192.168.0.0/24" }),
		};
		const { queryByTestId } = render(CollisionBands, { props: { netif } });

		const info = queryByTestId("same-subnet-info");
		expect(info, "same-subnet-info band must render").not.toBeNull();

		// The CIDR label is surfaced exactly once (deduped across both members).
		expect(info?.textContent).toContain("192.168.0.0/24");
		expect(info?.querySelectorAll("code")).toHaveLength(1);

		// CALM / INFORMATIONAL — info styling, NEVER a warning/error colour.
		const cls = info?.className ?? "";
		expect(cls).toContain("status-info");
		expect(cls).not.toContain("status-warning");
		expect(cls).not.toContain("status-error");

		// The policy-route warning must NOT appear for a pure same-subnet payload.
		expect(queryByTestId("policy-route-warning")).toBeNull();
	});

	it("(b) renders the amber policy-route-warning band when an interface has policy_route_missing", () => {
		const netif: NetifMessage = {
			usb0: entry({ ip: "10.0.0.2", policy_route_missing: true }),
			eth0: entry({ ip: "10.0.1.2" }),
		};
		const { queryByTestId } = render(CollisionBands, { props: { netif } });

		const warning = queryByTestId("policy-route-warning");
		expect(warning, "policy-route-warning band must render").not.toBeNull();

		// WARNING — amber status-warning styling.
		const cls = warning?.className ?? "";
		expect(cls).toContain("status-warning");

		// The same-subnet info band must NOT appear for a pure policy-route payload.
		expect(queryByTestId("same-subnet-info")).toBeNull();
	});

	it("(c) a duplicate-IPv4 `error` payload alone fires NEITHER new band (dup-IP unaffected)", () => {
		// A dup-IP interface (backend flags `error` + disables it); dup-IP is
		// surfaced via a `netif_dup_ip` notification, NOT by this component. With
		// no same_subnet_group and no policy_route_missing, no new band renders.
		const netif: NetifMessage = {
			usb0: entry({
				ip: "192.168.1.5",
				enabled: false,
				error: "duplicate IPv4 addr",
			}),
			usb1: entry({
				ip: "192.168.1.5",
				enabled: false,
				error: "duplicate IPv4 addr",
			}),
		};
		const { queryByTestId } = render(CollisionBands, { props: { netif } });

		expect(queryByTestId("same-subnet-info")).toBeNull();
		expect(queryByTestId("policy-route-warning")).toBeNull();
	});

	it("(c') a dup-IP `error` alongside a distinct same-subnet group shows only same-subnet (dup-IP entry ignored)", () => {
		const netif: NetifMessage = {
			// dup-IP pair — flagged by the backend, NOT tagged same_subnet_group.
			eth0: entry({
				ip: "192.168.1.5",
				enabled: false,
				error: "duplicate IPv4 addr",
			}),
			eth1: entry({
				ip: "192.168.1.5",
				enabled: false,
				error: "duplicate IPv4 addr",
			}),
			// A separate, healthy shared-subnet modem pair.
			usb0: entry({ ip: "192.168.9.2", same_subnet_group: "192.168.9.0/24" }),
			usb1: entry({ ip: "192.168.9.3", same_subnet_group: "192.168.9.0/24" }),
		};
		const { queryByTestId } = render(CollisionBands, { props: { netif } });

		const info = queryByTestId("same-subnet-info");
		expect(info).not.toBeNull();
		expect(info?.textContent).toContain("192.168.9.0/24");
		expect(queryByTestId("policy-route-warning")).toBeNull();
	});

	it("renders nothing when no interface carries either field (undefined netif is loading-safe)", () => {
		const { queryByTestId: qEmpty } = render(CollisionBands, {
			props: { netif: { eth0: entry({ ip: "10.0.0.9" }) } },
		});
		expect(qEmpty("same-subnet-info")).toBeNull();
		expect(qEmpty("policy-route-warning")).toBeNull();

		const { queryByTestId: qUndef } = render(CollisionBands, {
			props: { netif: undefined },
		});
		expect(qUndef("same-subnet-info")).toBeNull();
		expect(qUndef("policy-route-warning")).toBeNull();
	});
});
