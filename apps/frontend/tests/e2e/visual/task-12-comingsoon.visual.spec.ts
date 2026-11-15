import { expect, test } from "../fixtures/index.js";
import { evidencePath } from "../helpers/index.js";
import { LivePage } from "../pages/live.js";

/**
 * Task 12 — Ground Control "coming soon" affordances.
 *
 * Proves, against the REAL frontend + mock backend, that the Live destination
 * surfaces calm, informational roadmap pills (mode-level fallback) bound to OPEN
 * technical-debt entries via data-debt-id, and none for the resolved PiP entry.
 * Captures the roadmap cluster as repo-local evidence.
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

			// The roadmap pills live inside a `<details>` disclosure (T10/T12), closed
			// by default — open it (click its <summary>) before asserting visibility.
			await roadmap.locator("summary").click();

			// The open roadmap item exposes its register binding. TD-pip is resolved
			// (composition ships as the feature-gated CompositionCard), so a pill for
			// it would tell operators a shipped feature is still coming.
			await expect(
				roadmap.locator('[data-debt-id="TD-mode-fallback"]'),
			).toBeVisible();
			await expect(roadmap.locator('[data-debt-id="TD-pip"]')).toHaveCount(0);

			await roadmap.screenshot({
				path: evidencePath("task-12-pip-comingsoon.png"),
			});
		},
	);
});
