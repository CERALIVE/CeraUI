import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

test("a late app mount hides the boot failure screen and restores navigation", async ({
	page,
}, testInfo) => {
	test.skip(
		testInfo.project.name !== "desktop",
		"boot recovery is layout-independent; one project is enough",
	);
	test.setTimeout(60_000);

	const release = Promise.withResolvers<void>();
	await page.route("**/*", async (route) => {
		if (route.request().resourceType() === "script") await release.promise;
		await route.continue();
	});

	try {
		await page.goto("/", { waitUntil: "commit" });
		await expect(page.locator("#js-failed")).toBeVisible({ timeout: 15_000 });
	} finally {
		release.resolve();
		// Drain held script handlers before disabling favicon interception.
		await page.unrouteAll({ behavior: "wait" });
	}

	await page.waitForFunction(
		() => "__ceraAppMounted" in window && window.__ceraAppMounted === true,
		undefined,
		{ timeout: 30_000 },
	);
	await expect(page.locator("#js-failed")).toBeHidden();
	// Favicon responses are hidden from Playwright's network events.
	await page.waitForFunction(() =>
		performance.getEntriesByType("resource").some(
			(entry) =>
				entry instanceof PerformanceResourceTiming &&
				new URL(entry.name).pathname === "/favicon.ico" &&
				entry.initiatorType === "fetch" &&
				entry.responseStatus === 200,
		),
	);
	await ensureAuthenticated(page);
	await navigateTo(page, "network");
});
