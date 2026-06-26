import type { WebSocketRoute } from "@playwright/test";

import { expect, test } from "../fixtures/index.js";
import { ensureAuthenticated, evidencePath, navigateTo } from "../helpers/index.js";

/**
 * @visual evidence for the capability/fallback education affordances (Task 9):
 *   • a per-field "?" info popover open on the Encoder source field, showing the
 *     explanation a reviewer can read without running the app;
 *   • the calm engine-starting capability-tier banner on the Live surface.
 *
 * PNGs land in apps/frontend/test-results/ (repo-local, gitignored). Tagged
 * @visual so the screenshot guard in fixtures permits the page screenshots here.
 */
test.describe("@visual source education affordances", () => {
	let pageWs: WebSocketRoute | null;

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop viewport owns evidence");
		pageWs = null;
		// Proxy the WS so the spec can inject snapshots (config to clear the Live
		// empty state; a capabilities tier flag) on top of the live mock stream.
		await page.routeWebSocket(/:(3002|31\d\d|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => ws.send(m));
		});

		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");

		// A configured server leaves the empty state so the config rows render.
		pageWs?.send(
			JSON.stringify({
				config: { srtla_addr: "127.0.0.1", srtla_port: 5000, max_br: 5000 },
			}),
		);
	});

	test("per-field info popover open on the Source field", { tag: "@visual" }, async ({
		page,
	}) => {
		const trigger = page.getByTestId("info-source");
		await expect(trigger).toBeVisible({ timeout: 15_000 });
		await trigger.click();

		// The popover body is the explanation copy — wait for it before capturing.
		await expect(
			page.getByText("Where the encoder pulls video from", { exact: false }),
		).toBeVisible({ timeout: 10_000 });

		await page.screenshot({
			path: evidencePath("task-9-education-popover.png"),
		});
	});

	test("calm engine-starting capability-tier banner", { tag: "@visual" }, async ({ page }) => {
		// Inject a capabilities snapshot raising the engineStarting tier flag.
		pageWs?.send(
			JSON.stringify({
				capabilities: {
					platform: { supports_h265: true, hardware_accelerated: true, max_resolution: "2160p" },
					encoder: { codecs: ["video/x-h264"], bitrate_range: { min: 500, max: 50000, unit: "kbps" } },
					sources: [],
					engineStarting: true,
				},
			}),
		);

		const banner = page.getByTestId("capability-engine-starting");
		await expect(banner).toBeVisible({ timeout: 10_000 });

		await page.screenshot({ path: evidencePath("task-9-capability-tier.png") });
	});
});
