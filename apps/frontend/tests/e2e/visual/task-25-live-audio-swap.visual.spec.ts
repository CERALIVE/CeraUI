import { expect, test } from "../fixtures/index.js";
import {
	ensureAuthenticated,
	evidencePath,
	navigateTo,
} from "../helpers/index.js";

/**
 * Task 25 — once the engine advertises live audio, the streaming audio is a real,
 * enabled control, while still-deferred roadmap items stay coming-soon.
 *
 * Runs on `caps-full`, whose mock engine advertises `audio_live_switch` and
 * `audio_mix`. Under the Live screen contract (docs/agents/live-screen.md) the
 * live audio control is the Audio card's mixer: on a mix session each strip's
 * level stays live, while switches and track chips wait for the next start.
 * Captures two repo-local evidence PNGs against the REAL frontend + mock backend:
 *   • task-25-deferred-remain.png — the idle roadmap still showing the calm
 *     mode-fallback pill (no capability flag → G2), and none for the resolved PiP.
 *   • task-25-live-audio-swap.png — the live Audio card with an enabled level
 *     control and no coming-soon marker.
 */

test.use({ backendScenario: "caps-full" });

const MAIN = "RØDE AI-Micro";
const SECOND = "Elgato Wave:3";

test.describe("@visual Task 25 — live audio switch enabled + deferred remain", () => {
	test(
		"@visual live audio is an enabled mixer control; deferred roadmap stays coming-soon",
		{ tag: "@visual" },
		async ({ page, backendRpc }, testInfo) => {
			test.skip(
				testInfo.project.name !== "desktop",
				"single-layout visual proof",
			);

			// A main input plus a second one on Track 2, so Start launches a mix
			// session; a capture source and a destination, so Start is ready.
			await backendRpc.call(["streaming", "setConfig"], {
				asrc: MAIN,
				source: "usb",
				srtla_addr: "127.0.0.1",
				srtla_port: 5000,
			});
			await backendRpc.call(["streaming", "setConfig"], {
				audio_inputs: [
					{ id: MAIN, tracks: [1], gain_db: 0, mute: false, delay_ms: 0 },
					{ id: SECOND, tracks: [2], gain_db: 0, mute: false, delay_ms: 0 },
				],
			});
			await page.goto("/");
			await ensureAuthenticated(page);
			await navigateTo(page, "live");

			// Still-deferred roadmap items keep their calm coming-soon pills even with
			// live audio on — they have no capability flag (G2). The roadmap renders
			// in the idle cockpit only, so it is checked before Start.
			const roadmap = page.getByTestId("live-roadmap");
			await expect(roadmap).toBeVisible({ timeout: 20_000 });
			await roadmap.locator("summary").click();
			await expect(
				roadmap.locator('[data-comingsoon="TD-mode-fallback"]'),
			).toBeVisible();
			await expect(roadmap.locator('[data-comingsoon="TD-pip"]')).toHaveCount(0);
			await roadmap.screenshot({
				path: evidencePath("task-25-deferred-remain.png"),
			});

			await page
				.getByTestId("live-bar")
				.getByRole("button", { name: "Start stream" })
				.click();
			const card = page.getByTestId("live-cockpit").getByTestId("audio-card");
			await expect(card.getByTestId("audio-mixer-next-start")).toBeVisible({
				timeout: 15_000,
			});
			await expect(
				card.getByTestId(`audio-strip-gain-${MAIN}`).getByRole("slider"),
			).toBeEnabled();
			await expect(card.locator("[data-comingsoon]")).toHaveCount(0);
			await card.screenshot({
				path: evidencePath("task-25-live-audio-swap.png"),
			});
			await page
				.getByTestId("live-bar")
				.getByRole("button", { name: "Stop stream" })
				.click();
		},
	);
});
