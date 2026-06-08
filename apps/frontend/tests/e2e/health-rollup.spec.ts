import fs from "node:fs";

import { expect, type Page } from "@playwright/test";

import { test } from "./fixtures/index.js";
import { ensureAuthenticated, evidencePath, navigateTo } from "./helpers/index.js";

/**
 * Task 15 — Stream-health ROLLUP surfacing in the HUD, end-to-end.
 *
 * Builds on Task 14 (the tri-state dot). Proves the per-subsystem breakdown
 * (process / frames / SRT / bond) the backend already rolls up is surfaced in
 * the expandable HUD sheet with a tooltip explaining each state, that the dead
 * state carries a non-color cue (icon SHAPE + text, legible in mono), and that
 * under the e-ink profile the rollup is FROZEN until a manual display refresh.
 *
 * Driver: real frontend (stream-health store → HudBar rollup) against the real
 * dev backend; `health` broadcasts injected via the dev-only `dev.emit` (Task 5),
 * exactly as a Task-13 heartbeat broadcast would arrive. PLAYBOOK.md: functional
 * spec — no screenshots, no fixed delays; every wait is a web-first assertion.
 */

const HEALTH_INDICATOR = "[data-testid='stream-health']";

type HealthState = "healthy" | "degraded" | "dead";

/** Inject a `health` broadcast (Task 13 shape) via the dev-only `dev.emit`. */
async function emitHealth(page: Page, state: HealthState): Promise<void> {
	await page.evaluate(async (s) => {
		// Path via a variable so tsc treats it as a runtime (vite-resolved) import,
		// not a literal module specifier (mirrors stream-health.spec.ts, Task 14).
		const clientPath = "/src/lib/rpc/client.ts";
		const mod = await import(clientPath);
		await mod.rpc.dev.emit({
			type: "health",
			payload: {
				state: s,
				process: { alive: s !== "dead" },
				frames: { advancing: s === "healthy", count: s === "dead" ? 0 : 120 },
				srt: { reconnecting: s === "degraded", reconnectCount: s === "degraded" ? 1 : 0 },
				bond: { linkCount: 2, activeLinks: s === "healthy" ? 2 : s === "degraded" ? 1 : 0 },
			},
		});
	}, state);
}

/** Re-emit until the (always-live) HUD dot settles, confirming the broadcast landed. */
async function driveHealth(page: Page, state: HealthState): Promise<void> {
	await expect
		.poll(
			async () => {
				await emitHealth(page, state);
				return page.locator(HEALTH_INDICATOR).first().getAttribute("data-state");
			},
			{ timeout: 10_000, message: `health dot should settle on ${state}` },
		)
		.toBe(state);
}

/** Invoke the canonical manual display refresh (the exact call the e-ink button fires). */
async function manualRefresh(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const refreshPath = "/src/lib/stores/display-refresh.svelte.ts";
		const mod = await import(refreshPath);
		mod.requestDisplayRefresh();
	});
}

async function openHud(page: Page): Promise<void> {
	await page.locator("[data-hud-region]").first().click();
	await expect(page.getByRole("dialog", { name: "Status" })).toBeVisible();
}

const evidence: string[] = [];
function record(line: string): void {
	evidence.push(line);
	console.log(`[task-15] ${line}`);
}

test.describe.configure({ mode: "serial" });

test.describe("stream-health rollup + tooltip (dev.emit driven)", () => {
	test.skip(({ browserName }) => browserName !== "chromium", "single-browser integration proof");

	test.beforeEach(async ({}, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop layout exposes the persistent HUD bar");
	});

	test.afterAll(() => {
		fs.writeFileSync(
			evidencePath("task-15-health.txt"),
			[
				"Task 15 — Stream-health rollup + tooltip + e-ink freeze in the HUD",
				"Driver: real frontend (stream-health store + HudBar rollup) vs. real dev backend;",
				"        `health` broadcasts injected via dev.emit (Task 5).",
				`Generated: ${new Date().toISOString()}`,
				"",
				...evidence,
				"",
			].join("\n"),
			"utf8",
		);
	});

	test("degraded health → rollup shows process/frames/SRT/bond + tooltip explains each state", async ({
		page,
	}) => {
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
		await expect(page.locator(HEALTH_INDICATOR).first()).toBeVisible({ timeout: 15_000 });

		await driveHealth(page, "degraded");
		await openHud(page);

		const detail = page.getByTestId("stream-health-detail");
		await expect(detail).toHaveAttribute("data-state", "degraded");
		await expect(page.getByTestId("stream-health-state")).toContainText("Degraded");
		record("rollup header reflects degraded (data-state=degraded, label 'Degraded') ✓");

		// Per-subsystem breakdown — process/frames/SRT/bond all surfaced.
		const rollup = page.getByTestId("stream-health-rollup");
		await expect(rollup).toBeVisible();
		await expect(page.getByTestId("health-process")).toContainText("Running");
		await expect(page.getByTestId("health-frames")).toContainText("Stalled");
		await expect(page.getByTestId("health-srt")).toContainText("Reconnecting");
		await expect(page.getByTestId("health-bond")).toContainText("1/2");
		record("breakdown: Process=Running · Frames=Stalled · SRT=Reconnecting · Bond=1/2 ✓");

		// Tooltip explains each state — focus the info trigger, assert the copy.
		await page.getByTestId("stream-health-info").focus();
		await expect(page.getByText("frames stalled or some bonded links")).toBeVisible();
		await expect(page.getByText("Process running, frames advancing")).toBeVisible();
		await expect(page.getByText("Encoder process not running")).toBeVisible();
		record("tooltip explains healthy / degraded / dead on focus of the info control ✓");
	});

	test("e-ink profile freezes the rollup until a manual refresh", async ({ page }) => {
		await page.goto("/?display=eink");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
		await expect(page.locator(HEALTH_INDICATOR).first()).toBeVisible({ timeout: 15_000 });

		// Seed healthy and pull it into the frozen snapshot via a manual refresh.
		await driveHealth(page, "healthy");
		await manualRefresh(page);
		await openHud(page);
		await expect(page.getByTestId("stream-health-detail")).toHaveAttribute("data-state", "healthy");
		record("eink: after refresh the frozen rollup shows healthy ✓");

		// New broadcast arrives: the live dot flips, but the FROZEN rollup must not.
		await driveHealth(page, "degraded");
		await expect(page.locator(HEALTH_INDICATOR).first()).toHaveAttribute("data-state", "degraded");
		await expect(page.getByTestId("stream-health-detail")).toHaveAttribute("data-state", "healthy");
		await expect(page.getByTestId("health-bond")).toContainText("2/2");
		record("eink: live dot=degraded but frozen rollup HELD at healthy (Bond 2/2) — no auto-repaint ✓");

		// Manual refresh is the single release path: now the rollup catches up.
		await manualRefresh(page);
		await expect(page.getByTestId("stream-health-detail")).toHaveAttribute("data-state", "degraded");
		await expect(page.getByTestId("health-bond")).toContainText("1/2");
		record("eink: manual refresh releases the freeze → rollup updates to degraded (Bond 1/2) ✓");
	});
});

test.describe("stream-health dead-state cue (non-color, mono-legible)", () => {
	test.skip(({ browserName }) => browserName !== "chromium", "single-browser integration proof");

	test("dead state carries an icon + text cue, not color alone", async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop layout exposes the persistent HUD bar");

		// `mono` profile drops color to a single ink — the cue must survive it.
		await page.goto("/?display=mono");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
		await expect(page.locator(HEALTH_INDICATOR).first()).toBeVisible({ timeout: 15_000 });

		await driveHealth(page, "dead");
		await manualRefresh(page);
		await page.locator("[data-hud-region]").first().click();
		await expect(page.getByRole("dialog", { name: "Status" })).toBeVisible();

		const stateCell = page.getByTestId("stream-health-state");
		await expect(page.getByTestId("stream-health-detail")).toHaveAttribute("data-state", "dead");
		// Text cue: the literal word, not just a red swatch.
		await expect(stateCell).toContainText("Dead");
		// Icon cue: a rendered glyph (shape), independent of color.
		await expect(stateCell.locator("svg")).toBeVisible();
		// The process row reinforces it with its own icon + words.
		const processCell = page.getByTestId("health-process");
		await expect(processCell).toContainText("Not running");
		await expect(processCell.locator("svg")).toBeVisible();

		const hasIcon = (await stateCell.locator("svg").count()) > 0;
		const hasText = (await stateCell.textContent())?.includes("Dead") ?? false;
		const pass = hasIcon && hasText;

		fs.writeFileSync(
			evidencePath("task-15-health-dead.txt"),
			[
				"Task 15 — Dead stream-health cue: icon SHAPE + text, not color alone",
				"Driver: real frontend (stream-health store + HudBar rollup) vs. real dev backend;",
				"        health=dead injected via dev.emit (Task 5); profile = mono.",
				`Generated: ${new Date().toISOString()}`,
				"",
				"Scenario: ?display=mono (single-ink), emit health=dead, open HUD sheet.",
				`  rollup data-state            = dead`,
				`  state cell renders an <svg>  = ${hasIcon} (icon SHAPE cue)`,
				`  state cell contains 'Dead'   = ${hasText} (text cue)`,
				`  process row                  = 'Not running' + <svg>`,
				"",
				"  → The dead state is legible without color: a cross glyph plus the word",
				"    'Dead' (and 'Not running' on the process row) carry the meaning, so it",
				"    survives the mono / e-ink palette where red collapses to ink.",
				"",
				`RESULT: ${pass ? "PASS" : "FAIL"}`,
				"",
			].join("\n"),
			"utf8",
		);

		expect(pass).toBe(true);
	});
});
