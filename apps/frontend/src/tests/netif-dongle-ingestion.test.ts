/**
 * Regression lock: the `netif` ingestion merge must carry the dongle marker
 * through, and must PRUNE a row whose final `dongle: null` frame arrives.
 *
 * The merge rebuilds each entry from a hand-maintained field allowlist, so a
 * field added to `netifEntrySchema` is silently dropped unless it is added there
 * too — the exact seam where `tx_bps` once shipped "fully green" and rendered
 * 0 kbps on hardware. It also PRESERVES rows an incoming frame omits, so a
 * released dongle would otherwise ghost forever with its last IP.
 *
 * These drive the REAL ingestion handler; a test aimed at a renderer sits
 * downstream of this seam and cannot catch either defect.
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

describe("netif ingestion — dongle marker", () => {
	beforeEach(() => {
		resetState();
		initSubscriptions();
	});

	it("carries the dongle marker through the per-field merge", () => {
		handlers.message?.("netif", {
			dg0h: {
				ip: "10.208.0.1",
				tp: 1000,
				enabled: true,
				dongle: { slot: 0, state: "up" },
			},
		});

		expect(getNetif()?.dg0h?.dongle).toEqual({ slot: 0, state: "up" });
	});

	it("ingests a wire-only union row for an acquiring dongle", () => {
		handlers.message?.("netif", {
			dg1h: {
				tp: 0,
				enabled: false,
				tx_bps: 0,
				rx_bps: 0,
				dongle: { slot: 1, state: "acquiring" },
			},
		});

		const row = getNetif()?.dg1h;
		expect(row?.dongle).toEqual({ slot: 1, state: "acquiring" });
		expect(row?.ip).toBeUndefined();
		expect(row?.enabled).toBe(false);
	});

	it("keeps the prior marker when a tick omits it", () => {
		handlers.message?.("netif", {
			dg0h: {
				ip: "10.208.0.1",
				tp: 1,
				enabled: true,
				dongle: { slot: 0, state: "up" },
			},
		});
		handlers.message?.("netif", {
			dg0h: { ip: "10.208.0.1", tp: 2, enabled: true },
		});

		expect(getNetif()?.dg0h?.dongle).toEqual({ slot: 0, state: "up" });
	});

	it("updates the marker in place on a state transition", () => {
		handlers.message?.("netif", {
			dg0h: { tp: 0, enabled: false, dongle: { slot: 0, state: "acquiring" } },
		});
		handlers.message?.("netif", {
			dg0h: { tp: 0, enabled: false, dongle: { slot: 0, state: "down" } },
		});

		expect(getNetif()?.dg0h?.dongle).toEqual({ slot: 0, state: "down" });
	});

	// The released-LIVE-dongle case: the row carries a real IP, and without the
	// prune it survives every later frame with that stale address.
	it("prunes a released LIVE dongle row on its dongle:null frame", () => {
		handlers.message?.("netif", {
			dg0h: {
				ip: "10.208.0.1",
				tp: 1000,
				enabled: true,
				dongle: { slot: 0, state: "up" },
			},
		});
		expect(getNetif()?.dg0h).toBeDefined();

		handlers.message?.("netif", {
			dg0h: { ip: "10.208.0.1", tp: 1000, enabled: true, dongle: null },
		});

		expect(getNetif()?.dg0h).toBeUndefined();
	});

	it("prunes a union-only row on its final dongle:null frame", () => {
		handlers.message?.("netif", {
			dg1h: { tp: 0, enabled: false, dongle: { slot: 1, state: "acquiring" } },
		});
		expect(getNetif()?.dg1h).toBeDefined();

		handlers.message?.("netif", {
			dg1h: { tp: 0, enabled: false, dongle: null },
		});

		expect(getNetif()?.dg1h).toBeUndefined();
	});

	// REVERSAL, stated so a changed frame does not read as a weakened test: this
	// case used to send the retraction as a LONE-KEY frame and assert the two
	// unmentioned rows survived it. The key set is now authoritative, so the
	// frame is written the way `netIfBuildMsg()` actually sends it — the full
	// map, minus nothing — and the assertion is unchanged and strictly stronger:
	// the retraction still prunes exactly one row and collateral-damages none.
	it("pruning one dongle leaves every other row untouched", () => {
		handlers.message?.("netif", {
			eth0: { ip: "192.168.78.132", tp: 5, enabled: true, tx_bps: 94964126 },
			dg0h: {
				ip: "10.208.0.1",
				tp: 1,
				enabled: true,
				dongle: { slot: 0, state: "up" },
			},
			dg1h: { tp: 0, enabled: false, dongle: { slot: 1, state: "down" } },
		});

		handlers.message?.("netif", {
			eth0: { ip: "192.168.78.132", tp: 5, enabled: true, tx_bps: 94964126 },
			dg0h: { ip: "10.208.0.1", tp: 1, enabled: true, dongle: null },
			dg1h: { tp: 0, enabled: false, dongle: { slot: 1, state: "down" } },
		});

		expect(getNetif()?.dg0h).toBeUndefined();
		expect(getNetif()?.eth0?.tx_bps).toBe(94964126);
		expect(getNetif()?.dg1h?.dongle).toEqual({ slot: 1, state: "down" });
	});

	// Plain absence must keep meaning "not a dongle" — a non-dongle row may never
	// be pruned by this rule.
	it("never prunes a row that carries no dongle field at all", () => {
		handlers.message?.("netif", {
			eth0: { ip: "192.168.78.132", tp: 5, enabled: true },
		});
		handlers.message?.("netif", {
			eth0: { ip: "192.168.78.132", tp: 6, enabled: true },
		});

		expect(getNetif()?.eth0?.tp).toBe(6);
		expect(getNetif()?.eth0?.dongle).toBeUndefined();
	});
});
