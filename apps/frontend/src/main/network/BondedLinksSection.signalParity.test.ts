// @vitest-environment jsdom
/**
 * BondedLinksSection — one glyph for "how is this link's radio", whichever kind
 * of modem is in the port.
 *
 * A NetworkManager-managed modem publishes a percentage; a self-managed router
 * dongle publishes only its own admin API's tier. The bond used to render the
 * first as a spectral bar cluster and the second as the indicator's bare
 * "nothing was reported" fallback — two treatments for one question, side by
 * side in one list, which is exactly what an operator reported.
 *
 * These legs read the RENDERED DOM rather than the props, because the defect
 * lived in what the row drew, not in what it was handed.
 */

import { render, within } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import type { LinkSignal } from "$lib/types/hud";

import BondedLinksSection from "./BondedLinksSection.svelte";

function managedModem(): LinkSignal {
	return {
		id: "wwan0",
		type: "modem",
		linkIndex: 0,
		signal: 80,
		signalTier: undefined,
		label: "Quectel RM520N",
		isConnected: true,
		isStale: false,
		throughputKbps: 4000,
		rateTxKbps: null,
		rateRxKbps: null,
		enabled: true,
		connectionState: "connected",
	};
}

/**
 * A `router-ethernet` dongle as `buildBond` now emits it: no percentage — it has
 * no ModemManager status block — and its own published tier instead.
 */
function selfManagedDongle(overrides: Partial<LinkSignal> = {}): LinkSignal {
	return {
		id: "enx344b50000000",
		type: "modem",
		linkIndex: 1,
		signal: null,
		signalTier: "high",
		label: "ZTE MF79U",
		isConnected: true,
		isStale: false,
		throughputKbps: 1200,
		rateTxKbps: null,
		rateRxKbps: null,
		enabled: true,
		connectionState: "disconnected",
		...overrides,
	};
}

function cardFor(container: HTMLElement, id: string): HTMLElement {
	const card = container.querySelector<HTMLElement>(
		`[data-testid="bonded-link-card"][data-link-id="${id}"]`,
	);
	expect(card, `no bonded card for ${id}`).not.toBeNull();
	return card as HTMLElement;
}

/**
 * The bar cluster's own marker. `data-bar` is colour-independent on purpose:
 * filled-ness is painted from a `--link-{n}` custom property, which resolves to
 * the same string before and after a regression.
 */
function bars(card: HTMLElement): { filled: number; total: number } {
	return {
		filled: card.querySelectorAll('[data-bar="filled"]').length,
		total: card.querySelectorAll("[data-bar]").length,
	};
}

describe("BondedLinksSection — managed and self-managed draw the SAME glyph", () => {
	it("renders one bar cluster per modem row, whichever instrument reported", () => {
		const { container } = render(BondedLinksSection, {
			props: {
				links: [managedModem(), selfManagedDongle()],
				modemEntries: [],
			},
		});

		const managed = bars(cardFor(container, "wwan0"));
		const dongle = bars(cardFor(container, "enx344b50000000"));

		expect(managed.total).toBe(3);
		expect(dongle.total).toBe(3);
		// 80% and a `high` tier are both the top bucket, so the two rows are
		// pixel-for-pixel the same instrument — which is the whole ask.
		expect(managed.filled).toBe(3);
		expect(dongle.filled).toBe(3);
	});

	it("still distinguishes a weak dongle from a strong one", () => {
		const { container } = render(BondedLinksSection, {
			props: {
				links: [
					selfManagedDongle(),
					selfManagedDongle({
						id: "enx020754023235",
						linkIndex: 2,
						label: "Qualcomm 9024",
						signalTier: "low",
					}),
				],
				modemEntries: [],
			},
		});

		expect(bars(cardFor(container, "enx344b50000000")).filled).toBe(3);
		expect(bars(cardFor(container, "enx020754023235")).filled).toBe(1);
	});

	it("names the tier in WORDS, never by colour and bar count alone", () => {
		const { container } = render(BondedLinksSection, {
			props: { links: [selfManagedDongle()], modemEntries: [] },
		});

		const card = cardFor(container, "enx344b50000000");
		const tier = within(card).getByTestId("bonded-link-signal-tier");
		expect(tier.getAttribute("data-signal-tier")).toBe("high");
		expect(tier.textContent?.trim()).not.toBe("");
		// …and it is never a raw dotted i18n key.
		expect(tier.textContent?.trim()).not.toMatch(/^network\./);
	});

	it("shows a PERCENTAGE only where one was actually measured", () => {
		const { container } = render(BondedLinksSection, {
			props: {
				links: [managedModem(), selfManagedDongle()],
				modemEntries: [],
			},
		});

		expect(cardFor(container, "wwan0").textContent).toContain("80%");
		// The dongle publishes a tier, so no figure is invented for it.
		expect(cardFor(container, "enx344b50000000").textContent).not.toMatch(
			/\d%/,
		);
	});

	it("keeps the bare fallback when NOTHING was reported at all", () => {
		// An unreachable dongle carries no tier, so the row must NOT draw a
		// cluster — bars there would report a reading nobody took. This is the
		// non-vacuity control for every leg above.
		const { container } = render(BondedLinksSection, {
			props: {
				links: [selfManagedDongle({ signalTier: undefined })],
				modemEntries: [],
			},
		});

		expect(bars(cardFor(container, "enx344b50000000")).total).toBe(0);
	});

	it("keeps the empty-slot glyph for a SIM-less modem", () => {
		const { container } = render(BondedLinksSection, {
			props: {
				links: [
					selfManagedDongle({
						connectionState: "no_sim",
						signalTier: undefined,
					}),
				],
				modemEntries: [],
			},
		});

		expect(bars(cardFor(container, "enx344b50000000")).total).toBe(0);
	});
});
