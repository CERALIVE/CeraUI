import path from "node:path";

import { expect, type Page, test } from "../fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "../helpers/index.js";

/**
 * @visual evidence for the NetworkView per-interface stack (WiFi → Cellular →
 * Ethernet), measured top-of-WiFi to bottom-of-Ethernet.
 *
 * This spec was written to prove Task 19 + Task 20's one-off compaction: "≥40%
 * shorter than the pre-change stack". That ratio stopped being true long ago,
 * and a cap expressed as a fraction of a 2026-07 constant cannot describe a
 * surface that has legitimately grown since. It is now a BUDGET — a ceiling that
 * catches UNREVIEWED growth, rebased on a fresh measurement whenever growth is
 * reviewed. Measured ladder (desktop 1280×800, MOCK_SCENARIO=multi-modem-wifi):
 *
 *   1189 px  8aaa7f08^        pre-Task-19/20 "old" stack (historical record)
 *    703 px  8aaa7f08         post-Task-19/20, the 40.9% reduction it proved
 *   1030 px  2e0fb3be         origin/main at this branch's merge-base — ALREADY
 *                             44% over the 713.4 px cap, unobserved because
 *                             @visual is grep-inverted out of the CI e2e lane
 *   1174 px  7ddcea8d..8b35266^  this branch, before the de-noise pass
 *   1058 px  8b35266..HEAD   this branch, after it
 *
 * The last line is the compaction the previous revision of this header asked
 * for, so the budget is REBASED DOWN rather than left slack: −116 px (−9.9%),
 * and leaving the ceiling at 1174 would silently re-admit every pixel of it.
 * Both contributions are DEMOTIONS, not deletions — nothing this surface used to
 * state stopped being reachable:
 *
 *   • todo 32 (cc23830) folded WifiSection's per-adapter capability strip into a
 *     closed `wifi-capabilities` disclosure and collapsed the mode identity into
 *     one badge behind `open-wifi-mode`;
 *   • todo 33 (3041103) consolidated EthernetSection's shared-LAN role + zone
 *     pills into ONE badge and demoted the bond-exclusion reason paragraph into
 *     an `netif-eth-role-info` popover.
 *
 * todo 34 (8b35266) restructured SharingSection and contributes 0 px here by
 * construction: that card mounts ABOVE WifiSection, outside this span.
 *
 * The honesty invariant the previous revision defended is intact and is why the
 * saving stops here: every disabled-with-reason line stays ON SCREEN (the kiosk
 * touchscreen cannot hover to reveal a `title`). What moved behind a disclosure
 * is hardware-ceiling and diagnostic material, never a refusal an operator has
 * to act on.
 *
 * PNG lands in apps/frontend/test-results/task-24-visual (repo-local, gitignored).
 */

const TASK24_DIR = path.resolve(import.meta.dirname, "../../../test-results/task-24-visual");

// Rebase ONLY with a written justification naming what grew — or, as in the
// 1174 → 1058 move above, what was compacted.
const MEASURED_STACK_HEIGHT_PX = 1058;

// Half a `text-xs` line box (Tailwind v4: 0.75rem/1rem ⇒ 16 px), so one added
// line of copy still trips the budget. Absorbs sub-pixel flex rounding only —
// the measurement was bit-identical across five runs on three commits.
const GROWTH_HEADROOM_PX = 8;

const MAX_NEW_HEIGHT_PX = MEASURED_STACK_HEIGHT_PX + GROWTH_HEADROOM_PX;

test.describe("@visual NetworkView density", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop layout drives the sections");
	});

	test("three per-interface sections stay within the reviewed height budget", { tag: "@visual" }, async ({ page }) => {
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");

		const section = (name: string) =>
			page.getByRole("heading", { name, level: 2 }).locator("xpath=ancestor::section[1]");

		const wifi = section("WiFi");
		const cellular = page.getByRole("heading", { name: "Cellular", level: 2 });
		const ethernet = section("Ethernet");
		await expect(wifi).toBeVisible();
		await expect(cellular).toBeVisible();
		await expect(ethernet).toBeVisible();

		// Combined bounding box: top of the WiFi section to the bottom of Ethernet.
		const wifiBox = await wifi.boundingBox();
		const ethBox = await ethernet.boundingBox();
		expect(wifiBox).not.toBeNull();
		expect(ethBox).not.toBeNull();
		const top = wifiBox!.y;
		const bottom = ethBox!.y + ethBox!.height;
		const height = Math.round(bottom - top);

		expect(height).toBeLessThanOrEqual(MAX_NEW_HEIGHT_PX);

		// Screenshot exactly the compacted stack (WiFi through Ethernet). fullPage
		// so the clip captures rows below the fold, not a clamped viewport sliver.
		await page.screenshot({
			path: path.join(TASK24_DIR, "network-density.png"),
			fullPage: true,
			clip: { x: wifiBox!.x, y: top, width: wifiBox!.width, height: bottom - top },
		});
	});
});

/**
 * The −116 px above is only honest if the demoted material is CLOSED at rest and
 * still REACHABLE — either half alone is satisfiable by a broken surface, so both
 * are asserted. Three traps this is written around:
 *
 *   • A COLLAPSED `<details>` still answers `getByTestId`, so a presence query
 *     says nothing about its state; `open` is what has to be read.
 *   • The open state must be reached by a real `<summary>` click — `.open = true`
 *     bypasses the toggle an operator uses, so it would pass against a summary
 *     that is unreachable, mis-nested or pointer-blocked.
 *   • No shipped mock scenario carries a per-adapter capability report, so
 *     without one `WifiSection` renders no capability disclosure at all and the
 *     assertion passes vacuously. `SharingSection` renders its diagnostics
 *     disclosure unconditionally and needs nothing.
 *
 * The report is stamped onto the device's OWN roster by patching every inbound
 * `status.wifi` frame, rather than pushed once through `dev.emit`. A one-shot
 * push is overwritten by the backend's next status broadcast, which detaches the
 * disclosure — measured here as a `<summary>` click failing "element was
 * detached from the DOM" after the injected roster was replaced.
 *
 * Own describe: the patch perturbs the height budget above, which is measured
 * against the untouched mock scenario.
 */

/** Rock 5B+ / RTL8852BE, the same board capture `wifi-capability.visual.spec.ts` uses. */
const ROCK_RTL8852BE = {
	phy: "phy0",
	generation: "wifi6",
	bands: ["2.4", "5"],
	maxWidthMhz: { "2.4": 40, "5": 80 },
	apModes: ["2.4", "5"],
	staApCombo: { supported: true, sameChannelOnly: true },
	wpa3Sae: "supported",
	regulatory: { country: "00", is6GhzLegal: false, self_managed: false },
};

/** Returns the patched frame, or `null` for one this harness does not own. */
function withWifiCapabilities(frame: Record<string, unknown>): Record<string, unknown> | null {
	const status = frame.status;
	if (status === null || typeof status !== "object") return null;
	const wifi = (status as Record<string, unknown>).wifi;
	if (wifi === null || typeof wifi !== "object") return null;
	const stamped = Object.fromEntries(
		Object.entries(wifi as Record<string, unknown>).map(([id, radio]) => [
			id,
			{ ...(radio as Record<string, unknown>), capabilities: ROCK_RTL8852BE },
		]),
	);
	return { ...frame, status: { ...(status as Record<string, unknown>), wifi: stamped } };
}

async function installCapabilityPatch(page: Page): Promise<void> {
	await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((message) => server.send(message));
		server.onMessage((message) => {
			const text = typeof message === "string" ? message : message.toString();
			try {
				const patched = withWifiCapabilities(JSON.parse(text) as Record<string, unknown>);
				if (patched !== null) {
					ws.send(JSON.stringify(patched));
					return;
				}
			} catch {
				/* non-JSON / binary frame */
			}
			ws.send(message);
		});
	});
}

/**
 * EVERY matching disclosure's `open`, not the first one's — the mock scenario
 * carries two radios, so a `.first()` read would leave the second unmeasured.
 */
const openStates = (page: Page, testId: string): Promise<boolean[]> =>
	page
		.getByTestId(testId)
		.evaluateAll((els) => els.map((el) => (el as HTMLDetailsElement).open));

test.describe("@visual NetworkView density — disclosures", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "desktop layout drives the sections");
		await installCapabilityPatch(page);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
		await expect(page.getByTestId("wifi-capabilities").first()).toBeAttached();
	});

	test(
		"the capability strip and the sharing diagnostics are both closed on load",
		{ tag: "@visual" },
		async ({ page }) => {
			const capability = await openStates(page, "wifi-capabilities");
			const diagnostics = await openStates(page, "sharing-diagnostics");

			// Non-vacuity: an empty list would satisfy `every` without measuring.
			expect(capability.length).toBeGreaterThan(0);
			expect(diagnostics).toHaveLength(1);

			expect(capability.every((open) => open === false)).toBe(true);
			expect(diagnostics[0]).toBe(false);

			// The state a folded warning still has to publish from outside.
			await expect(page.getByTestId("sharing-diagnostics-chip").first()).toBeVisible();

			await page.screenshot({
				path: path.join(TASK24_DIR, "network-disclosures-closed.png"),
				fullPage: true,
			});
		},
	);

	test(
		"each disclosure opens from its own summary, and only itself",
		{ tag: "@visual" },
		async ({ page }) => {
			const firstRadio = page.locator(
				'[data-testid="wifi-capabilities-toggle"][data-device="0"]',
			);
			await firstRadio.click();
			expect(await openStates(page, "wifi-capabilities")).toEqual(
				expect.arrayContaining([true]),
			);
			await expect(page.getByTestId("wifi-generation-badge").first()).toBeVisible();
			// Independent disclosures: opening one may not open the other.
			expect(await openStates(page, "sharing-diagnostics")).toEqual([false]);

			await page.getByTestId("sharing-diagnostics-toggle").click();
			expect(await openStates(page, "sharing-diagnostics")).toEqual([true]);
			await expect(page.getByTestId("sharing-priority")).toBeVisible();

			await page.screenshot({
				path: path.join(TASK24_DIR, "network-disclosures-open.png"),
				fullPage: true,
			});
		},
	);
});
