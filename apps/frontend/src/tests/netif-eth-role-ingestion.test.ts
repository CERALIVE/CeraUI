/**
 * Regression lock: the `netif` ingestion merge must carry `ethRole` through.
 *
 * The merge in `subscriptions.svelte.ts` rebuilds each entry from an EXPLICIT
 * field allowlist rather than spreading the incoming entry, so a field added to
 * `netifEntrySchema` is silently dropped unless it is added there too — the exact
 * seam where `tx_bps` shipped fully green and rendered 0 kbps on hardware.
 *
 * The RETRACTION direction is asserted as well, and it is the half that matters
 * most here: the merge preserves an omitted optional field, so a role that only
 * ever travelled as `shared-lan` could be raised and never lowered (the
 * `policy_route_missing` latch). The backend states the role on every ethernet
 * row precisely so the ordinary spread-when-present rule carries both ways.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers: { message?: (t: string, d: unknown, s?: number) => void } = {};

vi.mock("$lib/rpc/client", () => ({
	rpc: {},
	rpcClient: {
		onMessage: (fn: (t: string, d: unknown, s?: number) => void) => {
			handlers.message = fn;
		},
		onConnectionChange: () => undefined,
		connect: () => undefined,
		getSocket: () => undefined,
		sendLegacy: () => undefined,
	},
}));

import {
	getNetif,
	initSubscriptions,
	resetState,
} from "$lib/rpc/subscriptions.svelte";

describe("netif ingestion — the Ethernet port role", () => {
	beforeEach(() => {
		resetState();
		initSubscriptions();
	});

	it("carries `shared-lan` through the per-field merge", () => {
		handlers.message?.("netif", {
			eth1: {
				ip: "10.42.0.1",
				tp: 0,
				enabled: false,
				error: "shared LAN",
				ethRole: "shared-lan",
			},
		});

		expect(getNetif()?.eth1?.ethRole).toBe("shared-lan");
	});

	it("carries the RETRACTION — a flip back to `uplink` lowers the claim", () => {
		handlers.message?.("netif", {
			eth1: { ip: "10.42.0.1", tp: 0, enabled: false, ethRole: "shared-lan" },
		});
		expect(getNetif()?.eth1?.ethRole).toBe("shared-lan");

		handlers.message?.("netif", {
			eth1: { ip: "192.168.1.50", tp: 0, enabled: true, ethRole: "uplink" },
		});

		expect(getNetif()?.eth1?.ethRole).toBe("uplink");
	});

	it("keeps the prior role when a tick omits it (same rule as ip/error/mac)", () => {
		handlers.message?.("netif", {
			eth1: { ip: "10.42.0.1", tp: 0, enabled: false, ethRole: "shared-lan" },
		});
		handlers.message?.("netif", {
			eth1: { ip: "10.42.0.1", tp: 5, enabled: false },
		});

		expect(getNetif()?.eth1?.ethRole).toBe("shared-lan");
	});

	it("a non-ethernet row never acquires a role", () => {
		handlers.message?.("netif", {
			wlan0: { ip: "192.168.1.50", tp: 0, enabled: true },
		});

		expect(getNetif()?.wlan0).toBeDefined();
		expect(getNetif()?.wlan0?.ethRole).toBeUndefined();
	});
});
