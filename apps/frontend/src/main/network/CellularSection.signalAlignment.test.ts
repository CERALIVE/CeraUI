// @vitest-environment jsdom
/**
 * CellularSection — the signal indicators sit in ONE column.
 *
 * The operator report was "some are moved to the left, some others to the
 * right". Measured live on the bench board at 1280x800 AND at the 1024x600
 * kiosk viewport, the seven rows' tier glyphs spanned 13px, from TWO
 * independent causes that this file pins separately:
 *
 *   1. THE BOND WORD. `In Bond` and `Excluded` differ by 7px, and the toggle
 *      printing them sits to the RIGHT of the glyph inside a `shrink-0`
 *      cluster — so the row's bond STATE displaced its radio reading. That is
 *      fixed in `BondToggle` by reserving max(both words); the assertions for
 *      it live in `BondToggle.test.ts`.
 *   2. THE CHIP BOX. The dongle chip insets its bars by its own frame plus
 *      `px-1.5`; the MM glyph's bars WERE its right edge. A further 6px, and
 *      the one that splits the two row SHAPES rather than the two bond states.
 *
 * jsdom computes NO layout, so the pixel proof cannot live here — it is a real
 * `getBoundingClientRect()` gate in
 * `tests/e2e/visual/router-signal.visual.spec.ts` ("every row's signal bars land
 * in ONE column"). What THIS file pins is the mechanism that gate depends on:
 * both indicators declare the same box. Losing that silently is exactly how the
 * 6px came back, so it is asserted as an EQUALITY between the two shapes rather
 * than as a literal class list.
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

function zteSignal(): RouterSignal {
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
	} as RouterSignal;
}

function dongle(ifname: string): Modem {
	return {
		ifname,
		name: "ZTE MF79U",
		network_type: { supported: [], active: null },
		device_class: "router-ethernet",
		availability_reason: "router_direct",
		router_admin: {
			admin_url: "http://192.168.0.1",
			reachable: true,
			sim: "present",
			signal: zteSignal(),
		},
	} as unknown as Modem;
}

function radio(ifname: string): Modem {
	return {
		ifname,
		name: "RM530N-GL - 16855",
		network_type: { supported: ["4g", "5g"], active: "5g" },
		status: { connection: "connected", network: "Claro", signal: 81 },
	} as unknown as Modem;
}

/** `wwan2`/`enx344…` are bonded; `wwan3`/`eth1` are not. */
const NETIF: NetifMessage = {
	wwan2: { tp: 4, enabled: true, ip: "10.171.86.101" },
	wwan3: { tp: 0, enabled: false },
	enx344b50000000: { tp: 0, enabled: true, ip: "192.168.0.169" },
	eth1: { tp: 0, enabled: false },
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

/** The classes that decide where an indicator's bars sit inside its own box. */
const BOX_METRICS = ["rounded-md", "border", "px-1.5", "py-1", "leading-none"];

function indicatorOf(row: Element): HTMLElement {
	const el = row.querySelector<HTMLElement>(
		'[data-testid="modem-signal"], [data-testid="modem-router-signal"]',
	);
	if (el === null) throw new Error("row rendered no signal indicator");
	return el;
}

describe("both signal shapes declare the same box", () => {
	it("gives the managed glyph the dongle chip's own box metrics", () => {
		const { container } = renderRows([
			["1", radio("wwan2")],
			["2", dongle("enx344b50000000")],
		]);
		const rows = container.querySelectorAll('[data-testid="modem-row"]');
		const managed = indicatorOf(rows[0] as Element);
		const router = indicatorOf(rows[1] as Element);

		for (const metric of BOX_METRICS) {
			expect(managed.className, `managed is missing ${metric}`).toContain(
				metric,
			);
			expect(router.className, `router is missing ${metric}`).toContain(metric);
		}
	});

	it("draws the managed frame TRANSPARENT, so provenance stays the dongle's", () => {
		const { container } = renderRows([
			["1", radio("wwan2")],
			["2", dongle("enx344b50000000")],
		]);
		const rows = container.querySelectorAll('[data-testid="modem-row"]');

		// The box is reserved on both; only the dongle ever PAINTS it, and only
		// the dongle carries the `Router` mark. Reserving the frame must not turn
		// a managed radio into something that looks second-hand.
		expect(indicatorOf(rows[0] as Element).className).toContain(
			"border-transparent",
		);
		expect(indicatorOf(rows[0] as Element).className).not.toContain(
			"border-dashed",
		);
		expect(indicatorOf(rows[1] as Element).className).toContain(
			"border-dashed",
		);
		expect(
			indicatorOf(rows[0] as Element).querySelectorAll("svg"),
		).toHaveLength(1);
		expect(
			indicatorOf(rows[1] as Element).querySelectorAll("svg"),
		).toHaveLength(2);
	});

	it("holds the box across every bond state, on both shapes", () => {
		// The bond state is what displaced the glyph in the field report, so the
		// four-row cross-product is the shape of the original defect.
		const { container } = renderRows([
			["1", radio("wwan2")],
			["2", radio("wwan3")],
			["3", dongle("enx344b50000000")],
			["4", dongle("eth1")],
		]);
		const rows = container.querySelectorAll('[data-testid="modem-row"]');
		expect(rows).toHaveLength(4);

		for (const row of rows) {
			const className = indicatorOf(row).className;
			for (const metric of BOX_METRICS) {
				expect(className).toContain(metric);
			}
		}
	});
});
