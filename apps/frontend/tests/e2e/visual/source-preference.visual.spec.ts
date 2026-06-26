import path from "node:path";

import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "../fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "../helpers/index.js";

/**
 * @visual evidence for the source-preference + fallback-state surface (Task 11).
 *
 * Two PNGs a reviewer can eyeball without running the app:
 *   - task-11-reorder.png  — operator-ordered preference list with up/down
 *     controls and the active-source badge.
 *   - task-11-failover.png — a sticky auto-failover: the preferred source is
 *     lost (amber), the engine is running the fallback (coral failed-over), and
 *     a non-blocking toast surfaces the reason.
 *
 * `devices` frames are injected over the WS; the server's own `devices`
 * broadcasts are dropped in the proxy so the injected state is deterministic.
 */

type Device = {
	input_id: string;
	device_path: string;
	display_name: string;
	media_class: "video" | "audio";
	kind: string;
	lost?: boolean;
};

const EVIDENCE_DIR = path.resolve(import.meta.dirname, "../../../test-results");

const HDMI: Device = {
	input_id: "video0",
	device_path: "/dev/video0",
	display_name: "HDMI Camera",
	media_class: "video",
	kind: "hdmi",
};
const USB: Device = {
	input_id: "video1",
	device_path: "/dev/video1",
	display_name: "USB Capture",
	media_class: "video",
	kind: "usb",
};

test.describe("@visual source-preference states", () => {
	let pageWs: WebSocketRoute | null;

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop viewport owns evidence");
		pageWs = null;

		await page.routeWebSocket(/:(3002|31\d\d|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as Record<string, unknown>;
					// Drop the server's device broadcasts so the injected state wins.
					if (frame && typeof frame === "object" && "devices" in frame) return;
				} catch {
					/* non-JSON / binary frame */
				}
				ws.send(m);
			});
		});

		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
	});

	function sendDevices(activeInput: string, devices: Device[]): void {
		pageWs?.send(
			JSON.stringify({
				devices: { engine: "cerastream", active_input: activeInput, devices },
			}),
		);
	}

	function sendPreference(order: string[]): void {
		pageWs?.send(
			JSON.stringify({
				config: {
					srtla_addr: "127.0.0.1",
					srtla_port: 5000,
					max_br: 5000,
					source_preference: order,
				},
			}),
		);
	}

	test("reorder: operator-ordered preference with up/down controls", async ({ page }) => {
		sendPreference(["video1", "video0"]);
		sendDevices("video1", [HDMI, USB]);

		const panel = page.getByTestId("source-preference");
		await expect(panel).toBeVisible({ timeout: 15_000 });

		// Two ranked video rows, USB first per the injected preference order.
		await expect(panel.locator("[data-input-id]")).toHaveCount(2);
		await expect(panel.locator('[data-input-id="video1"]')).toHaveAttribute(
			"data-state",
			"active",
		);
		await expect(panel.locator('[data-move-down="video1"]')).toBeVisible();
		await expect(panel.locator('[data-move-up="video0"]')).toBeVisible();

		await panel.screenshot({ path: path.join(EVIDENCE_DIR, "task-11-reorder.png") });
	});

	test("failover: sticky auto-failover badge + non-blocking toast", async ({ page }) => {
		sendPreference(["video0", "video1"]);
		sendDevices("video0", [HDMI, USB]);

		const panel = page.getByTestId("source-preference");
		await expect(panel).toBeVisible({ timeout: 15_000 });

		// Drop the preferred source (video0): retained as lost, engine on video1.
		sendDevices("video1", [USB]);

		await expect(panel.locator('[data-input-id="video0"]')).toHaveAttribute(
			"data-state",
			"lost",
			{ timeout: 10_000 },
		);
		await expect(panel.locator('[data-input-id="video1"]')).toHaveAttribute(
			"data-state",
			"failed-over",
		);

		// Non-blocking toast surfaces the reason (the lost source's name).
		await expect(page.getByText(/HDMI Camera/).first()).toBeVisible({ timeout: 10_000 });

		await page.screenshot({ path: path.join(EVIDENCE_DIR, "task-11-failover.png") });
	});
});
