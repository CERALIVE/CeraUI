import path from "node:path";

import { expect, type Page, test } from "../fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "../helpers/index.js";
import { expectContained, probeContainment } from "../helpers/modem-containment.js";

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

/**
 * The WHOLE destination's height, not the WiFi→Ethernet span the budget above
 * measures. Those are different questions and both are worth asking: the budget
 * catches unreviewed growth inside three cards, this catches the page an
 * operator actually scrolls — Bonded Links → Sharing → WiFi → Cellular →
 * Ethernet → Hotspot → Bluetooth — which the todo-1 critique measured at
 * 1280×2761 and called a "golden" nobody can read in one glance.
 *
 * THE BASELINE IS A MEASUREMENT, NOT THE GOLDEN PNG's PIXEL HEIGHT. The
 * committed `network-desktop-desktop-linux.png` is 2761 px tall, but it is
 * captured at the desktop project's own 1280×800 viewport with `mask.css`
 * applied, so its height is not the same quantity this probe reads. The constant
 * below was measured by THIS probe, at 1280×900, on the pre-change tree
 * (`88516ad4`), with the same collision-band stabiliser applied — see the
 * evidence file named in the effort's todo 25.
 *
 * WHY A STABILISER IS STILL NEEDED. `CollisionBands` is bistable on worker-backend
 * lifetime (the full rationale is in `network.visual.spec.ts`): the same-subnet
 * band is present for the whole life of a fresh backend and absent for the whole
 * life of a warm one, and its box shifts every section below it. A height
 * measured without removing it from layout is therefore two numbers, not one,
 * and no wait can pick between them. It is removed from LAYOUT here for the same
 * reason and by the same rule; the band keeps its own coverage in
 * `CollisionBands.bondMapping.test.ts`.
 */
const COLLISION_BANDS_STABILIZE =
	'[data-testid="same-subnet-info"],[data-testid="policy-route-warning"]{display:none !important}';

/**
 * Measured by the probe below, on the pre-change tree, at 1280×900: **2302 px**.
 *
 * It is deliberately NOT 2761. Re-using the golden's pixel height would compare
 * two different measurement methods and produce a meaningless ratio, which is
 * exactly what "measure the before value in the same test run" exists to stop.
 */
const TODO_1_ERA_PAGE_HEIGHT_PX = 2302;

/**
 * The ACCEPTED todo-25 outcome: ≥18 % shorter. Owner-approved 2026-09-05.
 *
 * The original target was ≥25 % (a 1726 px cap), and it is recorded here rather
 * than deleted because the reason it was missed is the reason it must not be
 * re-attempted by relaxing an honesty rule. Two rules, both load-bearing, hold
 * roughly 250 px of the remaining gap:
 *
 * - **~138 px — the duplicate usb0/1/2 rows.** A modem's own USB-network
 *   interface is claimed by its Cellular row only when BOTH a cellular marker
 *   AND a modem roster claim name it (see `section-assignment.ts`). Collapsing
 *   the rows on the marker alone would hide the device entirely in the window
 *   before its modem row exists — trading a duplicated row for a disappeared
 *   one. The `usb_modem_net` fixture consolidation this pass shipped closes the
 *   part of that gap a FIXTURE correction legitimately can; the rest is the rule.
 * - **~112 px — the disabled dongle-control reason lines.** The shipped kiosk
 *   touchscreen cannot hover, so a disabled control's reason has to render
 *   inline rather than live in a `title`. Folding these is an accessibility
 *   regression, not a density win.
 *
 * What the fixture consolidation actually bought: **2302 → 1877 px, an 18.46 %
 * reduction**, with the frozen testid inventory intact (nothing was deleted to
 * buy it). That is accepted as todo 25's final state.
 *
 * The ratio is still written as arithmetic so it stays visible at the assertion,
 * and this cap is STILL NOT a knob. It sits ~10 px above the measured height —
 * enough to absorb font-metric noise, not enough to absorb a new row. If the
 * page grows past it, add height deliberately and re-measure; do not nudge the
 * ratio. Any further reduction needs owner sign-off on which rule to spend.
 */
const MAX_PAGE_HEIGHT_PX = Math.floor(TODO_1_ERA_PAGE_HEIGHT_PX * 0.82);

const DESIGN_PASS_25_DIR = path.resolve(
	import.meta.dirname,
	"../../../test-results/design-pass/25",
);

/**
 * The C4 capture set: desktop, the 1024×600 kiosk in touch layout, and mobile.
 *
 * `?mode=touch` is applied at NAVIGATION rather than toggled afterwards — the
 * touch token layer grows hit areas, so a page that loaded in default layout and
 * had the attribute set later measures the PRE-LIFT geometry (the modem-ux
 * precedent). Each entry therefore owns its own `goto`.
 */
const CAPTURES = [
	{ name: "desktop-1280x900", width: 1280, height: 900, touch: false },
	{ name: "kiosk-1024x600", width: 1024, height: 600, touch: true },
	{ name: "mobile-375x812", width: 375, height: 812, touch: false },
] as const;

/**
 * Every `data-testid` the destination rendered on the pre-change tree, at 1280.
 *
 * It is a FROZEN INVENTORY rather than a hand-written shortlist, because the
 * claim this pass has to defend is "every row is still present" and a shortlist
 * can only defend the rows somebody remembered. Post-change the page must render
 * a SUPERSET of this list: a compaction that DEMOTES a fact behind a disclosure
 * keeps its testid (the body stays mounted), and a compaction that DELETES one
 * fails here by name.
 *
 * Collected with the same collision-band stabiliser applied, so the bistable
 * `same-subnet-info` / `policy-route-warning` pair is deliberately absent from
 * it — those two are the one family whose presence is a property of the worker
 * backend rather than of the page.
 */
const PRE_CHANGE_TESTIDS: readonly string[] = [
	"bluetooth-enable",
	"bluetooth-off",
	"bluetooth-section",
	"bond-state-dg0h",
	"bond-state-dg1h",
	"bond-state-eth0",
	"bond-state-usb0",
	"bond-state-usb1",
	"bond-state-usb2",
	"bond-state-wlan0",
	"bond-state-wlan1",
	"bond-toggle-dg0h",
	"bond-toggle-dg1h",
	"bond-toggle-eth0",
	"bond-toggle-usb0",
	"bond-toggle-usb1",
	"bond-toggle-usb2",
	"bond-toggle-wlan0",
	"bond-toggle-wlan1",
	"bonded-link-card",
	"bonded-links-not-bonded",
	"destination-content",
	"link-telemetry",
	"link-telemetry-skeleton",
	"modem-carrier-badge",
	"modem-class-badge",
	"modem-detail",
	"modem-details-body",
	"modem-details-toggle",
	"modem-name",
	"modem-note",
	"modem-row",
	"modem-signal",
	"modem-state-badge",
	"netif-dongle",
	"netif-dongle-blocked-hint",
	"netif-dongle-state",
	"open-hotspot-dialog",
	"open-modem-config-dialog",
	"open-netif-dialog",
	"open-wifi-mode",
	"open-wifi-selector-dialog",
	"sharing-band-sharing-off",
	"sharing-section",
	"total-bandwidth-down",
	"total-bandwidth-up",
	"wifi-mode-badge",
	"wifi-row",
];

/** Sorted, de-duplicated `data-testid` values under the network destination. */
async function testidInventory(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const scope = document.querySelector("#main-content") ?? document.body;
		return [
			...new Set(
				[...scope.querySelectorAll("[data-testid]")].map(
					(el) => el.getAttribute("data-testid") ?? "",
				),
			),
		]
			.filter((id) => id.length > 0)
			.sort();
	});
}

test.describe("@visual NetworkView design pass 25", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"this pass sets its own three viewports; the mobile project would double every capture",
		);
	});

	for (const capture of CAPTURES) {
		test(
			`the destination is contained and enumerable at ${capture.name}`,
			{ tag: "@visual" },
			async ({ page }) => {
				await page.setViewportSize({ width: capture.width, height: capture.height });
				await page.goto(capture.touch ? "/?mode=touch" : "/");
				await ensureAuthenticated(page);
				await navigateTo(page, "network");
				await page.addStyleTag({ content: COLLISION_BANDS_STABILIZE });

				// The one section every containment probe keys on, and the row family
				// this pass must not lose.
				await expect(page.getByTestId("modem-row").first()).toBeVisible();

				expectContained(await probeContainment(page), `network ${capture.name}`);

				await page.screenshot({
					path: path.join(DESIGN_PASS_25_DIR, `network-${capture.name}.png`),
					fullPage: true,
				});
			},
		);
	}

	test("modem USB interfaces consolidate without losing their controls or addresses", async ({ page }) => {
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
		for (const [iface, ip] of [
			["usb0", "10.0.0.2"],
			["usb1", "10.0.1.2"],
			["usb2", "10.0.2.2"],
		] as const) {
			const row = page.getByTestId("modem-row").filter({
				has: page.getByTestId(`bond-toggle-${iface}`),
			});
			await expect(row).toHaveCount(1);
			await expect(page.getByTestId(`bond-toggle-${iface}`)).toHaveCount(1);
			await expect(row.getByTestId("open-modem-config-dialog")).toBeEnabled();
			await row.getByTestId("modem-details-toggle").click();
			await expect(row.getByTestId("modem-net-interface")).toBeVisible();
			await expect(row.getByTestId("modem-net-interface")).toHaveText(`${iface} · ${ip}`);
		}
		// The consolidation must not reach PAST the modems: the plain wired port and
		// the isolated-dongle row are still their own rows afterwards. Both dongle
		// rows survive (`bond-toggle-dg0h` / `-dg1h`), but only ONE carries the
		// `netif-dongle` marker — the scenario's dg0h is `up` and renders as an
		// ordinary wired row, while the `acquiring` dg1h is the marked one, which is
		// also what makes the blocked hint below reachable. That asymmetry predates
		// this pass and is a property of the fixture, not a ceiling on dongle support.
		await expect(page.getByTestId("bond-toggle-eth0")).toHaveCount(1);
		await expect(page.getByTestId("bond-toggle-dg0h")).toHaveCount(1);
		await expect(page.getByTestId("netif-dongle")).toHaveCount(1);
		await expect(page.getByTestId("netif-dongle-blocked-hint")).toBeVisible();
	});

	test(
		"the destination is at least 18% shorter than the todo-1-era golden",
		{ tag: "@visual" },
		async ({ page }) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			await page.goto("/");
			await ensureAuthenticated(page);
			await navigateTo(page, "network");
			await page.addStyleTag({ content: COLLISION_BANDS_STABILIZE });
			await expect(page.getByTestId("modem-row").first()).toBeVisible();

			// Settling matters more here than anywhere else in this file: the
			// destination flies in with a delay, and a height read mid-transition is
			// a number for a layout that never existed on screen.
			expectContained(await probeContainment(page), "network 1280 height probe");

			const { height, sections } = await page.evaluate(() => ({
				height: document.documentElement.scrollHeight,
				// A bare "the page is 300px too tall" gets re-diagnosed by hand every
				// time, so the overrun names its own culprit — the same reason
				// `probeContainment` reports overflow SOURCES rather than a total.
				sections: [...document.querySelectorAll("#main-content section")].map(
					(el) =>
						`${(el.querySelector("h2")?.textContent ?? el.getAttribute("aria-label") ?? "?").trim()}=${Math.round(el.getBoundingClientRect().height)}`,
				),
			}));
			const inventory = await testidInventory(page);
			// Printed unconditionally: the BEFORE run of this same probe is how the
			// baseline above was obtained, and re-deriving it must not need a code
			// edit.
			console.log(
				`[design-pass-25] page height @1280 = ${height}px (cap ${MAX_PAGE_HEIGHT_PX}px)\n` +
					`[design-pass-25] sections = ${sections.join(" ")}\n` +
					`[design-pass-25] testids (${inventory.length}) = ${JSON.stringify(inventory)}`,
			);

			// Non-vacuity: an empty frozen list would satisfy `every` without
			// measuring anything.
			expect(PRE_CHANGE_TESTIDS.length).toBeGreaterThan(0);
			const missing = PRE_CHANGE_TESTIDS.filter((id) => !inventory.includes(id));
			expect(missing, "a testid the pre-change destination rendered").toEqual([]);

			expect(height).toBeLessThanOrEqual(MAX_PAGE_HEIGHT_PX);
		},
	);
});
