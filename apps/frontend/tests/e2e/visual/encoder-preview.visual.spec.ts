import { expect, type Page, test } from "@playwright/test";

import { evidencePath, navigateTo } from "../helpers/index.js";
import {
	injectServerConfig,
	installPreviewHarness,
	loadE2EToken,
	previewAudio,
	previewConfig,
	previewFail,
} from "../helpers/preview-harness";

/**
 * EncoderDialog live preview (#72) — evidence screenshots (@visual). Captures the
 * compact preview mounted inside the encoder dialog (toggled on, audio meter
 * active) and its distinct waiting/error states, against the deterministic
 * preview harness. Lives under tests/e2e/visual so the screenshot guard allows
 * `page.screenshot`; excluded from the functional `--grep-invert @visual` run.
 */

const TOKEN = loadE2EToken();

async function openEncoder(page: Page): Promise<void> {
	await navigateTo(page, "live");
	await expect
		.poll(
			async () => {
				await injectServerConfig(page);
				return page.getByTestId("open-encoder-dialog").isVisible().catch(() => false);
			},
			{
				timeout: 10_000,
				message: "encoder edit row should render once a server config is present",
			},
		)
		.toBe(true);
	await page.getByTestId("open-encoder-dialog").click();
	await expect(page.getByRole("dialog", { name: "Encoder Settings" })).toBeVisible();
}

test.describe("@visual EncoderDialog live preview", () => {
	test.skip(({ browserName }) => browserName !== "chromium", "single-browser preview proof");
	test.skip(!TOKEN, "requires a backend persistent auth token");

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop layout drives the encoder dialog");
		await page.addInitScript(installPreviewHarness, TOKEN as string);
		await page.goto("/");
	});

	test("renders the compact preview inside the dialog @visual", async ({ page }) => {
		await openEncoder(page);
		const modal = page.getByRole("dialog", { name: "Encoder Settings" });

		await modal.getByTestId("preview-toggle").click();
		await expect(modal.getByTestId("preview-canvas")).toBeVisible();
		// Active codec + audio so the meter shows live channels in the capture.
		await previewConfig(page);
		await previewAudio(page, [-12, -18], [-6, -9]);
		await expect(modal.getByTestId("audio-level-meter")).toBeVisible();

		await page.screenshot({ path: evidencePath("72-modal-preview.png") });
	});

	test("renders the waiting then error states @visual", async ({ page }) => {
		await openEncoder(page);
		const preview = page
			.getByRole("dialog", { name: "Encoder Settings" })
			.getByTestId("preview");

		await preview.getByTestId("preview-toggle").click();

		// Waiting: socket up, codec configured, no frames (no active encode).
		await previewConfig(page);
		await expect(preview).toHaveAttribute("data-status", "waiting");

		// Error: the preview pipeline fails — a distinct, calmer surface.
		await previewFail(page);
		await expect(preview).toHaveAttribute("data-status", "error");

		await page.screenshot({ path: evidencePath("72-modal-states.png") });
	});
});
