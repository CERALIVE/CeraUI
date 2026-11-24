import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

test.use({ serviceWorkers: "block", backendScenario: "caps-full" });

const navigationChunk =
	/\/(?:assets\/navigation-[^/]+|generated\/namespaces\/navigation)\.js$/;

for (const persistent of [false, true]) {
	test(
		persistent
			? "a persistent namespace failure leaves the manual Reload after one retry"
			: "a single namespace fetch failure reloads the document and mounts",
		{ tag: "@desktop-only" },
		async ({ page }) => {
			const documents: string[] = [];
			const namespaceRequests: string[] = [];
			page.on("request", (request) => {
				if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
					documents.push(request.url());
				}
			});
			await page.route(
				(url) => navigationChunk.test(url.pathname),
				async (route) => {
					const request = route.request();
					if (request.frame() !== page.mainFrame() || request.resourceType() !== "script") {
						await route.continue();
						return;
					}
					namespaceRequests.push(request.url());
					if (persistent || namespaceRequests.length === 1) {
						await route.abort("failed");
					} else {
						await route.continue();
					}
				},
			);

			const initial = await page.goto("/", { waitUntil: "commit" });
			const watchdog = page.locator("#js-failed");
			if (persistent) {
				await expect.poll(() => documents.length, {
					timeout: 10_000,
					message: "Boot should retry the document once before giving up",
				}).toBe(2);
				await expect(watchdog).toBeVisible({ timeout: 10_000 });
				await expect(watchdog.getByRole("button", { name: "Reload", exact: true })).toBeEnabled();
				expect(
					await page.evaluate(() => "__ceraAppMounted" in window && window.__ceraAppMounted === true),
				).toBe(false);
			} else {
				await test.step("Mount CeraUI after the aborted namespace request", async () => {
					await page.waitForFunction(
						() => "__ceraAppMounted" in window && window.__ceraAppMounted === true,
						undefined,
						{ timeout: 10_000 },
					);
				});
				await expect(watchdog).toBeHidden();
				await ensureAuthenticated(page);
				await navigateTo(page, "live");
			}

			expect(documents).toEqual([initial?.url(), initial?.url()]);
			expect(namespaceRequests).toHaveLength(2);
			expect(namespaceRequests[1]).toBe(namespaceRequests[0]);
		},
	);
}
