/**
 * Regression lock: the `netif` ingestion merge must carry the measured rate
 * fields (`tx_bps` / `rx_bps`) through to the store.
 *
 * The merge in `subscriptions.svelte.ts` rebuilds each interface entry from an
 * EXPLICIT field allowlist rather than spreading the incoming entry, so a field
 * added to `netifEntrySchema` is silently dropped unless it is also added there.
 * `tx_bps`/`rx_bps` were added to the schema, the backend, `buildLinks`, and
 * `BondedLinksSection` — but not to this allowlist, so the Bonded Links card and
 * TOTAL BANDWIDTH read `0 kbps` on a device genuinely carrying ~95 Mbit/s
 * (confirmed on a Rock 5B+ against the Device Stats widget as ground truth).
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

describe("netif ingestion — measured rate fields", () => {
	beforeEach(() => {
		resetState();
		initSubscriptions();
	});

	it("carries tx_bps/rx_bps through the per-field merge", () => {
		handlers.message?.("netif", {
			eth0: {
				ip: "192.168.78.131",
				tp: 59376320,
				enabled: true,
				tx_bps: 94964126,
				rx_bps: 1288584,
			},
		});

		const eth0 = getNetif()?.eth0;
		expect(eth0).toBeDefined();
		expect(eth0?.tx_bps).toBe(94964126);
		expect(eth0?.rx_bps).toBe(1288584);
	});

	it("keeps the prior rate when a tick omits it (same rule as ip/error/mac)", () => {
		handlers.message?.("netif", {
			eth0: {
				ip: "10.0.0.2",
				tp: 100,
				enabled: true,
				tx_bps: 5000,
				rx_bps: 6000,
			},
		});
		handlers.message?.("netif", {
			eth0: { ip: "10.0.0.2", tp: 120, enabled: true },
		});

		expect(getNetif()?.eth0?.tx_bps).toBe(5000);
		expect(getNetif()?.eth0?.rx_bps).toBe(6000);
	});
});
