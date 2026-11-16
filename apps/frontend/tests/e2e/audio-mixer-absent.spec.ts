import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * The Audio card without the engine's `audio_mix` capability: the default
 * `multi-modem-wifi` scenario advertises no mix, so the card is today's picker
 * and meter and no mixer node exists. Split from `audio-mixer.spec.ts` because
 * the scenario is a worker-scoped option, one per file.
 */
test.describe("audio mixer — multi-modem-wifi", () => {
	test("without audio_mix the Audio card is today's picker and meter, with no strip", async ({
		page,
		backendRpc,
	}) => {
		// The Audio card needs an effective source; the seed config names none.
		await backendRpc.call(["streaming", "setConfig"], { source: "usb" });
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
		const card = page.getByTestId("audio-card");
		await expect(card).toBeVisible();
		await expect(card.getByTestId("source-audio").getByTestId("live-audio-meter")).toBeVisible();
		await expect(page.getByTestId("audio-mixer")).toHaveCount(0);
		await expect(page.locator("[data-audio-strip]")).toHaveCount(0);
	});
});
