import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { closeDialog } from "./helpers/aria.js";
import { navigateTo } from "./helpers/index.js";

/**
 * The config dialogs are lazy chunks, and this proves it against a real browser
 * rather than against a manifest.
 *
 * Two claims, both of which a regression would silently break:
 *  1. A dialog's module is NOT fetched while its destination merely renders — if
 *     a static import creeps back in, the module rides the entry chunk and the
 *     pre-open count stops being zero.
 *  2. It is fetched exactly ONCE. The registry caches the resolved component, so
 *     a second open costs no network. An inline `{#await import(...)}` at the
 *     mount site would re-evaluate and break this.
 *
 * The URL match is deliberately a bare module-name substring so it holds in BOTH
 * modes the suite runs in: `/src/main/dialogs/VersionsDialog.svelte` under the
 * local dev server, `/assets/VersionsDialog-<hash>.js` under the CI production
 * preview.
 *
 * Device Versions is the subject because it is read-only — opening and closing it
 * twice mutates nothing on the mock backend.
 */

const DIALOG_MODULE = "VersionsDialog";
const DIALOG_NAME = "Device Versions";
const DIALOG_TRIGGER = /Device Versions/i;

function trackModuleRequests(page: Page, moduleName: string): () => number {
	const urls: string[] = [];
	page.on("request", (request) => {
		const url = request.url();
		if (url.includes(moduleName)) urls.push(url);
	});
	return () => urls.length;
}

test.describe("lazy dialog chunks", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"chunk loading is layout-independent; one project is enough",
		);
		void page;
	});

	test("a dialog chunk is fetched on first open and cached on the second", async ({
		authedPage: page,
	}) => {
		const moduleRequests = trackModuleRequests(page, DIALOG_MODULE);

		await navigateTo(page, "settings");
		await expect(
			page.getByRole("button", { name: DIALOG_TRIGGER }).first(),
		).toBeVisible();

		// The destination is fully rendered and the dialog's code has not been
		// fetched: it is genuinely off the initial route.
		expect(moduleRequests()).toBe(0);

		await page.getByRole("button", { name: DIALOG_TRIGGER }).first().click();
		await expect(page.getByRole("dialog", { name: DIALOG_NAME })).toBeVisible();

		await expect
			.poll(moduleRequests, {
				message: `${DIALOG_MODULE} should be fetched on first open`,
			})
			.toBeGreaterThan(0);
		const afterFirstOpen = moduleRequests();

		await closeDialog(page, DIALOG_NAME);
		await expect(
			page.getByRole("dialog", { name: DIALOG_NAME }),
		).toBeHidden();

		await page.getByRole("button", { name: DIALOG_TRIGGER }).first().click();
		await expect(page.getByRole("dialog", { name: DIALOG_NAME })).toBeVisible();

		// Same dialog, same content, no second fetch.
		expect(moduleRequests()).toBe(afterFirstOpen);

		await closeDialog(page, DIALOG_NAME);
	});
});
