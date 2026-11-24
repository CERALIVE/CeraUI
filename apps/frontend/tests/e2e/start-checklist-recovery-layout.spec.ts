import type { Locator, Page } from "@playwright/test";

import ar from "../../../../packages/i18n/messages/ar.json" with { type: "json" };
import en from "../../../../packages/i18n/messages/en.json" with { type: "json" };
import es from "../../../../packages/i18n/messages/es.json" with { type: "json" };
import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

const catalogs = { en, es, ar };
const viewports = [
	{ width: 360, height: 240 },
	{ width: 320, height: 568 },
	{ width: 800, height: 480 },
] as const;
const modes = ["light", "dark"] as const;
const locales = ["en", "es", "ar"] as const;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFrame(raw: string | Buffer): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(raw.toString());
		return record(value) ? value : {};
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		return {};
	}
}

async function arrangeLive(page: Page, initial: "ready" | "blocked") {
	let stage: "ready" | "refused" | "blocked" = initial;
	const noDestination = {
		srtla_addr: "",
		relay_server: "",
		selected_ingest_endpoint: "",
	};
	const update = {
		schema: 1,
		phase: "committing",
		progress: { percent: 64, etaSeconds: 150 },
		failure_reason: null,
		cellular_override_id: null,
	};
	let push: (frame: object) => void = () => {
		throw new Error("Expected a connected device socket");
	};
	await page.routeWebSocket((url) => url.pathname === "/ws", (ws) => {
		const server = ws.connectToServer();
		push = (frame) => ws.send(JSON.stringify(frame));
		ws.onMessage((raw) => {
			const request = parseFrame(raw);
			if (
				stage === "ready" &&
				Array.isArray(request.path) &&
				request.path.join(".") === "streaming.start"
			) {
				const attemptId = "short-viewport-refusal";
				push({
					id: request.id,
					result: {
						result: "failed",
						success: false,
						attemptId,
						failure: {
							attemptId,
							phase: "connect",
							class: "engine_unavailable",
							retriable: true,
						},
					},
				});
			} else {
				server.send(raw);
			}
		});
		server.onMessage((raw) => {
			const frame = parseFrame(raw);
			if (record(frame.config)) {
				Object.assign(frame.config, {
					source: stage === "blocked" ? "e2e-unavailable" : "usb",
					pipeline: "libuvch264",
					srtla_addr: "127.0.0.1",
					srtla_port: 5000,
					relay_server: "",
					selected_ingest_endpoint: "",
					...(stage !== "ready" && noDestination),
				});
			} else if (record(frame.status) && stage === "blocked") {
				frame.status.update_orchestrator = update;
			} else if (record(frame.result) && frame.result.orchestrator && stage === "blocked") {
				frame.result.orchestrator = update;
			} else if (stage !== "ready" && "netif" in frame) {
				frame.netif = {};
			} else {
				ws.send(raw);
				return;
			}
			push(frame);
		});
	});
	await page.goto("/");
	await ensureAuthenticated(page);
	await navigateTo(page, "live");
	return () => {
		stage = "refused";
		push({ config: noDestination, netif: {} });
	};
}

async function hit(control: Locator) {
	return control.evaluate((node) => {
		const { x, y, width, height } = node.getBoundingClientRect();
		const target = document.elementFromPoint(x + width / 2, y + height / 2);
		return { hit: node.contains(target), x, y, target: target?.tagName };
	});
}

async function headingClearsHeader(heading: Locator) {
	return heading.evaluate((node) => {
		const { left, top, width, height } = node.getBoundingClientRect();
		const x = left + width / 2;
		return [top + 1, top + height / 2].every((y) =>
			node.contains(document.elementFromPoint(x, y)),
		);
	});
}

async function expectReachable(control: Locator, label: string) {
	await control.evaluate((node) => node.scrollIntoView({ block: "center" }));
	await expect.soft.poll(() => hit(control), { message: label, timeout: 1000 })
		.toMatchObject({ hit: true });
}

for (const viewport of viewports) {
	for (const locale of locales) {
		for (const theme of modes) {
			const labels = catalogs[locale];
			const hasTouch = viewport.width < 640;
			test.describe(`${viewport.width}×${viewport.height} ${locale} ${theme} @mobile-only`, () => {
				test.use({ viewport, colorScheme: theme, hasTouch, reducedMotion: "reduce" });
				test.beforeEach(async ({ page }) => {
					await page.addInitScript(({ locale, theme }) => {
						localStorage.setItem("locale", JSON.stringify({ code: locale }));
						localStorage.setItem("theme", JSON.stringify(theme));
						localStorage.setItem("mode-watcher-mode", theme);
					}, { locale, theme });
				});

				test("the operator can tap Show all and reach both sets of actions", async ({ page }) => {
					const block = await arrangeLive(page, "ready");
					const bar = page.getByTestId("live-bar");
					const start = bar.getByRole("button", { name: labels["live.startStream"], exact: true });
					if (hasTouch) await start.tap();
					else await start.click();
					const refusal = page.locator(".start-refusal-toast");
					const actions = [
						labels["live.startFailure.action.tryAgain"],
						labels["notifications.viewLogs"],
						labels["a11y.close"],
					].map((name) => refusal.getByRole("button", { name, exact: true }));
					for (const action of actions) await expectReachable(action, "Recovery before opening");

					block();
					await expect(start).toBeDisabled();
					const show = bar.getByRole("button", { name: labels["live.bar.showAll"], exact: true });
					await expectReachable(show, "Show all tap");
					// On a broken layout use the real keyboard path to diagnose both surfaces.
					if (!(await hit(show)).hit) await show.press("Enter");
					else if (hasTouch) await show.tap();
					else await show.click();
					const panel = bar.getByRole("region", { name: labels["live.bar.beforeLive"] });
					const heading = panel.getByRole("heading");
					await expect(heading).toBeFocused();
					await expect.soft.poll(() => hit(heading), { message: "Focused checklist heading", timeout: 1000 })
						.toMatchObject({ hit: true });
					const fixes = panel.getByRole("button");
					await expect(fixes).toHaveText([
						labels["live.goLive.fix.goNetwork"],
						labels["live.goLive.fix.openServer"],
					]);
					const close = bar.getByRole("button", { name: labels["a11y.close"], exact: true });
					const [network, destination] = await fixes.all();
					const [retry, logs, dismiss] = actions;
					if (!network || !destination || !retry || !logs || !dismiss) {
						throw new Error("Expected all six recovery and checklist controls");
					}
					for (const [label, control] of [
						["Checklist Network", network],
						["Checklist Destination", destination],
						["Checklist Close", close],
						["Refusal Try again", retry],
						["Refusal View logs", logs],
						["Refusal Close", dismiss],
					] as const) {
						await expectReachable(control, label);
					}
					await expect(panel).toBeVisible();
					await expect(refusal).toBeVisible();

					// Traverse from the opened checklist, without test-driven scrolling.
					await destination.focus();
					await page.keyboard.press("Escape");
					await expect(show).toBeFocused();
					await expect.soft.poll(() => hit(show), { message: "Returned Show all focus", timeout: 1000 })
						.toMatchObject({ hit: true });
				});

				if (viewport.width === 320) {
					test("keyboard focus clears sticky chrome with four blockers", async ({ page }) => {
						await arrangeLive(page, "blocked");
						const bar = page.getByTestId("live-bar");
						const show = bar.getByRole("button", { name: labels["live.bar.showAll"], exact: true });
						await show.press("Enter");
						const panel = bar.getByRole("region", { name: labels["live.bar.beforeLive"] });
						const heading = panel.getByRole("heading");
						await expect(panel.getByRole("listitem")).toHaveCount(4);
						await expect(heading).toBeFocused();
						await expect.soft.poll(() => headingClearsHeader(heading), {
							message: "Focused heading below sticky chrome",
							timeout: 1000,
						}).toBe(true);
						const fixes = panel.getByRole("button");
						await expect(fixes).toHaveText([
							labels["live.goLive.fix.openSource"],
							labels["live.goLive.fix.goNetwork"],
							labels["live.goLive.fix.openServer"],
						]);
						for (const fix of await fixes.all()) {
							await page.keyboard.press("Tab");
							await expect(fix).toBeFocused();
							await expect.soft.poll(() => hit(fix), { message: "Focused checklist fix", timeout: 1000 })
								.toMatchObject({ hit: true });
						}
						await page.keyboard.press("Escape");
						await expect(show).toBeFocused();
						await expectReachable(show, "Focus returned to Show all");
					});
				}
			});
		}
	}
}
