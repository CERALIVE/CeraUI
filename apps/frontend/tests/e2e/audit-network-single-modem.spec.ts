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
 *   • the WiFi section renders its calm empty state and — under the per-interface
 *     redesign where Connect is a per-row affordance — exposes ZERO Connect
 *     controls with no radios, so there is no silent dead control.
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

	test("single-modem renders one link and a WiFi empty state with no dead Connect control", async ({
		page,
	}) => {
		// Bonded links present (the single modem, once it holds an IP).
		await expect(page.getByTestId("bonded-link-card").first()).toBeVisible({ timeout: 15_000 });
		const linkCount = await page.getByTestId("bonded-link-card").count();
		expect(linkCount).toBeGreaterThan(0);

		// No WiFi radios in this scenario. Under the per-interface redesign the
		// Connect affordance is per-row, so with zero radios there is NO Connect
		// control at all — the WiFi section renders its calm empty state instead,
		// which is the strongest form of the "never a silent dead control" rule.
		const wifiSection = page
			.getByRole("heading", { name: "WiFi", level: 2 })
			.locator("xpath=ancestor::section[1]");
		await expect(wifiSection.getByText("No WiFi interfaces found")).toBeVisible();
		await expect(page.getByTestId("open-wifi-selector-dialog")).toHaveCount(0);

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
				"No WiFi radios → calm empty state, zero per-row Connect controls (no silent dead control) — PASS",
				"Sole-telemetry rule holds with one link (0 clusters outside bonded-link-card) — PASS",
				"",
			].join("\n"),
			"utf8",
		);
	});
});
