import path from "node:path";

import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "../fixtures/index.js";
import { ensureAuthenticated } from "../helpers/index.js";

/**
 * @visual evidence for the reflowed HUD status sheet (Task 8 + Task 18).
 *
 * The sheet renders ONE lifecycle-keyed verdict line + a single sensors line,
 * and mounts the bond constellation only while live. This spec captures each of
 * the three explicit lifecycle states the reflow introduced:
 *
 *   • live    — is_streaming forced true via the WS proxy (the mock never
 *               streams); subtitle data-state=live, constellation strip present.
 *   • idle    — the default idle mock; subtitle data-state=idle, no constellation.
 *   • offline — the WS is dropped and kept down so the HUD staleness clock ages
 *               past STALE_THRESHOLD_MS (5 s); subtitle data-state=offline,
 *               verdict "No signal", last-seen line present.
 *
 * PNGs land in apps/frontend/test-results/task-24-visual (repo-local, gitignored).
 */

const TASK24_DIR = path.resolve(import.meta.dirname, "../../../test-results/task-24-visual");
const WS_PATTERN = /:(3002|31\d\d|6173|8090|8091)\//;

async function openHud(page: Page): Promise<Page> {
	await page.locator("[data-hud-region]").first().click();
	await expect(page.getByRole("dialog", { name: "Status" })).toBeVisible();
	return page;
}

test.describe("@visual HUD status sheet lifecycle", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop layout exposes the persistent HUD bar");
	});

	test("live: verdict + constellation strip + one sensors line", { tag: "@visual" }, async ({ page }) => {
		await page.routeWebSocket(WS_PATTERN, (ws) => {
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as { status?: Record<string, unknown> };
					if (frame?.status) {
						frame.status.is_streaming = true;
						ws.send(JSON.stringify(frame));
						return;
					}
				} catch {
					/* non-JSON / binary frame */
				}
				ws.send(m);
			});
		});

		await page.goto("/");
		await ensureAuthenticated(page);
		await openHud(page);

		const dialog = page.getByRole("dialog", { name: "Status" });
		await expect(dialog.getByTestId("hud-sheet-subtitle")).toHaveAttribute("data-state", "live");
		await expect(dialog.getByTestId("hud-constellation")).toBeVisible();
		// The reflow collapses the three sensor rows into exactly ONE inline line.
		await expect(dialog.getByTestId("hud-sensors-line")).toHaveCount(1);

		await dialog.screenshot({ path: path.join(TASK24_DIR, "hud-sheet-live.png") });
	});

	test("idle: idle verdict, no constellation, one sensors line", { tag: "@visual" }, async ({ page }) => {
		// No proxy — the default mock scenario is idle (is_streaming=false).
		await page.goto("/");
		await ensureAuthenticated(page);
		await openHud(page);

		const dialog = page.getByRole("dialog", { name: "Status" });
		await expect(dialog.getByTestId("hud-sheet-subtitle")).toHaveAttribute("data-state", "idle");
		await expect(dialog.getByTestId("hud-constellation")).toHaveCount(0);
		await expect(dialog.getByTestId("stream-health-state")).toContainText("Idle");
		await expect(dialog.getByTestId("hud-sensors-line")).toHaveCount(1);

		await dialog.screenshot({ path: path.join(TASK24_DIR, "hud-sheet-idle.png") });
	});

	test("offline: no-signal verdict once the connection ages out", { tag: "@visual" }, async ({ page }) => {
		let pageWs: WebSocketRoute | null = null;
		let killed = false;
		await page.routeWebSocket(WS_PATTERN, (ws) => {
			// Once killed, refuse every (re)connection so the client stays down and
			// its connectionLostAt ages past STALE_THRESHOLD_MS → isFullyStale.
			if (killed) {
				ws.close();
				return;
			}
			pageWs = ws;
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => ws.send(m));
		});

		await page.goto("/");
		await ensureAuthenticated(page);
		await openHud(page);

		const dialog = page.getByRole("dialog", { name: "Status" });
		await expect(dialog.getByTestId("hud-sheet-subtitle")).toHaveAttribute("data-state", "idle");

		// Drop the socket and keep it down; the open sheet re-derives reactively.
		killed = true;
		(pageWs as WebSocketRoute | null)?.close();

		await expect(dialog.getByTestId("hud-sheet-subtitle")).toHaveAttribute("data-state", "offline", {
			timeout: 15_000,
		});
		await expect(dialog.getByTestId("stream-health-state")).toContainText("No signal");
		await expect(dialog.getByTestId("hud-constellation")).toHaveCount(0);

		await dialog.screenshot({ path: path.join(TASK24_DIR, "hud-sheet-offline.png") });
	});
});
