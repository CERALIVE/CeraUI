import { expect, test } from "../fixtures/index.js";
import {
	ensureAuthenticated,
	evidencePath,
	navigateTo,
} from "../helpers/index.js";

/**
 * Task 10 — the live audio switch is gated: while streaming, the audio source is
 * never an actionable switch when the engine advertises no live-audio capability.
 *
 * Proves, against the REAL frontend + the per-worker mock backend, that a stream
 * started on `multi-modem-wifi` (no `audio_live_switch`, no `audio_mix`) shows
 * its audio read-only: the live audio line and its level meter in
 * LiveSummaryStrip, no live Audio card and no audio switch control (the Live
 * screen contract, docs/agents/live-screen.md). The coming-soon pill this spec
 * once asserted (TD-live-audio-switch) is resolved and left the Live screen with
 * InputPicker. Captures the summary strip as repo-local evidence.
 */
test.describe("@visual Task 10 — gated live audio switch", () => {
	test(
		"@visual audio source is read-only while streaming, with no live switch",
		{ tag: "@visual" },
		async ({ page, backendRpc }, testInfo) => {
			test.skip(
				testInfo.project.name !== "desktop",
				"single-layout visual proof",
			);

			// A capture source and a destination, so Start is ready whatever config
			// the worker backend was seeded with.
			await backendRpc.call(["streaming", "setConfig"], {
				source: "usb",
				srtla_addr: "127.0.0.1",
				srtla_port: 5000,
			});
			await page.goto("/");
			await ensureAuthenticated(page);
			await navigateTo(page, "live");

			await page
				.getByTestId("live-bar")
				.getByRole("button", { name: "Start stream" })
				.click();
			const cockpit = page.getByTestId("live-cockpit");
			await expect(cockpit).toBeVisible({ timeout: 15_000 });

			const strip = cockpit.getByTestId("live-summary-strip");
			await expect(strip.locator('[data-live-value="audio"]')).toBeVisible();
			await expect(strip.getByTestId("live-audio-meter")).toBeVisible();
			await expect(cockpit.getByTestId("audio-card")).toHaveCount(0);
			await expect(page.locator('[data-switch-input^="audio:"]')).toHaveCount(0);

			await strip.screenshot({
				path: evidencePath("task-10-audio-comingsoon.png"),
			});
			await page
				.getByTestId("live-bar")
				.getByRole("button", { name: "Stop stream" })
				.click();
		},
	);
});
