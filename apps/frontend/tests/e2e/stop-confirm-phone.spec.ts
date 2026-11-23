import en from "../../../../packages/i18n/messages/en.json" with { type: "json" };
import { expect, test } from "./fixtures/index.js";
import { endStream, ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * On a phone the Live bar's Stop sits right above the bottom nav, where a
 * pocket tap or a missed tap on the nav lands. Stop now asks "End the stream?"
 * first. Against the real frontend and the worker's mock backend this checks
 * that one tap leaves the stream running, that a second tap on the same spot
 * does not reach End stream, and that Keep streaming and End stream do what
 * they say.
 */
test.describe("Stop asks before it ends the stream", () => {
	test.beforeEach(async ({ page, backendRpc }) => {
		await backendRpc.call(["streaming", "setConfig"], {
			source: "usb",
			srtla_addr: "127.0.0.1",
			srtla_port: 5000,
		});
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
		await page.getByTestId("live-bar").getByRole("button", { name: /start stream/i }).click();
		await expect(page.getByTestId("live-cockpit")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("live-cockpit")).toHaveAttribute("data-summary-mode", "false");
	});

	test("@mobile-only a double tap on Stop leaves the stream running", async ({ page }) => {
		const stop = page.getByTestId("live-bar").getByTestId("live-bar-stop");
		await expect(stop).toBeEnabled({ timeout: 15_000 });
		const box = await stop.boundingBox();
		expect(box).not.toBeNull();
		const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
		const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;

		await page.mouse.click(x, y);
		const question = page.getByTestId("live-stop-confirm");
		await expect(question).toBeVisible();

		// End stream sits well above the spot where Stop was.
		const end = question.getByTestId("live-stop-end");
		const endBox = await end.boundingBox();
		expect(endBox).not.toBeNull();
		expect((endBox?.y ?? 0) + (endBox?.height ?? 0)).toBeLessThan(box?.y ?? 0);
		expect(endBox?.height ?? 0).toBeGreaterThanOrEqual(44);

		// A second tap on the same spot hits the backdrop: nothing happens.
		await page.mouse.click(x, y);
		await expect(question).toBeVisible();
		await expect(page.getByTestId("live-cockpit")).toHaveAttribute("data-summary-mode", "false");

		await question.getByTestId("live-stop-keep").click();
		await expect(question).toHaveCount(0);
		await expect(stop).toBeVisible();
		await expect(page.getByTestId("live-cockpit")).toHaveAttribute("data-summary-mode", "false");
		await expect(page.getByTestId("idle-cockpit")).toHaveCount(0);
	});

	test("End stream stops the stream", async ({ page }) => {
		await endStream(page);
		await expect(page.getByTestId("idle-cockpit").or(page.getByTestId("summary-done"))).toBeVisible({
			timeout: 15_000,
		});
	});

	test("Keep streaming is the default, and Escape returns focus to Stop", async ({ page }) => {
		const stop = page.getByTestId("live-bar-stop");
		const question = page.getByRole("alertdialog", { name: en["live.stopConfirm.title"], exact: true });
		await expect(stop).toBeEnabled();
		await stop.press("Enter");
		await expect(question).toHaveAccessibleDescription(en["live.stopConfirm.body"]);
		const keep = question.getByRole("button", { name: en["live.stopConfirm.keep"], exact: true });
		const end = question.getByRole("button", { name: en["live.stopConfirm.end"], exact: true });
		await expect(keep.and(question.getByTestId("live-stop-keep"))).toBeFocused();
		await expect(end.and(question.getByTestId("live-stop-end"))).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(question).toHaveCount(0);
		await expect(stop).toBeFocused();
	});

	test.describe("short touchscreen viewport", () => {
		test.use({ hasTouch: true, viewport: { width: 390, height: 568 } });

		test("@mobile-only tapping Stop twice does not end the stream", async ({ page }) => {
			const stop = page.getByTestId("live-bar-stop");
			await expect(stop).toBeEnabled();
			const box = await stop.boundingBox();
			if (!box) throw new Error("Live bar Stop is not visible");
			const x = box.x + box.width / 2;
			const y = box.y + box.height / 2;
			await page.touchscreen.tap(x, y);
			const question = page.getByTestId("live-stop-confirm");
			await expect(question).toBeVisible();
			await page.touchscreen.tap(x, y);
			await expect(question).toBeVisible();
			await expect(page.getByTestId("live-cockpit")).toHaveAttribute("data-summary-mode", "false");
		});
	});
});
