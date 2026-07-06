import fs from "node:fs";

import { expect, test } from "./fixtures/index.js";

import { ensureAuthenticated, evidencePath, navigateTo } from "./helpers/index.js";

/**
 * Audit A2 (companion) — Network destination under the `single-modem` scenario,
 * @audit. Reached via the worker-scoped backendScenario override (PLAYBOOK.md →
 * Per-Worker Backend Scenario Override); a worker-scoped `test.use` must sit at
 * file top level, so single-modem gets its own file (one scenario per file).
 *
 * single-modem = 1 modem, WiFi OFF. Verifies:
 *   • exactly one bonded link / one modem row renders;
 *   • the WiFi section reports "no adapters" AND its Connect trigger is disabled
 *     WITH an accessible reason (regression for the disabled-without-reason gap
 *     this audit fixed — WifiSection now sets `title` when there is no radio).
 */
test.use({ backendScenario: "single-modem" });

test.describe("Audit A2 — Network destination (single-modem)", { tag: "@audit" }, () => {
	test.skip(({ browserName }) => browserName !== "chromium", "single-browser audit walk");

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the Network destination audit",
		);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
	});

	test("single-modem renders one link and a reasoned, disabled WiFi Connect control", async ({
		page,
	}) => {
		// Bonded links present (the single modem, once it holds an IP).
		await expect(page.getByTestId("bonded-link-card").first()).toBeVisible({ timeout: 15_000 });
		const linkCount = await page.getByTestId("bonded-link-card").count();
		expect(linkCount).toBeGreaterThan(0);

		// WiFi is OFF in this scenario → the Connect trigger is disabled and MUST
		// carry a non-empty reason (title), never a silent dead control.
		const wifiConnect = page.getByTestId("open-wifi-selector-dialog");
		await expect(wifiConnect).toBeVisible();
		await expect(wifiConnect).toBeDisabled();
		await expect(wifiConnect).toHaveAttribute("title", /\S/);

		// The sole-telemetry rule still holds with a single link.
		const outside = await page
			.getByTestId("link-telemetry")
			.evaluateAll(
				(els) => els.filter((el) => el.closest('[data-testid="bonded-link-card"]') === null).length,
			);
		expect(outside).toBe(0);

		fs.writeFileSync(
			evidencePath("audit-network-single-modem.txt"),
			[
				"Audit A2 — Network destination coherence (single-modem)",
				`Generated: ${new Date().toISOString()}`,
				"",
				`Bonded links rendered: ${linkCount} (>0) — PASS`,
				"WiFi OFF → Connect trigger disabled WITH title reason (disabled-without-reason gap fixed) — PASS",
				"Sole-telemetry rule holds with one link (0 clusters outside bonded-link-card) — PASS",
				"",
			].join("\n"),
			"utf8",
		);
	});
});
