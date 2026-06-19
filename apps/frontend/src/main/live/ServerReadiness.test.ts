// @vitest-environment jsdom
/**
 * ServerReadiness — bonded-links readiness hint for the Live server surface (T13).
 *
 * Locks the SRTLA-only bonding claim against the three contract states:
 *   1. SRTLA streaming (≥2 links) → "Bonded across N links" + a Manage links
 *      affordance.
 *   2. SRTLA idle (linkCount === null) → transport label only, NO count, NO
 *      bonding claim, NO Manage links.
 *   3. non-SRTLA (rist_*) → never asserts bonding: a fixed single-link line with
 *      an InfoPopover and no Manage links.
 */

import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import ServerReadiness from "./ServerReadiness.svelte";

function hint(container: HTMLElement): HTMLElement {
	const el = container.querySelector<HTMLElement>(
		'[data-testid="server-readiness"]',
	);
	expect(el, "hint must render").not.toBeNull();
	return el as HTMLElement;
}

describe("ServerReadiness — SRTLA-only bonded hint (T13)", () => {
	it("SRTLA streaming asserts 'Bonded across N links' + Manage links", () => {
		const onManageLinks = vi.fn();
		const { container } = render(ServerReadiness, {
			props: { kind: "srtla_custom", linkCount: 3, onManageLinks },
		});
		const el = hint(container);

		expect(el.dataset.readinessVariant).toBe("bonded");
		const bonded = el.querySelector('[data-testid="server-readiness-bonded"]');
		expect(bonded?.textContent).toContain("3");
		expect(bonded?.textContent?.toLowerCase()).toContain("bonded across");
		expect(
			el.querySelector('[data-testid="manage-links"]'),
			"Manage links is offered for the bonded path",
		).not.toBeNull();
	});

	it("SRTLA idle (linkCount === null) shows the label only — no count", () => {
		const { container } = render(ServerReadiness, {
			props: { kind: "srtla_custom", linkCount: null, onManageLinks: vi.fn() },
		});
		const el = hint(container);

		expect(el.dataset.readinessVariant).toBe("idle");
		expect(
			el.querySelector('[data-testid="server-readiness-bonded"]'),
		).toBeNull();
		expect(
			el.querySelector('[data-testid="server-readiness-single"]'),
		).toBeNull();
		expect(el.querySelector('[data-testid="manage-links"]')).toBeNull();
		// No stale digit anywhere in the hint while idle.
		expect(el.textContent ?? "").not.toMatch(/\d/);
	});

	it("non-SRTLA (rist_custom) never claims bonding", () => {
		const { container } = render(ServerReadiness, {
			props: { kind: "rist_custom", linkCount: 4, onManageLinks: vi.fn() },
		});
		const el = hint(container);

		expect(el.dataset.readinessVariant).toBe("fixed");
		expect(
			el.querySelector('[data-testid="server-readiness-bonded"]'),
		).toBeNull();
		expect(
			el.querySelector('[data-testid="server-readiness-fixed"]'),
		).not.toBeNull();
		expect(
			el.querySelector('[data-testid="server-readiness-info"]'),
		).not.toBeNull();
		expect(el.querySelector('[data-testid="manage-links"]')).toBeNull();
		expect(el.textContent?.toLowerCase() ?? "").not.toContain("bonded");
	});
});
