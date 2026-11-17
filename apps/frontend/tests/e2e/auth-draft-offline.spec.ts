import { createHash, randomUUID } from "node:crypto";

import { expect, test } from "./fixtures/index.js";

declare global {
	interface Window {
		__row75Privacy: () => boolean;
		__row75Draft: (edits: number) => void;
	}
}

// A typed secret must not enter a retained trace, screenshot or video.
test.use({ trace: "off", screenshot: "off", video: "off" });

test("the sign-in draft survives repeated real offline swaps", {
	tag: "@desktop-only",
}, async ({ page, pageRpc }) => {
	// Keep the browser-facing RPC transport live during HTTP offline emulation.
	void pageRpc;
	const seed = process.env.ROW75_AUDIT_SEED ?? randomUUID();
	const marker = createHash("sha256").update(seed).digest("hex");
	let logged = false;
	let transmitted = false;
	page.on("console", (message) => {
		if (message.text().includes(marker)) logged = true;
	});
	page.on("websocket", (socket) => {
		socket.on("framesent", ({ payload }) => {
			if (String(payload).includes(marker)) transmitted = true;
		});
	});
	await page.addInitScript(async (source) => {
		const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
		const fragment = Array.from(new Uint8Array(bytes), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		let leaked = false;
		const setItem = Storage.prototype.setItem;
		Storage.prototype.setItem = function (
			this: Storage,
			key: string,
			value: string,
		) {
			if (key.includes(fragment) || value.includes(fragment)) leaked = true;
			return setItem.call(this, key, value);
		};
		window.__row75Privacy = () => leaked;
		// Only the edit count enters Playwright's recorded API arguments.
		window.__row75Draft = (edits) => {
			const input = document.querySelector<HTMLInputElement>("#password");
			if (!input) throw new Error("Draft field missing");
			input.value = ` cera-draft-${fragment} ñ界 ${"x".repeat(edits)}`;
			input.dispatchEvent(new Event("input", { bubbles: true }));
		};
	}, seed);
	// Cold Vite loads can fill the browser's default 250-entry resource buffer.
	await page.addInitScript(() => performance.setResourceTimingBufferSize(5000));
	await page.goto("/");
	await page.waitForFunction(
		() => "__ceraAppMounted" in window && window.__ceraAppMounted === true,
	);
	// The initial connectivity probe must finish before taking the page offline.
	await page.waitForFunction(() =>
		performance.getEntriesByType("resource").some(
			(entry) =>
				entry instanceof PerformanceResourceTiming &&
				new URL(entry.name).pathname === "/favicon.ico" &&
				entry.initiatorType === "fetch" &&
				entry.responseStatus === 200,
		),
	);
	const password = page.locator("#password");
	const remember = page.locator("#remember");
	const visibility = page.getByTestId("auth-password-visibility");
	await expect(page.locator("[data-connection-strip]")).toContainText(
		"Device connected",
	);
	let draft = ` cera-draft-${marker} ñ界 `;
	const documentStarted = await page.evaluate(() => performance.timeOrigin);
	try {
		await page.waitForFunction(() => typeof window.__row75Draft === "function");
		await page.evaluate(() => window.__row75Draft(0));
		await remember.click();
		await visibility.click();
		await expect(password).toHaveAttribute("type", "text");
		await page.getByTestId("locale-selector").click();
		await page.getByTestId("locale-option-ar").click();
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(password).toHaveAttribute("dir", "ltr");

		for (const _flip of [1, 2]) {
			const menuTrigger = _flip === 1
				? page.getByTestId("locale-selector")
				: page.getByTestId("theme-toggle");
			await menuTrigger.click();
			await expect(page.getByRole("menu")).toBeVisible();
			const outage = await page.evaluate(() => performance.now());
			await page.context().setOffline(true);
			await expect(page.getByTestId("offline-page")).toBeVisible();
			await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
			await page.getByTestId("offline-page").getByRole("button").first().focus();
			await page.keyboard.press("Tab");
			expect(await page.evaluate(() =>
				document.activeElement?.closest('[data-testid="offline-page"]') !== null,
			)).toBe(true);
			await expect(password).toBeHidden();
			await password.evaluate((input: HTMLInputElement) => input.focus());
			expect(
				await page.evaluate(() => document.activeElement?.id === "password"),
			).toBe(false);
			await page.context().setOffline(false);
			await page.waitForFunction(
				(after) => performance.getEntriesByType("resource").some(
					(entry) => entry instanceof PerformanceResourceTiming &&
						new URL(entry.name).pathname === "/favicon.ico" &&
						entry.initiatorType === "fetch" &&
						entry.responseStatus === 200 && entry.startTime > after,
				),
				outage,
			);
			await expect(password).toBeVisible();
			// Boolean assertions keep the generated secret out of failure logs.
			await expect.poll(
				async () => (await password.inputValue()) === draft,
			).toBe(true);
			await expect(remember).toHaveAttribute("aria-checked", "true");
			await expect(password).toHaveAttribute("type", "password");
			expect(
				await page.evaluate(() => performance.timeOrigin),
			).toBe(documentStarted);
			draft = `${draft}x`;
			await page.evaluate((edits) => window.__row75Draft(edits), _flip);
		}
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.getByTestId("locale-selector").click();
		await page.getByTestId("locale-option-en").click();
		await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
		expect((await password.inputValue()) === draft).toBe(true);

		expect(
			await page.evaluate(() => {
				const secret = document.querySelector<HTMLInputElement>("#password")?.value;
				if (!secret) throw new Error("Draft field must be populated for the privacy check");
				const persisted = [
					...Object.values(localStorage),
					...Object.values(sessionStorage),
					document.cookie,
					location.href,
					document.documentElement.outerHTML,
				];
				return persisted.some((value) => String(value).includes(secret));
			}),
		).toBe(false);

		expect(await page.evaluate(() => window.__row75Privacy())).toBe(false);
		await page.reload();
		await expect(password).toBeVisible();
		expect((await password.inputValue()) === "").toBe(true);
		await expect(remember).toHaveAttribute("aria-checked", "false");
		expect(logged).toBe(false);
		expect(transmitted).toBe(false);
		expect(await page.evaluate(() => window.__row75Privacy())).toBe(false);
		expect(
			(await page.context().cookies()).some((cookie) =>
				cookie.value.includes(marker),
			),
		).toBe(false);
		// Real history navigation exercises pagehide and a possible BFCache return.
		await page.evaluate(() => window.__row75Draft(2));
		await page.goto("about:blank");
		await page.goBack();
		await expect(password).toBeVisible();
		expect((await password.inputValue()) === "").toBe(true);
	} finally {
		await page.context().setOffline(false);
		await page.evaluate(() => {
			for (const input of document.querySelectorAll<HTMLInputElement>(
				"#password, #confirm-password",
			)) {
				input.value = "";
				input.type = "password";
				input.dispatchEvent(new Event("input", { bubbles: true }));
			}
		});
	}
});
