import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/index.js";
import { evidencePath } from "../helpers/index.js";

/**
 * @visual evidence for the per-field sync-state machine (Task 5).
 *
 * Captures the `applying` phase of the shared FieldSyncIndicator — the
 * InlineSpinner an in-flight config write renders — using the DevTools demo
 * surface (no real config field consumes the engine until Wave 2). The demo
 * holds `applying` (no auto-resolve) so the spinner is stable for the shot;
 * the PNG lands in apps/frontend/test-results/ (repo-local, gitignored).
 * Tagged @visual so the screenshot guard in fixtures permits the capture.
 */

async function openDevTools(page: Page): Promise<void> {
	const tab = page.locator("#nav-tab-devtools");
	await tab.click();
	await expect(tab).toHaveAttribute("aria-current", "page");
}

test.describe("@visual field-sync state", () => {
	test.beforeEach(async ({ page: _page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop viewport owns evidence",
		);
	});

	test(
		"applying: InlineSpinner during an in-flight write",
		{ tag: "@visual" },
		async ({ authedPage: page }) => {
			await openDevTools(page);

			const demo = page.getByTestId("field-sync-demo");
			await expect(demo).toBeVisible();

			await page.getByTestId("field-sync-demo-apply").click();

			// The indicator is the InlineSpinner (role="status") with its label.
			const indicator = page.getByTestId("field-sync-demo-indicator");
			await expect(indicator).toHaveAttribute("role", "status");
			await expect(indicator).toContainText("Applying");
			await expect(page.getByTestId("field-sync-demo-state")).toHaveText(
				"applying",
			);

			await demo.screenshot({ path: evidencePath("task-5-applying.png") });
		},
	);
});
