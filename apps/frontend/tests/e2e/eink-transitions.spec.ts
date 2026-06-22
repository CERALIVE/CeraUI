import fs from "node:fs";

import type { Locator } from "@playwright/test";

import { expect, type Page, test } from "./fixtures/index.js";
import { ensureAuthenticated, evidencePath, navigateTo } from "./helpers/index.js";

/**
 * T10 — JS-driven Svelte transitions must freeze under the e-ink display profile.
 *
 * The app already freezes CSS motion under e-ink via
 *   `[data-display='eink'] * { transition/animation: none !important }`
 * (app.css). That `!important` rule stops DECLARATIVE CSS transitions/animations
 * — but Svelte 5's `transition:`/`in:`/`out:` directives (slide/fade/fly) compile
 * to the Web Animations API (`Element.prototype.animate(...)`), which runs OUTSIDE
 * CSS and is therefore untouched by the freeze. Those JS animations smear on
 * e-paper.
 *
 * This spec proves the gate against the REAL rendered app by monkeypatching
 * `Element.prototype.animate` (via addInitScript, before any app code loads) and
 * counting the transition-shaped animations (transform/opacity/height/overflow)
 * each user action starts:
 *
 *   - under `?display=eink`: opening the modem dialog + toggling roaming (a
 *     `transition:slide`) and navigating between destinations (`in/out:fly` +
 *     `in/out:fade`) must start ZERO JS animations.
 *   - under `?display=lcd`: the SAME actions must still start the animation
 *     (> 0), proving the gate is profile-scoped and never regresses lcd motion.
 *
 * The probe is deterministic (it records the `.animate()` call itself, so there
 * is no animation-frame race) — no fixed-delay waits, no screenshots.
 */

const TRANSITION_PROPS = ["transform", "opacity", "height", "overflow"] as const;

/**
 * Installed before app load. Wraps `Element.prototype.animate` and records the
 * animated CSS properties of every call, so a test can count the JS transitions
 * a single action started. `reset()` zeroes the window so each probed action is
 * isolated; `transitionCount()` counts only motion-shaped animations (the props
 * slide/fade/fly animate), ignoring any incidental non-motion WAAPI call.
 */
function installAnimateProbe(props: readonly string[]): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser-side probe glue.
	const w = window as any;
	if (w.__einkAnimateProbe) return;

	const real = Element.prototype.animate;
	const probe = {
		records: [] as string[][],
		reset() {
			probe.records = [];
		},
		transitionCount() {
			return probe.records.filter((recordedProps) =>
				recordedProps.some((p) => props.includes(p)),
			).length;
		},
	};
	w.__einkAnimateProbe = probe;

	// biome-ignore lint/suspicious/noExplicitAny: native animate() signature.
	Element.prototype.animate = function (this: Element, keyframes: any, options?: any) {
		try {
			const frames = Array.isArray(keyframes)
				? keyframes
				: keyframes
					? [keyframes]
					: [];
			const seen = new Set<string>();
			for (const frame of frames) {
				if (frame && typeof frame === "object") {
					for (const key of Object.keys(frame)) {
						if (key !== "offset" && key !== "easing" && key !== "composite") {
							seen.add(key);
						}
					}
				}
			}
			probe.records.push([...seen]);
		} catch {
			/* never let the probe break a real animation */
		}
		return real.call(this, keyframes, options);
	};
}

function resetProbe(page: Page): Promise<void> {
	return page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: window probe access.
		(window as any).__einkAnimateProbe.reset();
	});
}

function transitionCount(page: Page): Promise<number> {
	return page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: window probe access.
		return (window as any).__einkAnimateProbe.transitionCount() as number;
	});
}

// Drive a bits-ui switch to a known aria-checked state. Pointer clicks can be
// dropped while the dialog plays its CSS entrance, so retry — clicking only when
// the current state differs — until aria-checked converges on the target.
function driveSwitch(toggle: Locator, want: boolean): Promise<void> {
	const target = want ? "true" : "false";
	return expect(async () => {
		if ((await toggle.getAttribute("aria-checked")) !== target) {
			await toggle.click();
		}
		expect(await toggle.getAttribute("aria-checked")).toBe(target);
	}).toPass({ timeout: 8000 });
}

const evidence: string[] = [];
const record = (line: string) => evidence.push(line);

test.describe("e-ink freezes JS-driven Svelte transitions (T10)", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-engine motion-freeze proof (cage/Chromium parity)",
	);

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the modem dialog + nav rail",
		);
		await page.addInitScript(installAnimateProbe, TRANSITION_PROPS);
	});

	test.afterAll(() => {
		fs.writeFileSync(
			evidencePath("task-10-eink-transitions.txt"),
			[
				"T10 — JS-driven Svelte transition freeze under e-ink",
				"Probe: Element.prototype.animate() wrapped before app load; counts",
				"       transition-shaped (transform/opacity/height/overflow) WAAPI calls.",
				`Generated: ${new Date().toISOString()}`,
				"",
				...evidence,
				"",
			].join("\n"),
			"utf8",
		);
	});

	// ── Modem dialog: transition:slide on the roaming reveal ──────────────────
	// bits-ui mounts dialog content without enabling Svelte intros, so a block
	// present at open does not animate — the slide only fires on a runtime
	// `{#if formData.roaming}` false→true toggle. The roaming switch (off by
	// default, enabled because the mock modem has a SIM) is that toggle; the probe
	// then sees the slide on lcd and nothing on e-ink. The toggle is driven by
	// keyboard (focus + Space) so it never races pointer interception during the
	// dialog's CSS entrance.
	for (const profile of ["eink", "lcd"] as const) {
		const expectsMotion = profile === "lcd";

		test(`modem dialog roaming reveal ${expectsMotion ? "animates" : "is frozen"} under ?display=${profile}`, async ({
			page,
		}) => {
			await page.goto(`/?display=${profile}`);
			await ensureAuthenticated(page);
			await navigateTo(page, "network");

			await page.getByTestId("open-modem-config-dialog").first().click();
			const dialog = page.getByRole("dialog");
			await expect(dialog).toBeVisible();

			const roaming = dialog.getByRole("switch", { name: /Allow Roaming/i });
			const scan = dialog.getByTestId("modem-scan-button");
			await expect(roaming).toBeEnabled();

			// The roaming section's seeded state is unreliable (the shared mock
			// backend may report roaming on), and bits-ui plays no intro for a block
			// already present at dialog mount. So force roaming OFF and let the
			// section fully unmount FIRST — then the toggle below is a guaranteed
			// fresh `{#if}` false→true entry whose slide intro we can observe.
			await driveSwitch(roaming, false);
			await expect(scan).toBeHidden();

			await resetProbe(page);
			await driveSwitch(roaming, true);

			// The revealed section must render in BOTH profiles: the e-ink gate
			// freezes the slide's MOTION, it must not suppress the element itself.
			await expect(scan).toBeVisible();

			if (expectsMotion) {
				await expect
					.poll(() => transitionCount(page), {
						timeout: 5000,
						message: "lcd roaming reveal must start a JS slide animation",
					})
					.toBeGreaterThan(0);
				record(
					`?display=lcd  · modem roaming reveal → JS slide animation started (count=${await transitionCount(page)}) ✓`,
				);
			} else {
				const count = await transitionCount(page);
				record(
					`?display=eink · modem roaming reveal → JS animations started = ${count} (expect 0) ${count === 0 ? "✓" : "✗"}`,
				);
				expect(count).toBe(0);
			}
		});
	}

	// ── NavigationRenderer: in/out:fly + in/out:fade are e-ink gated ──────────
	// NavigationRenderer's fly/fade are latent in normal operation (the content
	// wrapper never remounts on a tab switch, and isNavigationTransitioning /
	// navigationError are never raised), so navigating cannot drive them on lcd
	// either — the fade/fly lcd-retention is proven by the unit suite
	// (src/tests/eink-gated-transitions.test.ts). This case is the user-flow
	// forward guard: navigating under e-ink must start zero JS animations, so the
	// gate holds even if a future change wires those transitions up.
	test("destination navigation starts zero JS animations under ?display=eink", async ({
		page,
	}) => {
		await page.goto("/?display=eink");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");

		await resetProbe(page);
		await navigateTo(page, "network");
		await navigateTo(page, "settings");
		await navigateTo(page, "live");

		const count = await transitionCount(page);
		record(
			`?display=eink · live→network→settings→live nav → JS animations started = ${count} (expect 0) ${count === 0 ? "✓" : "✗"}`,
		);
		expect(count).toBe(0);
	});
});
