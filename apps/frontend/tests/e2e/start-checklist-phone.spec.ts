import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

type Frame = Record<string, unknown>;

/**
 * With no usable source and no server, the Live bar used to name only the
 * source problem, with no button, and Start did nothing. Now both blockers
 * show at once with a button each, and a tap on the blocked Start leads to
 * them. Runs against the real frontend and the worker's mock backend; the
 * config frames are rewritten so both gates are blocked whatever the worker
 * was seeded with.
 */
async function blockSourceAndServer(page: Page, blockNetworkAndEngine = false) {
	await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((message) => server.send(message));
		server.onMessage((message) => {
			const text = typeof message === "string" ? message : message.toString();
			try {
				const frame = JSON.parse(text) as Frame;
				const config = frame.config as Frame | undefined;
				if (config) {
					config.source = "e2e-unknown-source";
					config.relay_server = "";
					config.srtla_addr = "";
					delete config.selected_ingest_endpoint;
				}
				if (blockNetworkAndEngine) {
					if (frame.netif) frame.netif = {};
					const status = frame.status as Frame | undefined;
					if (status?.netif) status.netif = {};
					const caps = frame.capabilities as Frame | undefined;
					if (caps) caps.engineUnavailable = true;
				}
				ws.send(JSON.stringify(frame));
			} catch {
				ws.send(message);
			}
		});
	});
}

test.describe("A blocked Start lists what to fix", () => {
	test.beforeEach(({ browserName }) => {
		test.skip(browserName !== "chromium", "single-browser layout check");
	});

	test("both blockers show with a button each, and Start leads to them", async ({ page }) => {
		await blockSourceAndServer(page);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");

		const bar = page.getByTestId("live-bar");
		await expect(bar).toContainText("Fix these before you go live");
		const fixes = bar.locator("button[data-fix]");
		await expect(fixes).toHaveText(["Choose source", "Choose destination"]);
		for (const fix of await fixes.all()) {
			const box = await fix.boundingBox();
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
		}

		const start = bar.getByRole("button", { name: /start stream/i });
		await expect(start).toBeDisabled();
		// aria-disabled, not disabled: a real tap still reaches it, but Playwright's
		// actionability check would wait for it to be enabled.
		await start.click({ force: true });
		await expect(fixes.first()).toBeFocused();

		await fixes.nth(1).click();
		await expect(page.getByRole("dialog")).toBeVisible();
	});

	test("@mobile-only the bar stays inside a phone screen", async ({ page }) => {
		await blockSourceAndServer(page);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
		const bar = page.getByTestId("live-bar");
		await expect(bar.locator("button[data-fix]")).toHaveCount(2);
		const box = await bar.boundingBox();
		expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	});

	test("@mobile-only the blocker list scrolls both ways without refreshing Live", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 500 });
		// The mobile project sets a narrow viewport but uses a desktop profile.
		// Enable touch before mounting so the app installs its refresh listeners.
		const touch = await page.context().newCDPSession(page);
		await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
		await blockSourceAndServer(page, true);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
		expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);

		const list = page.getByTestId("live-bar").getByRole("list", {
			name: "Fix these before you go live",
		});
		await expect(list.getByRole("listitem")).toHaveCount(4);
		const box = await list.boundingBox();
		if (!box) throw new Error("Blocker list has no bounding box");
		const maxScroll = await list.evaluate((el) => el.scrollHeight - el.clientHeight);
		expect(maxScroll).toBeGreaterThan(0);
		const documentStart = await page.evaluate(() => {
			window.scrollTo(0, 0);
			return performance.timeOrigin;
		});
		const scrollTop = () => list.evaluate((el) => el.scrollTop);
		const pageScroll = () => page.evaluate(() => window.scrollY);
		await expect.poll(scrollTop).toBe(0);
		await expect.poll(pageScroll).toBe(0);

		const x = Math.round(box.x + box.width / 2);
		async function swipe(fromY: number, deltaY: number) {
			await touch.send("Input.dispatchTouchEvent", {
				type: "touchStart",
				touchPoints: [{ x, y: fromY }],
			});
			for (let step = 1; step <= 12; step++) {
				await touch.send("Input.dispatchTouchEvent", {
					type: "touchMove",
					touchPoints: [{ x, y: fromY + deltaY * step / 12 }],
				});
			}
			await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		}

		// Both drags exceed the page refresh threshold. The page stays at the top.
		await swipe(box.y + box.height - 12, -100);
		await expect.poll(scrollTop).toBe(maxScroll);
		await expect.poll(pageScroll).toBe(0);
		await swipe(box.y + 12, 100);
		await expect.poll(scrollTop).toBe(0);
		await expect.poll(pageScroll).toBe(0);
		expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStart);
	});

	for (const size of [
		{ width: 390, height: 500 },
		{ width: 844, height: 390 },
	]) {
		test(`on a ${size.width}x${size.height} screen every reason stays visible and Start stays in view`, async ({ page }) => {
			await page.setViewportSize(size);
			await blockSourceAndServer(page);
			await page.goto("/");
			await ensureAuthenticated(page);
			await navigateTo(page, "live");
			const bar = page.getByTestId("live-bar");
			await expect(bar.locator("button[data-fix]")).toHaveCount(2);
			const reasons = bar.locator("li[data-blocker] [data-blocker-reason]");
			await expect(reasons).toHaveCount(2);
			for (const reason of await reasons.all()) {
				await reason.scrollIntoViewIfNeeded();
				await expect(reason).toBeVisible();
				const box = await reason.boundingBox();
				// Real text, not a 1 px screen-reader-only box.
				expect(box?.width ?? 0).toBeGreaterThan(40);
				expect(box?.height ?? 0).toBeGreaterThan(8);
			}
			const start = bar.getByRole("button", { name: /start stream/i });
			const startBox = await start.boundingBox();
			expect((startBox?.y ?? size.height) + (startBox?.height ?? 0)).toBeLessThanOrEqual(size.height);
		});
	}
});
