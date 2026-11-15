import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * The layout designer without the engine's `composition-geometry` token: the
 * default `multi-modem-wifi` scenario advertises no free geometry, so there is
 * no `custom` layout and no designer over the preview. Split from
 * `layout-designer.spec.ts` because the scenario is a worker-scoped option, one
 * per file.
 */
test.describe("layout designer — multi-modem-wifi", () => {
	test("without composition-geometry there is no custom layout and no designer", async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop layout drives the program desk");
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
		await expect(page.getByTestId("program-desk")).toBeVisible();
		await expect(page.getByTestId("composition-layout-custom")).toHaveCount(0);
		await expect(page.getByTestId("layout-inset")).toHaveCount(0);
	});
});
