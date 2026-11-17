import { expect, test } from "./fixtures/index.js";

test.use({ trace: "off", screenshot: "off", video: "off" });

// The sign-in root clips a decorative glow wider than a phone. As a scroll
// container (overflow: hidden) a script could still slide it sideways and push
// the card and the connection badge off-screen, as a QA click retry once did.
for (const { code, dir } of [
	{ code: "en", dir: "ltr" },
	{ code: "ar", dir: "rtl" },
] as const) {
	test(`scripted scrolling keeps the sign-in card on a phone screen (${dir})`, {
		tag: "@mobile-only",
	}, async ({ page }) => {
		await page.goto("/");
		await page.waitForFunction(
			() => "__ceraAppMounted" in window && window.__ceraAppMounted === true,
		);
		const remember = page.locator("#remember");
		await expect(remember).toBeVisible();
		if (code !== "en") {
			await page.getByTestId("locale-selector").click();
			await page.getByTestId(`locale-option-${code}`).click();
		}
		await expect(page.locator("html")).toHaveAttribute("dir", dir);
		await page
			.locator("#password")
			.evaluate((input) =>
				Promise.all(
					(input.closest("form")?.parentElement?.getAnimations() ?? []).map(
						(animation) => animation.finished,
					),
				),
			);

		// Playwright retries a click with this alignment; it moved the card 41 px.
		await remember.evaluate((checkbox) =>
			checkbox.scrollIntoView({ block: "start", inline: "start", behavior: "instant" }),
		);
		await expect(page.locator("[data-connection-strip]")).toBeVisible();

		const geometry = await page.evaluate(() => {
			const badge = document.querySelector("[data-connection-strip]");
			const root = badge?.parentElement;
			const card = document.querySelector("#password")?.closest("form")?.parentElement;
			if (!badge || !root || !card) throw new Error("Sign-in layout missing");
			const span = (el: Element) => {
				const box = el.getBoundingClientRect();
				return { left: box.left, right: box.right, width: box.width, height: box.height };
			};
			return {
				viewport: document.documentElement.clientWidth,
				pageScrollX: window.scrollX,
				rootScrollLeft: root.scrollLeft,
				card: span(card),
				badge: span(badge),
			};
		});
		const detail = JSON.stringify(geometry);
		expect(geometry.rootScrollLeft, detail).toBe(0);
		expect(geometry.pageScrollX, detail).toBe(0);
		for (const box of [geometry.card, geometry.badge]) {
			expect(box.left >= 0 && box.right <= geometry.viewport, detail).toBe(true);
		}
		expect(geometry.badge.width > 0 && geometry.badge.height > 0, detail).toBe(true);
	});
}
