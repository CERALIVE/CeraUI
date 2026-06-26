import { expect, type Page, test } from "./fixtures/index.js";

import {
	expectNoOrphanPreviewSocket,
	injectServerConfig,
	installPreviewHarness,
	loadE2EToken,
	previewConfig,
	previewFail,
	previewSocketCount,
} from "./helpers/preview-harness";
import { navigateTo } from "./helpers";

/**
 * EncoderDialog live preview (#72) — the SAME PreviewCanvas as the Live view,
 * mounted compact inside the encoder config dialog. Drives the real component
 * against the deterministic preview harness (no cerastream preview backend in
 * e2e): toggle, in-dialog media surface, clean teardown across open/close, and
 * the distinct `waiting` (no active encode) and `error` states.
 *
 * Auth reuses the field-lock/capability WebSocket harness pattern. Preview-state
 * control comes from `helpers/preview-harness.ts`.
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

function dialog(page: Page) {
	return page.getByRole("dialog", { name: "Encoder Settings" });
}

test.describe("EncoderDialog live preview (#72)", () => {
	test.skip(({ browserName }) => browserName !== "chromium", "single-browser preview proof");
	test.skip(!TOKEN, "requires a backend persistent auth token");

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop layout drives the encoder dialog");
		await page.addInitScript(installPreviewHarness, TOKEN as string);
		await page.goto("/");
	});

	test("toggles a compact preview with canvas + audio meter inside the dialog", async ({
		page,
	}) => {
		await openEncoder(page);
		const modal = dialog(page);

		// The preview mounts compact (host supplies the chrome) and is off by default.
		const preview = modal.getByTestId("preview");
		await expect(preview).toBeVisible();
		await expect(preview).toHaveAttribute("data-compact", "true");
		await expect(modal.getByTestId("preview-canvas")).toBeHidden();

		await modal.getByTestId("preview-toggle").click();

		// Media surface + audio meter render IN the dialog, which stays open.
		await expect(modal.getByTestId("preview-canvas")).toBeVisible();
		await expect(modal.getByTestId("audio-level-meter")).toBeVisible();
		await expect(modal).toBeVisible();
	});

	test("reopening the dialog leaves no orphaned preview socket or console error", async ({
		page,
	}) => {
		const consoleErrors: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "error") consoleErrors.push(msg.text());
		});

		await openEncoder(page);
		await dialog(page).getByTestId("preview-toggle").click();
		await expect(dialog(page).getByTestId("preview-canvas")).toBeVisible();
		expect(await previewSocketCount(page)).toBe(1);

		// Close → the preview unmounts and tears its socket down.
		await page.keyboard.press("Escape");
		await expect(dialog(page)).toBeHidden();
		await expectNoOrphanPreviewSocket(page);

		// Reopen → a fresh session, not a leaked second one stacked on the first.
		await page.getByTestId("open-encoder-dialog").click();
		await expect(dialog(page)).toBeVisible();
		await dialog(page).getByTestId("preview-toggle").click();
		await expect(dialog(page).getByTestId("preview-canvas")).toBeVisible();
		expect(await previewSocketCount(page)).toBe(2);

		expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
	});

	test("surfaces the waiting state with no active encode", async ({ page }) => {
		await openEncoder(page);
		const preview = dialog(page).getByTestId("preview");

		await dialog(page).getByTestId("preview-toggle").click();
		// Socket up + codec configured, but no access units flow (no active encode).
		await previewConfig(page);

		await expect(preview).toHaveAttribute("data-status", "waiting");
		await expect(preview).toContainText(/waiting for video/i);
	});

	test("surfaces a distinct error state on a failed preview pipeline", async ({ page }) => {
		await openEncoder(page);
		const preview = dialog(page).getByTestId("preview");

		await dialog(page).getByTestId("preview-toggle").click();
		await previewConfig(page);
		await previewFail(page);

		await expect(preview).toHaveAttribute("data-status", "error");
		await expect(preview).toContainText(/preview unavailable/i);
	});
});
