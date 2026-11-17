import ar from "../../../../packages/i18n/messages/ar.json" with { type: "json" };
import en from "../../../../packages/i18n/messages/en.json" with { type: "json" };
import { expect, test } from "./fixtures/index.js";

// The field is LTR in every locale; its toggle sits on the page's inline end, so
// in RTL the two resolve "end" against different directions. Desktop and mobile.
for (const { code, dir, messages } of [
	{ code: "en", dir: "ltr", messages: en },
	{ code: "ar", dir: "rtl", messages: ar },
] as const) {
	test(`the show-password toggle stays clear of the password text (${dir})`, async ({ page }) => {
		await page.goto("/");
		await page.waitForFunction(
			() => "__ceraAppMounted" in window && window.__ceraAppMounted === true,
		);
		const password = page.locator("#password");
		const toggle = page.getByTestId("auth-password-visibility");
		await expect(toggle).toBeVisible();
		if (code !== "en") {
			await page.getByTestId("locale-selector").click();
			await page.getByTestId(`locale-option-${code}`).click();
		}
		await expect(page.locator("html")).toHaveAttribute("dir", dir);
		await expect(toggle).toHaveAccessibleName(messages["auth.showPassword"]);
		await expect(password).toHaveAttribute("dir", "ltr");

		const { field, text, icon } = await password.evaluate((input) => {
			const button = document.querySelector('[data-testid="auth-password-visibility"]');
			if (!button) throw new Error("Visibility toggle missing");
			const box = input.getBoundingClientRect();
			const style = getComputedStyle(input);
			const inset = (side: "Left" | "Right" | "Top" | "Bottom") =>
				Number.parseFloat(style[`border${side}Width`]) +
				Number.parseFloat(style[`padding${side}`]);
			const rect = (r: DOMRect) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
			return {
				field: rect(box),
				// The content box is where the typed (or masked) characters render.
				text: {
					left: box.left + inset("Left"),
					right: box.right - inset("Right"),
					top: box.top + inset("Top"),
					bottom: box.bottom - inset("Bottom"),
				},
				icon: rect(button.getBoundingClientRect()),
			};
		});
		const geometry = JSON.stringify({ field, text, icon });

		const overlapX = Math.min(text.right, icon.right) - Math.max(text.left, icon.left);
		const overlapY = Math.min(text.bottom, icon.bottom) - Math.max(text.top, icon.top);
		expect(overlapX > 0 && overlapY > 0, `toggle intersects the text box: ${geometry}`).toBe(false);

		expect(icon.left >= field.left && icon.right <= field.right, geometry).toBe(true);
		const iconCentre = (icon.left + icon.right) / 2;
		const fieldCentre = (field.left + field.right) / 2;
		expect(dir === "rtl" ? iconCentre < fieldCentre : iconCentre > fieldCentre, geometry).toBe(true);
	});
}
