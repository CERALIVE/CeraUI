import { setLocale } from "@ceraui/i18n/svelte";
import { render } from "@testing-library/svelte";
import { afterEach, expect, it } from "vitest";

import { addScreenshot, clearScreenshots } from "$lib/stores/screenshot.svelte";
import ScreenshotUtility from "./screenshot-utility.svelte";

afterEach(() => {
	clearScreenshots();
	setLocale("en");
});

it.each([
	["en", 1, "Download ZIP (1 file)"],
	["ar", 2, "تحميل ZIP (2 ملفان)"],
] as const)(
	"uses the same visible and accessible ZIP label in %s for %i files",
	(locale, count, label) => {
		setLocale(locale);
		for (let i = 0; i < count; i++) {
			addScreenshot({
				filename: `image-${i}.png`,
				blob: new Blob(),
				theme: "dark",
				type: "desktop",
			});
		}
		const { getByRole } = render(ScreenshotUtility);
		const button = getByRole("button", { name: label });
		expect(button.textContent?.trim()).toBe(label);
	},
);
