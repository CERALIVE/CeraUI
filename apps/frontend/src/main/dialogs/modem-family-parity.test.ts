// @vitest-environment jsdom
/**
 * ONE control surface, whichever family the device belongs to (todo 15).
 *
 * Todo 12 built the shared section primitives, todo 14 put the MM dialog on
 * them, and this is the closing gate: for the states the two families genuinely
 * SHARE, an MM-managed radio and a router-mode dongle must render the same
 * sections, in the same order, carrying the same status words — and
 * `RouterDongleDialog` must be reading that shared model rather than a private
 * copy of it that happens to agree today.
 *
 * WHY "equivalent capability states" is the qualifier, and not a weasel. The
 * families do not answer every question the same way and must not be forced to:
 * a dongle's lifecycle badge reports the USB-Ethernet LINK it presents to the
 * board, an MM radio's reports a bearer, and collapsing those two was an
 * explicitly-rejected change (`apps/frontend/AGENTS.md` → "…AND THE BADGE BESIDE
 * IT REPORTS A LINK, NOT A CONNECTION"). What the two DO share is every state
 * that is a fact about the CARD or the RADIO rather than about the transport —
 * an empty slot, an outstanding PIN, a signal tier, a diagnostics table — and in
 * those the operator must not be able to tell which family they are looking at.
 *
 * The one difference asserted as INTENDED is `data-provenance`, which names the
 * INSTRUMENT that took the reading (this board's modem stack vs the device's own
 * admin API). That distinction is the whole reason todo 20 modelled provenance;
 * erasing it here would be the opposite defect.
 */
import { m } from "@ceraui/i18n/svelte";
import type { Modem } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { deriveModemSections } from "$lib/modem/sections";
import SectionsHarness from "$lib/modem/sections/__fixtures__/SectionsHarness.svelte";

import RouterDongleDialog from "./RouterDongleDialog.svelte";

vi.mock("$lib/rpc", () => ({
	rpc: { modems: { setRouterControl: vi.fn(), setRouterNetMode: vi.fn() } },
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
});

/**
 * The status words a card is allowed to be compared on.
 *
 * `data-provenance` is deliberately ABSENT: it names the instrument, and the two
 * families legitimately read their radios with different ones.
 */
const STATUS_ATTRIBUTES = [
	"data-identified",
	"data-connection-state",
	"data-tone",
	"data-roaming",
	"data-sim-presence",
	"data-sim-lock",
	"data-signal-tier",
	"data-stale",
	"data-state",
	"data-reason-key",
	"data-capability-state",
] as const;

/** Every rendered section, keyed by its test-id with the family prefix removed. */
function vocabulary(root: ParentNode, prefix: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const element of root.querySelectorAll<HTMLElement>("[data-testid]")) {
		const testid = element.dataset.testid ?? "";
		if (!testid.startsWith(prefix)) continue;
		const status = STATUS_ATTRIBUTES.filter((name) =>
			element.hasAttribute(name),
		).map((name) => `${name}=${element.getAttribute(name)}`);
		found.set(testid.slice(prefix.length), status.join(" "));
	}
	return found;
}

/** An MM-managed radio. Nothing here is transport-specific but `device_class`. */
function managed(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM520N-GL",
		device_class: "usb",
		...overrides,
	} as unknown as Modem;
}

/**
 * A router-mode dongle in the SAME state.
 *
 * `controls` is present on purpose: without a proven write the row carries a
 * Configure refusal the MM fixture has no counterpart for, and that note is a
 * real difference between the two devices rather than a vocabulary one.
 */
function router(
	overrides: Partial<Modem> = {},
	admin: Record<string, unknown> = {},
): Modem {
	return {
		ifname: "enx0c5b8f279a64",
		name: "Huawei E3372",
		device_class: "router-ethernet",
		...overrides,
		router_admin: {
			admin_url: "http://192.168.8.1",
			reachable: true,
			// The unit's OWN identifiers. They ride the dialog's `dongle-unit-*`
			// table rather than `dongle-identity-*`, and populating them here is
			// what proves the two prefixes really are separable.
			model: "E3372",
			serial: "8CA1B2C3D4E5",
			controls: { mobile_data: true, roaming_autoconnect: false },
			...admin,
		},
	} as unknown as Modem;
}

/** A live 2-of-5-bar reading — the same `medium` tier `signal: 55` resolves to. */
const MEDIUM_ADMIN_SIGNAL = {
	provenance: "hilink-admin-api" as const,
	freshness: "live" as const,
	bars: { state: "known" as const, value: 2 },
	max_bars: { state: "known" as const, value: 5 },
	dbm: { state: "unknown" as const, reason: "unsupported" as const },
	rsrp: { state: "unknown" as const, reason: "unsupported" as const },
	rsrq: { state: "unknown" as const, reason: "unsupported" as const },
	snr: { state: "unknown" as const, reason: "unsupported" as const },
	sinr: { state: "unknown" as const, reason: "unsupported" as const },
};

const PAIRS: ReadonlyArray<readonly [string, Modem, Modem]> = [
	[
		"an empty SIM slot",
		managed({ no_sim: true } as Partial<Modem>),
		router({ no_sim: true } as Partial<Modem>, { sim: "absent" }),
	],
	[
		"an outstanding PIN over a readable radio",
		managed({
			no_sim: false,
			sim_lock: { required: "sim-pin" },
			status: { connection: "registered", signal: 55, network: "Claro" },
		} as unknown as Partial<Modem>),
		router(
			{
				no_sim: false,
				sim_lock: { required: "sim-pin" },
				sim_network: "Claro",
			} as unknown as Partial<Modem>,
			{ sim: "present", signal: MEDIUM_ADMIN_SIGNAL },
		),
	],
];

function mountHarness(modem: Modem): HTMLElement {
	const { container } = render(SectionsHarness, {
		props: { sections: deriveModemSections({ modem }) },
	});
	return container;
}

describe("the two modem families render ONE section set", () => {
	for (const [label, mmModem, routerModem] of PAIRS) {
		it(`emits the same sections for ${label}`, () => {
			const mm = vocabulary(mountHarness(mmModem), "modem-");
			const dongle = vocabulary(mountHarness(routerModem), "modem-");

			// STRUCTURE: the same sections exist, so neither family gets a poorer
			// card than the other for a state they both reached.
			expect([...dongle.keys()].sort()).toStrictEqual([...mm.keys()].sort());
			// …and the set is not trivially small, or the assertion above proves
			// nothing about a card that rendered almost nothing.
			expect(mm.size).toBeGreaterThan(6);
		});

		it(`says the same status words for ${label}`, () => {
			const mm = vocabulary(mountHarness(mmModem), "modem-");
			const dongle = vocabulary(mountHarness(routerModem), "modem-");

			expect(Object.fromEntries(dongle)).toStrictEqual(Object.fromEntries(mm));
		});
	}

	it("keeps the ONE difference that is a fact rather than a vocabulary", () => {
		const [, mmModem, routerModem] = PAIRS[1] as readonly [
			string,
			Modem,
			Modem,
		];
		const reading = (modem: Modem): HTMLElement | null =>
			mountHarness(modem).querySelector<HTMLElement>(
				'[data-testid="modem-signal-reading"]',
			);

		// The same tier, from two different instruments — and the model says which.
		expect(reading(mmModem)?.dataset.signalTier).toBe("medium");
		expect(reading(routerModem)?.dataset.signalTier).toBe("medium");
		expect(reading(mmModem)?.dataset.provenance).toBe("device-stack");
		expect(reading(routerModem)?.dataset.provenance).toBe("device-admin");
	});

	it("explains HOW each device is reached without leaking its transport token", () => {
		const mm = mountHarness(managed());
		const dongle = mountHarness(router());
		const hint = (root: ParentNode): string =>
			root
				.querySelector('[data-testid="modem-identity-class-hint"]')
				?.textContent?.trim() ?? "";

		// A genuinely different fact, so the two sentences differ…
		expect(hint(mm)).not.toBe(hint(dongle));
		// …and neither is the wire token, nor a dotted key that failed to resolve.
		for (const text of [hint(mm), hint(dongle)]) {
			expect(text.length).toBeGreaterThan(0);
			expect(text).not.toMatch(/network\./);
			expect(text).not.toContain("router-ethernet");
			expect(text).not.toContain("mm-managed");
		}
	});
});

describe("RouterDongleDialog renders THAT set, not a private copy of it", () => {
	/**
	 * The four shared blocks, by the stem both surfaces give them.
	 *
	 * The dialog prefixes them `dongle-` and the harness `modem-`; `vocabulary`
	 * strips whichever it was given, so what is left must match exactly. A block
	 * the dialog re-implemented would differ in a node or in a status word here,
	 * and one it merely omitted would fail the non-empty check below.
	 */
	const SHARED_STEMS = ["identity", "connection", "signal", "sim"] as const;

	const rowsFor = (
		found: Map<string, string>,
		stem: string,
	): ReadonlyArray<readonly [string, string]> =>
		[...found.entries()].filter(
			([key]) => key === stem || key.startsWith(`${stem}-`),
		);

	for (const [label, , routerModem] of PAIRS) {
		it(`matches the shared card for ${label}`, () => {
			const shared = vocabulary(mountHarness(routerModem), "modem-");
			const { container } = render(RouterDongleDialog, {
				props: { open: true, deviceId: "router-1", modem: routerModem },
			});
			const dialog = vocabulary(container.ownerDocument.body, "dongle-");

			for (const stem of SHARED_STEMS) {
				const sharedRows = rowsFor(shared, stem);
				expect(sharedRows.length).toBeGreaterThan(0);
				expect(
					rowsFor(dialog, stem),
					`${label}: the dialog's ${stem} block must mirror the shared one`,
				).toStrictEqual(sharedRows);
			}
		});
	}
});

describe("a mode the firmware did not NAME never reaches the operator as its id", () => {
	/** Two unnamed modes, so the positional labels have to disambiguate. */
	const UNNAMED_CATALOG = {
		capabilities: {
			net_mode: {
				state: "reported" as const,
				modes: [{ id: "auto-any" }, { id: "lte-only" }],
				current: "lte-only",
			},
		},
	};

	function mountUnnamed(): void {
		render(RouterDongleDialog, {
			props: {
				open: true,
				deviceId: "router-1",
				modem: router({}, UNNAMED_CATALOG),
			},
		});
	}

	/** Everything an operator reads, with every marked diagnostics block removed. */
	function operatorText(): string {
		const root = document.body.cloneNode(true) as HTMLElement;
		for (const node of root.querySelectorAll('[data-testid*="diagnostic"]')) {
			node.remove();
		}
		return root.textContent ?? "";
	}

	it("labels an unnamed mode positionally, and marks it as unnamed", () => {
		mountUnnamed();

		const first = document.querySelector<HTMLElement>(
			'[data-testid="dongle-net-mode-auto-any"]',
		);
		const second = document.querySelector<HTMLElement>(
			'[data-testid="dongle-net-mode-lte-only"]',
		);

		expect(first?.dataset.named).toBe("false");
		expect(second?.dataset.named).toBe("false");
		expect(first?.textContent?.trim()).toBe(
			m["network.routerCellular.netMode.unnamed"]({ index: "1" }),
		);
		// The two are distinguishable, which a shared generic label would not be.
		expect(first?.textContent?.trim()).not.toBe(second?.textContent?.trim());
	});

	it("keeps every raw catalog id out of operator-facing text", () => {
		mountUnnamed();

		expect(operatorText()).not.toContain("lte-only");
		expect(operatorText()).not.toContain("auto-any");
	});

	// The grep this effort's acceptance names, run against the rendered DOM: no
	// `mode.id`-shaped token — a lowercase dashed identifier — anywhere in the
	// section that offers the control. Restoring the `mode.name ?? mode.id`
	// fallback puts `lte-only` straight into a chip and reddens this.
	it("leaves no dashed identifier in the net-mode section at all", () => {
		mountUnnamed();

		const section = document.querySelector('[data-testid="dongle-net-mode"]');
		expect(section).not.toBeNull();
		expect(section?.textContent ?? "").not.toMatch(
			/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/,
		);
	});

	it("still renders every one of them, verbatim, inside the marked block", () => {
		mountUnnamed();

		const catalog = document.querySelector(
			'[data-testid="dongle-detail-net_mode_catalog"]',
		);
		expect(catalog?.textContent).toContain("auto-any");
		expect(catalog?.textContent).toContain("lte-only");
		expect(
			document
				.querySelector('[data-testid="dongle-detail-net_mode_current"]')
				?.textContent?.trim(),
		).toBe("lte-only");
	});

	it("leaves a NAMED catalog reading exactly as the firmware wrote it", () => {
		render(RouterDongleDialog, {
			props: {
				open: true,
				deviceId: "router-1",
				modem: router(
					{},
					{
						capabilities: {
							net_mode: {
								state: "reported" as const,
								modes: [
									{ id: "00", name: "AUTO" },
									{ id: "03", name: "LTE" },
								],
								current: "03",
							},
						},
					},
				),
			},
		});

		const named = document.querySelector<HTMLElement>(
			'[data-testid="dongle-net-mode-00"]',
		);
		expect(named?.dataset.named).toBe("true");
		expect(named?.textContent?.trim()).toBe("AUTO");
	});
});
