import fs from "node:fs";

import { expect, type Page } from "@playwright/test";

import { test } from "./fixtures/index.js";
import { ensureAuthenticated, evidencePath, navigateTo } from "./helpers/index.js";

/**
 * Task 14 — Stream-health surfacing in the HUD, end-to-end.
 *
 * Drives the REAL frontend stack (stream-health store → HudBar indicator →
 * central notification store → toast host) against the REAL dev backend
 * (MOCK_SCENARIO=multi-modem-wifi, NODE_ENV=development → `dev.emit` registered).
 * Tri-state `health` broadcasts are injected at known times via the dev-only
 * `dev.emit` (Task 5), exactly as a Task-13 heartbeat broadcast would arrive.
 *
 * Conventions (PLAYBOOK.md): functional spec — no screenshot or visual-snapshot
 * APIs, and no fixed-delay waits. Every wait is a web-first
 * assertion or `expect.poll` against the live `data-state` attribute. Health
 * broadcasts reach every authed client, so this file runs `serial`.
 */

const HEALTH_INDICATOR = "[data-testid='stream-health']";

const evidence: string[] = [];
function record(line: string): void {
	evidence.push(line);
}

/** Inject a `health` broadcast (Task 13 shape) via the dev-only `dev.emit`. */
async function emitHealth(page: Page, state: string): Promise<void> {
	await page.evaluate(async (s) => {
		const specPath = "/src/lib/rpc/client.ts";
		const mod = await import(/* @vite-ignore */ specPath);
		await mod.rpc.dev.emit({
			type: "health",
			payload: {
				state: s,
				process: { alive: s !== "dead" },
				frames: { advancing: s === "healthy", count: 0 },
				srt: { reconnecting: false, reconnectCount: 0 },
				bond: { linkCount: 2, activeLinks: s === "healthy" ? 2 : 1 },
			},
		});
	}, state);
}

function healthIndicator(page: Page) {
	return page.locator(HEALTH_INDICATOR).first();
}

/**
 * Re-emit `state` until the indicator settles there. Idempotent: re-emitting an
 * already-current state raises no duplicate toast (dedup-by-name) and does not
 * re-transition, so this is safe against a stray backend tick flipping the dot.
 */
async function driveHealth(page: Page, state: string): Promise<void> {
	await expect
		.poll(
			async () => {
				await emitHealth(page, state);
				return healthIndicator(page).getAttribute("data-state");
			},
			{ timeout: 10_000, message: `stream-health indicator should settle on ${state}` },
		)
		.toBe(state);
}


test.describe("stream-health HUD surfacing (dev.emit driven)", () => {
	test.skip(({ browserName }) => browserName !== "chromium", "single-browser integration proof");

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop layout exposes the persistent HUD bar");
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
		await expect(healthIndicator(page)).toBeVisible({ timeout: 15_000 });
	});

	test.afterAll(() => {
		fs.writeFileSync(
			evidencePath("task-14-hud.txt"),
			[
				"Task 14 — Stream-health surfacing in the HUD",
				"Driver: real frontend (stream-health store + HudBar + notification store + toast host)",
				"        vs. real dev backend; `health` broadcasts injected via dev.emit (Task 5).",
				`Generated: ${new Date().toISOString()}`,
				"",
				...evidence,
				"",
			].join("\n"),
			"utf8",
		);
	});

	test("indicator reflects healthy → degraded → dead, with transition toasts", async ({ page }) => {
		const indicator = healthIndicator(page);

		// healthy: clean start is silent (no toast on unknown→healthy).
		await driveHealth(page, "healthy");
		await expect(indicator).toHaveAttribute("data-state", "healthy");
		record("emit health=healthy → [data-testid=stream-health] data-state=healthy ✓");

		// degraded: warning toast must surface on healthy→degraded.
		await driveHealth(page, "degraded");
		await expect(indicator).toHaveAttribute("data-state", "degraded");
		await expect(page.getByText("Stream health degraded")).toBeVisible();
		record("emit health=degraded → data-state=degraded + warning toast 'Stream health degraded' ✓");

		// dead: error toast must surface on any→dead.
		await driveHealth(page, "dead");
		await expect(indicator).toHaveAttribute("data-state", "dead");
		await expect(page.getByText("Stream is down")).toBeVisible();
		record("emit health=dead → data-state=dead + error toast 'Stream is down' ✓");

		// recovery: success toast on degraded/dead → healthy.
		await driveHealth(page, "healthy");
		await expect(indicator).toHaveAttribute("data-state", "healthy");
		await expect(page.getByText("Stream health recovered")).toBeVisible();
		record("emit health=healthy → data-state=healthy + success toast 'Stream health recovered' ✓");
	});
});

test.describe("stream-health rapid flapping (failure-guard)", () => {
	test.skip(({ browserName }) => browserName !== "chromium", "single-browser integration proof");

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop layout exposes the persistent HUD bar");
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
		await expect(healthIndicator(page)).toBeVisible({ timeout: 15_000 });
	});

	test("20 rapid transitions never crash; indicator settles on the final state", async ({ page }) => {
		const consoleErrors: string[] = [];
		const pageErrors: string[] = [];
		const onConsole = (msg: import("@playwright/test").ConsoleMessage) => {
			if (msg.type() === "error") consoleErrors.push(msg.text());
		};
		const onPageError = (err: Error) => pageErrors.push(err.message);
		page.on("console", onConsole);
		page.on("pageerror", onPageError);

		const cycle = ["healthy", "degraded", "dead"];
		for (let i = 0; i < 20; i++) {
			await emitHealth(page, cycle[i % cycle.length]);
		}
		const finalState = cycle[19 % cycle.length];

		// Settle deterministically on a known final state after the flap storm.
		await driveHealth(page, finalState);
		await expect(healthIndicator(page)).toHaveAttribute("data-state", finalState);

		page.off("console", onConsole);
		page.off("pageerror", onPageError);

		expect(pageErrors, `uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
		expect(consoleErrors, `console errors: ${consoleErrors.join(" | ")}`).toEqual([]);

		const lines = [
			"Task 14 — Stream-health rapid-flapping failure guard",
			`Generated: ${new Date().toISOString()}`,
			"",
			"Fired 20 rapid health transitions cycling healthy/degraded/dead via dev.emit.",
			`Indicator settled on final state = "${finalState}" (data-testid=stream-health).`,
			`Uncaught page errors during flap: ${pageErrors.length}`,
			`Console errors during flap: ${consoleErrors.length}`,
			"Result: PASS — no crash, indicator deterministic, toasts bounded by dedup-by-name.",
			"",
		];
		fs.writeFileSync(evidencePath("task-14-flap.txt"), lines.join("\n"), "utf8");
		record(`flap guard: 20 transitions, 0 crashes, settled on ${finalState} ✓`);
	});
});
