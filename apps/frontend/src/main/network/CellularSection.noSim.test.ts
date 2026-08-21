// @vitest-environment jsdom
/**
 * ONE "No SIM" TAG, ACROSS EVERY CLASS OF CELLULAR DEVICE.
 *
 * The same physical condition used to render three different ways: a
 * directly-managed modem collapsed it into its lifecycle badge, a router-mode
 * dongle drew it inside the router-signal chip, and the config dialog banner led
 * with a third glyph. An operator comparing a SIM-less modem against a SIM-less
 * dongle on one screen saw two colours, two icons and two words for one fact.
 *
 * The assertions below compare the RENDERED OUTPUT of the two classes against
 * each other rather than against a class name — a CSS or icon regression walks
 * straight through a class-name assertion, and "identical" is precisely the
 * property that has to hold.
 */
import type { Modem, NetifMessage } from "@ceraui/rpc/schemas";
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

/** A directly-managed radio: ModemManager reports the empty slot as `no_sim`. */
function directModem(): Modem {
	return {
		ifname: "wwan0",
		name: "SIMCOM_SIM7600G-H - 15136",
		network_type: { supported: ["4G"], active: null },
		device_class: "usb",
		no_sim: true,
	} as Modem;
}

/** A router-mode dongle: the SAME fact, reported by its OWN admin API. */
function routerDongle(): Modem {
	return {
		ifname: "enx344b50000000",
		name: "ZTE MF79U",
		network_type: { supported: [], active: null },
		device_class: "router-ethernet",
		availability_reason: "router_direct",
		router_admin: {
			admin_url: "http://192.168.0.1",
			reachable: true,
			sim: "absent",
			connection: "disconnected",
		},
	} as Modem;
}

const NETIF: NetifMessage = {
	wwan0: { tp: 0, enabled: false },
	enx344b50000000: { tp: 12, enabled: true, ip: "192.168.0.169" },
};

function renderBoth() {
	return render(CellularSection, {
		props: {
			modemEntries: [
				["0", directModem()],
				["1000", routerDongle()],
			],
			netif: NETIF,
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConfigure: vi.fn(),
		},
	});
}

function rowFor(container: HTMLElement, ifname: string): HTMLElement {
	const row = container.querySelector<HTMLElement>(
		`[data-testid="modem-row"][data-ifname="${ifname}"]`,
	);
	if (!row) throw new Error(`no row for ${ifname}`);
	return row;
}

function noSimTag(row: HTMLElement): HTMLElement {
	const tag = row.querySelector<HTMLElement>('[data-no-sim="true"]');
	if (!tag) throw new Error("no No-SIM tag on this row");
	return tag;
}

describe("the No-SIM tag is one component, on both modem classes", () => {
	it("renders on a directly-managed modem AND on a router dongle", () => {
		const { container } = renderBoth();

		expect(noSimTag(rowFor(container, "wwan0"))).toBeTruthy();
		expect(noSimTag(rowFor(container, "enx344b50000000"))).toBeTruthy();
	});

	it("carries the same WORD on both", () => {
		const { container } = renderBoth();
		const direct = noSimTag(rowFor(container, "wwan0"));
		const router = noSimTag(rowFor(container, "enx344b50000000"));

		expect(direct.textContent?.trim()).toBe("No SIM");
		expect(router.textContent?.trim()).toBe(direct.textContent?.trim());
	});

	// Colour is carried by the shared `Badge` variant, which is what
	// `data-status-badge` reports — so this compares the resolved semantic tone
	// rather than a Tailwind class string a refactor could rename.
	it("carries the same COLOUR on both", () => {
		const { container } = renderBoth();
		const direct = noSimTag(rowFor(container, "wwan0"));
		const router = noSimTag(rowFor(container, "enx344b50000000"));

		expect(direct.getAttribute("data-status-badge")).toBe("warning");
		expect(router.getAttribute("data-status-badge")).toBe(
			direct.getAttribute("data-status-badge"),
		);
	});

	// Compared as GEOMETRY, not as a class or a component name: two different
	// Lucide glyphs are two different path sets, and that is the only comparison
	// an icon swap cannot pass.
	it("draws the same GLYPH on both", () => {
		const { container } = renderBoth();
		const direct = noSimTag(rowFor(container, "wwan0")).querySelector("svg");
		const router = noSimTag(rowFor(container, "enx344b50000000")).querySelector(
			"svg",
		);

		expect(direct).not.toBeNull();
		expect(router?.innerHTML).toBe(direct?.innerHTML);
	});

	it("renders exactly ONE tag per row — never a second, differently-worded one", () => {
		const { container } = renderBoth();

		for (const ifname of ["wwan0", "enx344b50000000"]) {
			expect(
				rowFor(container, ifname).querySelectorAll('[data-no-sim="true"]'),
			).toHaveLength(1);
		}
	});

	// Found by visual QA on the board, not by a unit test: the dongle drew the
	// shared amber pill AND the muted router-signal chip, which reports `no-sim`
	// with its own icon and its own colour. Two marks, one fact, one row.
	it("suppresses the router-signal chip that says the same thing", () => {
		const { container } = renderBoth();
		const row = rowFor(container, "enx344b50000000");

		expect(row.querySelector('[data-testid="modem-router-signal"]')).toBeNull();
		expect(
			[...row.querySelectorAll("*")].filter(
				(el) => el.children.length === 0 && el.textContent?.trim() === "No SIM",
			),
		).toHaveLength(1);
	});

	// The negative control — that a dongle WITH a card keeps its chip — lives in
	// `CellularSection.routerSignal.test.ts`, which owns the chip's render rules
	// and has the fixture helpers for a full signal model.
});

describe("unifying the TAG did not flatten the two classes", () => {
	// The dongle's lifecycle badge is deliberately NOT overwritten: `router_direct`
	// means the host really does hold a routable address, and collapsing that into
	// "No SIM" would lose a true fact. The modem's collapse is pre-existing and
	// equally deliberate. So the tag is shared and its PLACEMENT is not.
	it("keeps the dongle's truthful lifecycle badge beside its tag", () => {
		const { container } = renderBoth();
		const row = rowFor(container, "enx344b50000000");

		expect(row.getAttribute("data-modem-state")).toBe("router-up");
		expect(
			row.querySelector('[data-testid="modem-state-badge"]')?.textContent,
		).not.toContain("No SIM");
	});

	it("keeps the modem's no-SIM lifecycle state, now drawn by the shared tag", () => {
		const { container } = renderBoth();
		const row = rowFor(container, "wwan0");
		const stateBadge = row.querySelector<HTMLElement>(
			'[data-testid="modem-state-badge"]',
		);

		expect(row.getAttribute("data-modem-state")).toBe("no-sim");
		expect(stateBadge?.getAttribute("data-no-sim")).toBe("true");
	});

	it("keeps the dongle's own explanatory copy", () => {
		const { container } = renderBoth();
		expect(container.textContent).toContain("its own web interface");
	});

	it("draws no tag at all on a modem that holds a SIM", () => {
		const { container } = render(CellularSection, {
			props: {
				modemEntries: [
					[
						"0",
						{
							...directModem(),
							no_sim: false,
							status: { connection: "connected", signal: 70 },
						} as Modem,
					],
				],
				netif: NETIF,
				isFullyStale: false,
				staleInterfaces: new Set<string>(),
				onConfigure: vi.fn(),
			},
		});

		expect(container.querySelector('[data-no-sim="true"]')).toBeNull();
	});
});
