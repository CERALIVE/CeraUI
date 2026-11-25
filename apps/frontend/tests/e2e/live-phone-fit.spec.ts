import ar from "../../../../packages/i18n/messages/ar.json" with { type: "json" };
import de from "../../../../packages/i18n/messages/de.json" with { type: "json" };
import en from "../../../../packages/i18n/messages/en.json" with { type: "json" };
import es from "../../../../packages/i18n/messages/es.json" with { type: "json" };
import fr from "../../../../packages/i18n/messages/fr.json" with { type: "json" };
import hi from "../../../../packages/i18n/messages/hi.json" with { type: "json" };
import ja from "../../../../packages/i18n/messages/ja.json" with { type: "json" };
import ko from "../../../../packages/i18n/messages/ko.json" with { type: "json" };
import ptBR from "../../../../packages/i18n/messages/pt-BR.json" with { type: "json" };
import zh from "../../../../packages/i18n/messages/zh.json" with { type: "json" };

import type { StatusResponse } from "@ceraui/rpc/schemas";
import type { Locator, Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { measureHitAreas } from "./helpers/hit-area.js";
import { ensureAuthenticated, navigateTo, setLocale } from "./helpers/index.js";

/**
 * Live on a phone, and the same header on desktop. The header's state chip keeps
 * its whole label on one line, inside the pill, header and screen and in the
 * accessibility tree, in both confirmed states (Japanese is the widest); on a
 * phone a shown chip hides the subtitle. Without a chip the title and subtitle
 * stay visible beside the unconfirmed band. The live preview's title and toggle
 * stay on screen, and the toggle is a 44 px phone target that takes no taps from
 * the disclosure summary above. Measured from rendered geometry; injected frames
 * replace the backend's stream facts.
 */

const COPY = { ar, de, en, es, fr, hi, ja, ko, "pt-BR": ptBR, zh };
// 390 px first: the reported two-line "NOT / STREAMING" reproduction.
const PHONES = [390, 320, 360, 412].map((width) => ({ width, height: 800 }));
const SHORT_LANDSCAPE = { width: 844, height: 390 };
const DESKTOP = { width: 1280, height: 800 };
const IDLE: StatusResponse = { is_streaming: false, stream_lifecycle: "idle" };
const LIVE: StatusResponse = { is_streaming: true, stream_lifecycle: "streaming" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function openLive(page: Page, locale: string): Promise<void> {
	await page.goto("/");
	await ensureAuthenticated(page);
	await setLocale(page, locale);
	await page.goto("/");
	await ensureAuthenticated(page);
	await expect(page.locator("html")).toHaveAttribute("lang", locale);
	await navigateTo(page, "live");
	await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

// The app picks phone or desktop chrome in the rendering update after a resize.
async function resize(page: Page, viewport: { width: number; height: number }): Promise<void> {
	await page.setViewportSize(viewport);
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

// Negative when the root reserves a scrollbar gutter; positive means sideways scrolling.
function pageOverflow(page: Page): Promise<number> {
	return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

function labelLayout(chip: Locator) {
	return chip.evaluate((pill) => {
		const text = [...pill.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
		const header = pill.closest("header");
		if (text === undefined || header === null) return null;
		const range = document.createRange();
		range.selectNodeContents(text);
		const rects = [...range.getClientRects()].filter((rect) => rect.width > 0).sort((a, b) => a.top - b.top);
		let lines = 0;
		let lineBottom = Number.NEGATIVE_INFINITY;
		for (const rect of rects) {
			if (rect.top >= lineBottom - 1) lines += 1;
			lineBottom = Math.max(lineBottom, rect.bottom);
		}
		const within = (inner: DOMRect, outer: DOMRect) =>
			inner.left >= outer.left - 0.5 &&
			inner.right <= outer.right + 0.5 &&
			inner.top >= outer.top - 0.5 &&
			inner.bottom <= outer.bottom + 0.5;
		const label = range.getBoundingClientRect();
		const pillBox = pill.getBoundingClientRect();
		const headerBox = header.getBoundingClientRect();
		const screen = new DOMRect(0, 0, document.documentElement.clientWidth, window.innerHeight);
		return {
			lines,
			inPill: within(label, pillBox),
			inHeader: within(pillBox, headerBox),
			onScreen: within(headerBox, screen) && within(label, screen),
		};
	});
}

/** Painted at a readable size, not reduced to the 1 px screen-reader box. */
async function painted(locator: Locator): Promise<boolean> {
	const box = await locator.boundingBox();
	return box !== null && box.width > 1 && box.height > 1;
}

function withinScreenWidth(locator: Locator): Promise<boolean> {
	return locator.evaluate((element) => {
		const box = element.getBoundingClientRect();
		return box.left >= 0 && box.right <= document.documentElement.clientWidth;
	});
}

test.describe("Live on a phone", { tag: "@desktop-only" }, () => {
	let send: (status: StatusResponse) => void;

	test.beforeEach(async ({ page }) => {
		let socket: WebSocketRoute | undefined;
		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			socket = ws;
			ws.connectToServer().onMessage((raw) => {
				if (typeof raw !== "string") return ws.send(raw);
				const value: unknown = JSON.parse(raw);
				if (!isRecord(value) || !isRecord(value.status)) return ws.send(raw);
				delete value.status.is_streaming;
				delete value.status.stream_lifecycle;
				ws.send(JSON.stringify(value));
			});
		});
		let seq = 9_000_000;
		send = (status) => {
			if (!socket) throw new Error("Missing Live control socket");
			socket.send(JSON.stringify({ status, seq: ++seq }));
		};
	});

	for (const [locale, copy] of Object.entries(COPY)) {
		test(`${locale}: the state label keeps one line in its pill; without a chip the subtitle stays`, async ({ page }) => {
			await openLive(page, locale);
			const title = page.getByRole("heading", { level: 1, name: copy["live.title"], exact: true });
			const header = page.locator("header", { has: title });
			const subtitle = header.getByText(copy["live.description"], { exact: true });

			for (const [status, label] of [
				[IDLE, copy["live.notStreaming"]],
				[LIVE, copy["live.streamingActive"]],
			] as const) {
				send(status);
				const chip = header.getByText(label, { exact: true });
				await expect(chip).toBeVisible();
				for (const viewport of [...PHONES, ...(status.is_streaming ? [SHORT_LANDSCAPE] : []), DESKTOP]) {
					await resize(page, viewport);
					const where = `${locale} ${label} at ${viewport.width}x${viewport.height}`;
					// Soft, so one run lists every failing locale, state and width.
					expect.soft(await labelLayout(chip), where).toEqual({ lines: 1, inPill: true, inHeader: true, onScreen: true });
					expect.soft(await pageOverflow(page), where).toBeLessThanOrEqual(0);
					const spoken = await header.ariaSnapshot();
					for (const text of [label, copy["live.title"], copy["live.description"]]) expect.soft(spoken, where).toContain(text);
					// On a phone the chip hides the subtitle, and confirmed live is the chip alone.
					const desktop = viewport === DESKTOP;
					expect.soft([await painted(title), await painted(subtitle)], where).toEqual([desktop || !status.is_streaming, desktop]);
				}
			}

			send({ is_streaming: false, stream_lifecycle: "reconciling" });
			const band = page.getByTestId("unconfirmed-stream-band");
			await expect(band).toBeVisible();
			for (const viewport of [...PHONES, DESKTOP]) {
				await resize(page, viewport);
				const where = `${locale} unconfirmed at ${viewport.width}x${viewport.height}`;
				await expect(header.getByText(copy["live.notStreaming"], { exact: true }), where).toHaveCount(0);
				await expect(header.getByText(copy["live.streamingActive"], { exact: true }), where).toHaveCount(0);
				expect.soft([await painted(title), await painted(subtitle)], where).toEqual([true, true]);
				expect.soft(await withinScreenWidth(subtitle), where).toBe(true);
				await expect(band, where).toBeVisible();
				expect.soft(await pageOverflow(page), where).toBeLessThanOrEqual(0);
			}
		});
	}

	// Portuguese wraps the row at 320 px; English never does.
	for (const locale of ["en", "pt-BR"] as const) {
		const copy = COPY[locale];
		test(`${locale}: the live preview title and toggle fit a phone, and the toggle is a 44 px target that leaves the summary its taps`, async ({ page }) => {
			await openLive(page, locale);
			send(LIVE);
			const disclosure = page.getByTestId("live-cockpit").getByTestId("preview-disclosure");
			// Opened by default at the 1280 px the cockpit mounts at.
			await expect(disclosure).toHaveJSProperty("open", true);
			const preview = disclosure.getByTestId("preview");
			const heading = preview.getByRole("heading", { level: 2, name: copy["live.preview.title"], exact: true });
			const toggle = preview.getByTestId("preview-toggle");
			await expect(toggle).toHaveText(copy["live.preview.start"]);
			for (const viewport of PHONES) {
				await resize(page, viewport);
				const where = `${locale} preview at ${viewport.width}x${viewport.height}`;
				expect.soft([await withinScreenWidth(heading), await withinScreenWidth(toggle)], where).toEqual([true, true]);
				expect.soft(await pageOverflow(page), where).toBeLessThanOrEqual(0);
				const [target] = await measureHitAreas(page, '[data-testid="live-cockpit"] [data-testid="preview-toggle"]');
				expect.soft(Math.min(target?.hitWidth ?? 0, target?.hitHeight ?? 0), where).toBeGreaterThanOrEqual(44);
				// A tap 21 px off centre on either axis lands on the toggle; the heading beside
				// it and the summary 1 px above its row keep theirs.
				const taps = await toggle.evaluate((el) => {
					el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
					const box = el.getBoundingClientRect();
					const row = el.parentElement;
					const title = row?.querySelector("h2")?.getBoundingClientRect();
					const summary = el.closest("details")?.querySelector("summary");
					const lands = (x: number, y: number) => el.contains(document.elementFromPoint(x, y));
					const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
					return {
						offCentre: [lands(x, y - 21), lands(x, y + 21), lands(x - 21, y), lands(x + 21, y)],
						heading: title ? lands(title.left + title.width / 2, title.top + title.height / 2) : null,
						summary: row && summary ? summary.contains(document.elementFromPoint(x, row.getBoundingClientRect().top - 1)) : null,
					};
				});
				expect.soft(taps, where).toEqual({ offCentre: [true, true, true, true], heading: false, summary: true });
			}
		});
	}

	test("crossing to a phone width does not move the page after it is scrolled past the preview row", async ({ page }) => {
		await openLive(page, "en");
		send(IDLE);
		await expect(page.getByTestId("preview-toggle")).toBeVisible();
		// Scrolls in the resize's own frame, then waits out every transition the resize started.
		const moved = await page.evaluateHandle(() => ({
			scroll: new Promise<{ rowBottom: number; put: number; settled: number }>((resolve, reject) => {
				addEventListener(
					"resize",
					() =>
						requestAnimationFrame(async () => {
							const row = document.querySelector('[data-testid="preview-toggle"]')?.parentElement;
							if (!row) return reject(new Error("Missing preview row"));
							window.scrollTo(0, Math.ceil(window.scrollY + row.getBoundingClientRect().bottom + 1));
							const put = window.scrollY;
							const rowBottom = row.getBoundingClientRect().bottom;
							const transitions = document.getAnimations().filter((animation) => animation instanceof CSSTransition);
							await Promise.allSettled(transitions.map((transition) => transition.finished));
							requestAnimationFrame(() => resolve({ rowBottom, put, settled: window.scrollY }));
						}),
					{ once: true },
				);
			}),
		}));
		await resize(page, { width: 390, height: 800 });
		const { rowBottom, put, settled } = await moved.evaluate(({ scroll }) => scroll);
		expect(rowBottom).toBeLessThanOrEqual(0);
		expect(settled).toBe(put);
	});
});
