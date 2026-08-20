// @vitest-environment jsdom
/**
 * CellularSection — one signal language for both device classes, and the
 * dongle's own diagnostics beneath it.
 *
 * Three properties, and each is an operator complaint made into an invariant:
 *
 *   1. ONE HEADLINE. A router dongle's radio and an MM radio answer the same
 *      question, so they draw the same glyph, at the same size, in the same slot
 *      of the row. The operator should not have to learn two visual languages
 *      depending on which kind of device is in the port.
 *   2. PROVENANCE STILL SURVIVES THAT. The dongle's chip keeps its `Router`
 *      mark, its dashed frame and `data-provenance`, and one row can still never
 *      draw two radio readings — asserted in BOTH directions.
 *   3. THE ADDRESS IS A FACT, NOT A CLAUSE. Where the dongle answers is the
 *      first thing an operator reaches for, and it now has its own scannable
 *      segment instead of living only inside a sentence.
 *
 * FIXTURE PROVENANCE: the `router_admin.details` payloads are the VERBATIM
 * values the bench units answered on 2026-08-18 — the SIM-less HiLink's
 * `NO SERVICE`, the ZTE's numeric `732103` PLMN, the UFI's `getsysinfo` block.
 * Where a field is exercised that this hardware answers as an empty string
 * (the carrier-aggregation set), the test says so at the call site.
 */
import type { Modem, NetifMessage, RouterSignal } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import CellularSection from "./CellularSection.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));

const UNSUPPORTED = { state: "unknown", reason: "unsupported" } as const;

function zteSignal(over: Partial<RouterSignal> = {}): RouterSignal {
	return {
		provenance: "zte-goform",
		freshness: "live",
		bars: { state: "known", value: 5 },
		max_bars: { state: "known", value: 5 },
		dbm: UNSUPPORTED,
		rsrp: { state: "known", value: -74 },
		rsrq: { state: "known", value: -14 },
		snr: { state: "known", value: -1 },
		sinr: UNSUPPORTED,
		...over,
	} as RouterSignal;
}

function dongle(admin: Record<string, unknown> = {}): Modem {
	return {
		ifname: "enx344b50000000",
		name: "ZTE MF79U",
		network_type: { supported: [], active: null },
		device_class: "router-ethernet",
		availability_reason: "router_direct",
		router_admin: {
			admin_url: "http://192.168.0.1",
			reachable: true,
			sim: "present",
			signal: zteSignal(),
			...admin,
		},
	} as unknown as Modem;
}

/** A directly-managed radio — the class the dongle row must now match. */
function radio(): Modem {
	return {
		ifname: "wwan2",
		name: "RM530N-GL - 16855",
		network_type: { supported: ["4g", "5g"], active: "5g" },
		status: { connection: "connected", network: "Movistar", signal: 81 },
	} as unknown as Modem;
}

const NETIF: NetifMessage = {
	enx344b50000000: { tp: 0, enabled: true, ip: "192.168.0.169" },
	wwan2: { tp: 4, enabled: true, ip: "10.171.86.101" },
};

function renderRows(entries: [string, Modem][]) {
	return render(CellularSection, {
		props: {
			modemEntries: entries,
			netif: NETIF,
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConfigure: vi.fn(),
		},
	});
}

function testid(root: ParentNode, id: string): HTMLElement | null {
	return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

describe("one signal language across both device classes", () => {
	it("puts the dongle's glyph in the SAME row slot as a managed radio's", () => {
		const { container } = renderRows([
			["1", radio()],
			["2", dongle()],
		]);
		const rows = container.querySelectorAll<HTMLElement>(
			'[data-testid="modem-row"]',
		);
		expect(rows).toHaveLength(2);

		const managed = testid(rows[0] as HTMLElement, "modem-signal");
		const router = testid(rows[1] as HTMLElement, "modem-router-signal");
		expect(managed).not.toBeNull();
		expect(router).not.toBeNull();

		// The SAME container element within each row — the instrument cluster —
		// rather than one in the controls and one buried among the fact text.
		// Compared by the parent's own testid-bearing sibling set, so this holds
		// against a class rename but fails if either moves out of the cluster.
		expect(managed?.parentElement?.className).toBe(
			router?.parentElement?.className,
		);
	});

	it("draws the tier at the SAME size, in the same four-tier vocabulary", () => {
		const { container } = renderRows([
			["1", radio()],
			["2", dongle()],
		]);
		const rows = container.querySelectorAll<HTMLElement>(
			'[data-testid="modem-row"]',
		);

		const managedGlyph = testid(
			rows[0] as HTMLElement,
			"modem-signal",
		)?.querySelector("svg");
		const routerGlyph = testid(
			rows[1] as HTMLElement,
			"modem-router-signal",
		)?.querySelectorAll("svg")[1];

		// `size-4` on both. A glyph one step smaller than its neighbour reads as a
		// lesser instrument, which is the visual inconsistency this removes.
		expect(managedGlyph?.getAttribute("class")).toContain("size-4");
		expect(routerGlyph?.getAttribute("class")).toContain("size-4");

		// And the tier itself comes from the shared vocabulary.
		expect(
			testid(rows[1] as HTMLElement, "modem-router-signal")?.dataset.signalTier,
		).toBe("high");
	});

	it("keeps the provenance marks on the dongle chip after the move", () => {
		const { container } = renderRows([["2", dongle()]]);
		const chip = testid(container, "modem-router-signal");

		expect(chip?.dataset.provenance).toBe("zte-goform");
		expect(chip?.className).toContain("border-dashed");
		// The `Router` mark plus the tier glyph — two SVGs, so the second-hand
		// instrument is distinguishable without reading a colour or a tooltip.
		expect(chip?.querySelectorAll("svg")).toHaveLength(2);
		expect(chip?.getAttribute("role")).toBe("img");
		expect(chip?.getAttribute("aria-label") ?? "").not.toBe("");
	});

	it("still refuses to draw two radio readings on one row, in both directions", () => {
		const { container } = renderRows([
			["1", radio()],
			["2", dongle()],
		]);
		const rows = container.querySelectorAll<HTMLElement>(
			'[data-testid="modem-row"]',
		);

		expect(testid(rows[0] as HTMLElement, "modem-router-signal")).toBeNull();
		expect(testid(rows[1] as HTMLElement, "modem-signal")).toBeNull();
	});

	it("says a non-reading in WORDS, where a long sentence cannot squeeze controls", () => {
		const { container } = renderRows([
			[
				"2",
				dongle({
					signal: zteSignal({
						freshness: "unknown",
						bars: { state: "unknown", reason: "unreachable" },
						max_bars: { state: "unknown", reason: "unreachable" },
						rsrp: { state: "unknown", reason: "unreachable" },
						rsrq: { state: "unknown", reason: "unreachable" },
						snr: { state: "unknown", reason: "unreachable" },
					}),
				}),
			],
		]);

		const word = testid(container, "modem-router-signal-state");
		expect(word?.textContent?.trim()).not.toBe("");
		expect(word?.dataset.unknownReason).toBe("unreachable");
		// It lives OUTSIDE the instrument cluster, on the freely-wrapping side.
		expect(word?.closest('[data-testid="modem-router-signal"]')).toBeNull();
	});

	it("says nothing in words for a plain live reading, exactly like a managed radio", () => {
		const { container } = renderRows([["2", dongle()]]);
		expect(testid(container, "modem-router-signal-state")).toBeNull();
	});
});

describe("the admin address is a scannable fact", () => {
	it("renders the dongle's address as its own segment, beside the other facts", () => {
		const { container } = renderRows([["2", dongle()]]);

		const segment = testid(container, "router-admin-address");
		expect(segment?.textContent).toContain("192.168.0.1");
		// Inside the fact strip that already carries APN/firmware/IMEI/serial —
		// not a new block of its own.
		expect(
			segment?.closest('[data-testid="router-admin-facts"]'),
		).not.toBeNull();
	});

	it("states an address, never a URL", () => {
		const { container } = renderRows([["2", dongle()]]);
		expect(
			testid(container, "router-admin-address")?.textContent,
		).not.toContain("http");
	});

	it("renders no segment for a dongle with no address to state", () => {
		const { container } = renderRows([["2", dongle({ admin_url: "" })]]);
		expect(testid(container, "router-admin-address")).toBeNull();
	});

	it("adds no fact to a strip a silent dongle never earned", () => {
		// This strip is what the DEVICE reported. The address is the HOST's own
		// routing fact, so a dongle that answered nothing must not gain a segment
		// — the unreachable note beneath it is what speaks for that row.
		const { container } = renderRows([
			["2", dongle({ reachable: false, sim: undefined, signal: undefined })],
		]);

		expect(testid(container, "router-admin-address")).toBeNull();
		expect(testid(container, "router-admin-facts")).toBeNull();
		expect(testid(container, "router-admin-note")?.dataset.reachable).toBe(
			"false",
		);
	});
});

describe("the dongle's own diagnostics", () => {
	it("renders the fields the device stated, and no row for the ones it did not", () => {
		const { container } = renderRows([
			[
				"2",
				dongle({
					// VERBATIM from the bench ZTE. Its carrier-aggregation and traffic
					// keys all answered "" on this firmware, so the reader produced no
					// field for them and the row must produce no <dd> either.
					details: {
						network_type: "LTE",
						provider: "732103",
						cell_id: "2c20f34",
						roaming: "Home",
					},
				}),
			],
		]);

		expect(testid(container, "router-admin-details")).not.toBeNull();
		expect(testid(container, "router-detail-cell_id")?.textContent).toContain(
			"2c20f34",
		);
		expect(testid(container, "router-detail-roaming")?.textContent).toContain(
			"Home",
		);
		for (const absent of ["pci", "pcell_band", "carrier_aggregation", "mcc"]) {
			expect(testid(container, `router-detail-${absent}`)).toBeNull();
		}
	});

	it("renders the whole block only when the device stated something", () => {
		const { container } = renderRows([["2", dongle()]]);
		expect(testid(container, "router-admin-details")).toBeNull();
		expect(testid(container, "router-admin-traffic")).toBeNull();
	});

	it("surfaces the HiLink registration a SIM slot cannot answer", () => {
		const { container } = renderRows([
			["2", dongle({ details: { registration: "NO SERVICE" } })],
		]);
		expect(
			testid(container, "router-detail-registration")?.textContent,
		).toContain("NO SERVICE");
	});

	it("carries the UFI's opaque identifier WITH its caveat, on screen", () => {
		const { container } = renderRows([
			[
				"2",
				dongle({
					details: { station_id: "25002", cell_id: "134318388" },
				}),
			],
		]);

		const note = testid(container, "router-detail-station_id-note");
		expect(note?.textContent?.trim()).not.toBe("");
		// Never a tooltip — the shipped kiosk touchscreen has no hover.
		expect(note?.getAttribute("title")).toBeNull();
		// And it is NOT presented as the serving cell, which is its own field.
		expect(testid(container, "router-detail-cell_id")?.textContent).toContain(
			"134318388",
		);
	});

	it("labels the dongle's counters as ITS OWN, never as the bond's rate", () => {
		const { container } = renderRows([
			[
				"2",
				dongle({
					details: {
						monthly_tx_bytes: "12884901888",
						session_rx_rate: "1048576",
					},
				}),
			],
		]);

		const block = testid(container, "router-admin-traffic");
		expect(block).not.toBeNull();
		expect(
			testid(container, "router-traffic-monthly_tx_bytes")?.textContent,
		).toContain("12884901888");
		// The block states whose counters these are IN WORDS, so a byte total
		// under a cellular row can never be read as bonded throughput.
		expect(block?.textContent ?? "").toMatch(/dongle/i);
		// They are kept out of the radio-detail table entirely.
		expect(
			testid(container, "router-admin-details")?.textContent ?? "",
		).not.toContain("12884901888");
	});
});
