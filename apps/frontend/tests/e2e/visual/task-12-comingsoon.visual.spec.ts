import { expect, test } from "../fixtures/index.js";
import { evidencePath } from "../helpers/index.js";
import { LivePage } from "../pages/live.js";

/**
 * Task 12 — Ground Control "coming soon" affordances.
 *
 * Proves, against the REAL frontend + mock backend, that the Live destination
 * surfaces calm, informational roadmap pills (PiP + mode-level fallback) bound to
 * OPEN technical-debt entries via data-debt-id. Captures the roadmap cluster as
 * repo-local evidence.
 */
test.describe("@visual Task 12 — coming-soon affordances", () => {
	test(
		"@visual roadmap pills bind to data-debt-id",
		{ tag: "@visual" },
		async ({ authedPage: page }, testInfo) => {
			test.skip(testInfo.project.name !== "desktop", "single-layout visual proof");

			const live = new LivePage(page);
			await live.open();

			const roadmap = page.getByTestId("live-roadmap");
			await expect(roadmap).toBeVisible({ timeout: 20_000 });
			await roadmap.scrollIntoViewIfNeeded();

			// Both roadmap items expose their OPEN register binding.
			await expect(roadmap.locator('[data-debt-id="TD-pip"]')).toBeVisible();
			await expect(
				roadmap.locator('[data-debt-id="TD-mode-fallback"]'),
			).toBeVisible();

			await roadmap.screenshot({
				path: evidencePath("task-12-pip-comingsoon.png"),
			});
		},
	);
});
