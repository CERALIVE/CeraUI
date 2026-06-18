// @vitest-environment jsdom
import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import ComingSoon from "./ComingSoon.svelte";

// The four register ids Task 12 owns, plus the live-audio-switch id Task 10
// registered: every "coming soon" affordance the overhaul ships must expose its
// data-debt-id so scripts/check-tech-debt.mjs can bind it to an OPEN entry.
const DEBT_IDS = [
	"TD-pip",
	"TD-mode-fallback",
	"TD-live-audio-codec",
	"TD-live-audio-delay",
	"TD-live-audio-switch",
] as const;

describe("ComingSoon — calm roadmap affordance", () => {
	it.each(DEBT_IDS)("exposes data-debt-id=%s on its root", (debtId) => {
		const { container } = render(ComingSoon, { props: { debtId } });
		const el = container.querySelector(`[data-debt-id="${debtId}"]`);
		expect(el).not.toBeNull();
		expect(el?.getAttribute("data-debt-id")).toBe(debtId);
	});

	it("renders the shared 'Coming soon' label", () => {
		const { container } = render(ComingSoon, { props: { debtId: "TD-pip" } });
		expect(container.textContent?.toLowerCase()).toContain("coming soon");
	});

	it("is informational, not an interactive control (no button, no link)", () => {
		const { container } = render(ComingSoon, { props: { debtId: "TD-pip" } });
		const el = container.querySelector('[data-debt-id="TD-pip"]');
		expect(el).not.toBeNull();
		expect(el?.tagName.toLowerCase()).toBe("span");
		expect(el?.querySelector("button")).toBeNull();
		expect(el?.querySelector("a")).toBeNull();
	});

	it("describes the roadmap in its accessible name", () => {
		const { container } = render(ComingSoon, { props: { debtId: "TD-pip" } });
		const el = container.querySelector('[data-debt-id="TD-pip"]');
		expect(el?.getAttribute("aria-label")?.toLowerCase()).toContain(
			"future update",
		);
	});
});
