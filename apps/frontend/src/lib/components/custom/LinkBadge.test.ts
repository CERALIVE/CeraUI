// @vitest-environment jsdom
/**
 * LinkBadge — the ONE compact "link N, named X, of kind Y, reading Z" badge.
 *
 * The Bonded Links row and the HUD strip each carried their own copy of the
 * ordinal chip, the identity colour and the indicator call, so the two could
 * drift about which glyph a link gets — and they did. These legs pin what the
 * two variants share and, just as importantly, what they must not.
 */

import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import type { LinkSignal } from "$lib/types/hud";

import LinkBadge from "./LinkBadge.svelte";

function link(overrides: Partial<LinkSignal> = {}): LinkSignal {
	return {
		id: "wwan0",
		type: "modem",
		linkIndex: 1,
		signal: 80,
		label: "ZTE MF79U",
		isConnected: true,
		isStale: false,
		throughputKbps: 0,
		rateTxKbps: null,
		rateRxKbps: null,
		enabled: true,
		connectionState: "connected",
		...overrides,
	};
}

describe("LinkBadge", () => {
	it("prints the 1-based ordinal in that link's identity colour", () => {
		const { getByTestId } = render(LinkBadge, { props: { link: link() } });
		const ordinal = getByTestId("link-badge-ordinal");
		expect(ordinal.textContent?.trim()).toBe("L2");
		expect(ordinal.getAttribute("style")).toContain("var(--link-2)");
	});

	it("row variant carries the name and the kind label", () => {
		const { getByTestId, container } = render(LinkBadge, {
			props: { link: link(), typeLabel: "LTE" },
		});
		expect(getByTestId("link-badge-label").textContent?.trim()).toBe(
			"ZTE MF79U",
		);
		expect(container.textContent).toContain("LTE");
	});

	it("row variant renders the twin discriminator only when given one", () => {
		const without = render(LinkBadge, {
			props: { link: link(), typeLabel: "LTE" },
		});
		expect(without.queryByTestId("bonded-link-identity")).toBeNull();

		const withIdentity = render(LinkBadge, {
			props: { link: link(), typeLabel: "LTE", identity: "eth1 · USB 0-1.3.2" },
		});
		expect(
			withIdentity.getByTestId("bonded-link-identity").textContent,
		).toContain("eth1");
	});

	it("compact variant stays at TWO facts — the HUD strip's scope is deliberate", () => {
		// The persistent strip carries exactly four facts by product decision
		// (root AGENTS.md → HUD 4-fact scope). A name or a kind label here would
		// smuggle a fifth in, so their absence is a contract, not an oversight.
		const { queryByTestId, container } = render(LinkBadge, {
			props: { link: link(), variant: "compact", typeLabel: "LTE" },
		});
		expect(queryByTestId("link-badge-label")).toBeNull();
		expect(container.textContent).not.toContain("LTE");
		expect(container.textContent).not.toContain("ZTE MF79U");
	});

	it("draws the same bar cluster for a percentage and for a tier", () => {
		const percentage = render(LinkBadge, {
			props: { link: link({ signal: 80 }) },
		});
		const tier = render(LinkBadge, {
			props: {
				link: link({
					signal: null,
					signalTier: "high",
					connectionState: "disconnected",
				}),
			},
		});

		const filled = (c: HTMLElement) =>
			c.querySelectorAll('[data-bar="filled"]').length;
		const total = (c: HTMLElement) => c.querySelectorAll("[data-bar]").length;

		expect(total(percentage.container)).toBe(3);
		expect(total(tier.container)).toBe(3);
		expect(filled(tier.container)).toBe(filled(percentage.container));
	});

	it("passes the tier through in BOTH variants", () => {
		for (const variant of ["row", "compact"] as const) {
			const { container } = render(LinkBadge, {
				props: {
					link: link({
						signal: null,
						signalTier: "low",
						connectionState: "disconnected",
					}),
					variant,
				},
			});
			expect(
				container.querySelectorAll('[data-bar="filled"]').length,
				`${variant} must render the tier`,
			).toBe(1);
		}
	});
});
