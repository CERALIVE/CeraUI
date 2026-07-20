// @vitest-environment jsdom
/**
 * EthernetSection — link-local (169.254/16) clarity (plan Todo 52).
 *
 * On CeraLive devices the wired control port ALWAYS carries a 169.254.x.x
 * link-local address (image sets `ipv4.link-local=3` on eth0). `ifconfig` reports
 * it first, so the backend netif scan surfaces it as the interface `ip`, and the
 * operator sees an address that looks like a stuck / hardcoded static IP. This
 * suite proves the row labels such an address as an automatic link-local address
 * (calm badge + hint) and leaves a normal DHCP/static address unlabelled.
 */
import type { NetifEntry } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import EthernetSection from "./EthernetSection.svelte";

// EthernetSection renders BondToggle, which imports the RPC client + subscriptions.
// Stub both so the unit stays hermetic (no socket, no env) — mirrors BondToggle.test.ts.
vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

function entry(overrides: Partial<NetifEntry> = {}): NetifEntry {
	return { tp: 0, enabled: true, ...overrides };
}

function renderRow(ip: string) {
	return render(EthernetSection, {
		props: {
			wiredEntries: [["eth0", entry({ ip })]] as [string, NetifEntry][],
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConfigure: vi.fn(),
		},
	});
}

describe("EthernetSection — link-local address clarity (Todo 52)", () => {
	it("labels a 169.254.x.x address with a calm badge + explanatory hint", () => {
		const { getByTestId } = renderRow("169.254.149.160");

		// The badge names it "Link-local" right at the point of confusion (the IP).
		expect(getByTestId("netif-link-local").textContent).toContain("Link-local");
		// The hint explains it is automatic + not a saved setting.
		expect(getByTestId("netif-link-local-hint")).toBeTruthy();
		// The address itself is still shown verbatim.
		expect(getByTestId("netif-link-local-hint").textContent).toContain(
			"169.254",
		);
	});

	it("does NOT label a normal routable DHCP/static address", () => {
		const { queryByTestId } = renderRow("192.168.78.131");

		expect(queryByTestId("netif-link-local")).toBeNull();
		expect(queryByTestId("netif-link-local-hint")).toBeNull();
	});
});
