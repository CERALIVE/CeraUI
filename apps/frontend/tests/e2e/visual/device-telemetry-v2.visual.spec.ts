import path from "node:path";

import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "../fixtures/index.js";
import { EVIDENCE_DIR, ensureAuthenticated, navigateTo } from "../helpers/index.js";

/**
 * @visual evidence + the C5 density gate for device-telemetry-v2.
 *
 * Three surfaces changed, and all three are captured at BOTH the 1024x600 kiosk
 * touchscreen and 375px: the unified encoder widget (Settings -> Device Health),
 * the retiered Device Stats section, and the Live cockpit's new ENCODER cell.
 *
 * The gate is not the pixels — it is the assertions beside them. The Device
 * Health panel has a documented history of overflowing the kiosk viewport
 * (HEALTH_COMPACT_QUERY is a three-way coordination point), and this redesign
 * claims to be height-NEGATIVE while adding a signal. That claim is checked
 * here against the real rendered box rather than trusted: the dialog body must
 * not scroll, and neither telemetry surface may clip horizontally.
 *
 * The fan's four states are driven through the WS proxy because the collector is
 * `isRealDevice()`-gated and publishes nothing on a dev host — which is itself
 * the `unknown` case, captured first.
 */

const KIOSK = { width: 1024, height: 600 };
const MOBILE = { width: 375, height: 812 };

type FanFrame =
	| { state: "running"; dutyPercent: number }
	| { state: "off"; dutyPercent: 0 }
	| { state: "absent" }
	| { state: "unknown" };

/** The honest floor: neither kernel interface answered. */
const ENCODER_UNREPORTED = {
	source: null,
	cores: [],
	updatedAt: null,
	simulated: false,
};

const ENCODER_PERCENT = {
	source: "mpp-service",
	cores: [
		{ core: "rkvenc0", kind: "percent", percent: 45.53 },
		{ core: "rkvenc1", kind: "percent", percent: 0 },
	],
	updatedAt: Date.now(),
	simulated: false,
};

const ENCODER_BINARY = {
	source: "clk-enable-count",
	cores: [
		{ core: "rkvenc0", kind: "active", active: true },
		{ core: "rkvenc1", kind: "active", active: false },
	],
	updatedAt: Date.now(),
	simulated: false,
};

/** Captured beside the busy states on purpose: a colour treatment evidenced only
 *  in the state the board happened to be in is not evidence. */
const ENCODER_IDLE = {
	source: "mpp-service",
	cores: [
		{ core: "rkvenc0", kind: "percent", percent: 0 },
		{ core: "rkvenc1", kind: "percent", percent: 0 },
	],
	updatedAt: Date.now(),
	simulated: false,
};

const ENCODER_BINARY_IDLE = {
	source: "clk-enable-count",
	cores: [
		{ core: "rkvenc0", kind: "active", active: false },
		{ core: "rkvenc1", kind: "active", active: false },
	],
	updatedAt: Date.now(),
	simulated: false,
};

test.describe("@visual device telemetry v2", () => {
	let pageWs: WebSocketRoute | null;
	let streaming = false;

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "this spec sets its own viewports");
		pageWs = null;
		streaming = false;

		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as { status?: Record<string, unknown> };
					if (frame?.status && streaming) {
						frame.status.is_streaming = true;
						ws.send(JSON.stringify(frame));
						return;
					}
				} catch {
					/* non-JSON / binary frame */
				}
				ws.send(m);
			});
		});

		await page.goto("/");
		await ensureAuthenticated(page);
	});

	async function push(page: Page, frame: Record<string, unknown>): Promise<void> {
		pageWs?.send(JSON.stringify(frame));
		await page.evaluate(() => new Promise((r) => setTimeout(r, 40)));
	}

	async function shot(page: Page, testId: string, name: string): Promise<void> {
		await page.getByTestId(testId).screenshot({ path: path.join(EVIDENCE_DIR, name) });
	}

	/** No horizontal clip: the box must not be wider than the space it has. */
	async function expectNoHorizontalOverflow(page: Page, testId: string): Promise<void> {
		const overflow = await page.getByTestId(testId).evaluate((el) => ({
			scrollWidth: el.scrollWidth,
			clientWidth: el.clientWidth,
		}));
		expect(overflow.scrollWidth, `${testId} clips horizontally`).toBeLessThanOrEqual(
			overflow.clientWidth + 1,
		);
	}

	async function openDeviceHealth(page: Page): Promise<void> {
		await navigateTo(page, "settings");
		await page.getByRole("button", { name: /Device Health/i }).first().click();
		await expect(page.getByTestId("device-health")).toBeVisible({ timeout: 15_000 });
	}

	test("device health — unified encoder widget", { tag: "@visual" }, async ({ page }) => {
		for (const [label, viewport] of [
			["kiosk-1024x600", KIOSK],
			["mobile-375", MOBILE],
		] as const) {
			await page.setViewportSize(viewport);
			await openDeviceHealth(page);

			// Every state is DRIVEN, never inherited: the page persists across the
			// viewport loop, so an unpushed first capture would read the previous
			// iteration's last frame.
			// Scoped to the DIALOG: the Settings page behind it now carries its own
			// encoder widget (that is the point of the follow-up), so an unscoped
			// testid legitimately matches two nodes.
			const panel = page.getByTestId("device-health");

			// The engine revision is the card header's trailing chip. Pushed rather
			// than assumed: with no `revisions` frame it renders nothing at all, and
			// an absent chip would silently pass for a well-placed one.
			await push(page, { revisions: { cerastream: "2026.7.2" } });
			await expect(panel.getByTestId("device-health-engine-revision")).toContainText(
				"2026.7.2",
			);

			await push(page, { "encoder-load": ENCODER_UNREPORTED });
			await expect(panel.getByTestId("encoder-status-headline")).toHaveAttribute(
				"data-activity",
				"unreported",
			);
			await shot(page, "device-health", `telemetry-v2-health-unreported-${label}.png`);

			await push(page, { "encoder-load": ENCODER_PERCENT });
			await expect(panel.getByTestId("encoder-status-headline")).toHaveAttribute(
				"data-activity",
				"encoding",
			);
			await expect(panel.getByTestId("encoder-cores")).toHaveAttribute(
				"data-precision",
				"percent",
			);
			await shot(page, "device-health", `telemetry-v2-health-percent-${label}.png`);

			await push(page, { "encoder-load": ENCODER_IDLE });
			await expect(panel.getByTestId("encoder-status-headline")).toHaveAttribute(
				"data-activity",
				"idle",
			);
			await expect(panel.getByTestId("encoder-status-headline")).toHaveAttribute(
				"data-tone",
				"quiet",
			);
			await shot(page, "device-health", `telemetry-v2-health-idle-${label}.png`);

			await push(page, { "encoder-load": ENCODER_BINARY });
			await expect(panel.getByTestId("encoder-cores")).toHaveAttribute(
				"data-precision",
				"binary",
			);
			await expect(panel.getByTestId("encoder-core-rkvenc0")).toHaveAttribute(
				"data-core-tone",
				"live",
			);
			await expect(panel.getByTestId("encoder-core-rkvenc1")).toHaveAttribute(
				"data-core-tone",
				"quiet",
			);
			await shot(page, "device-health", `telemetry-v2-health-binary-${label}.png`);

			await push(page, { "encoder-load": ENCODER_BINARY_IDLE });
			await shot(page, "device-health", `telemetry-v2-health-binary-idle-${label}.png`);

			// C5 — the panel must not scroll on the kiosk touchscreen. This is the
			// documented three-way pivot, re-checked rather than assumed.
			const body = await page.getByTestId("device-health").evaluate((el) => {
				const scroller = el.closest<HTMLElement>(".overflow-y-auto");
				if (!scroller) throw new Error("device-health has no scroll container");
				return {
					scrollHeight: scroller.scrollHeight,
					clientHeight: scroller.clientHeight,
				};
			});
			const band = await page
				.getByTestId("device-health-encoder")
				.evaluate((el) => Math.round(el.getBoundingClientRect().height));
			// eslint-disable-next-line no-console -- evidence for the density budget
			console.log(
				`[density] device-health ${label}: content ${body.scrollHeight}px / box ${body.clientHeight}px · encoder band ${band}px`,
			);
			if (viewport === KIOSK) {
				expect(
					body.scrollHeight,
					"Device Health panel scrolls on the 1024x600 kiosk viewport",
				).toBeLessThanOrEqual(body.clientHeight + 1);
			}
			await expectNoHorizontalOverflow(page, "device-health");

			await page.keyboard.press("Escape");
		}
	});

	test("device stats — tiered grid and the fan's four states", { tag: "@visual" }, async ({
		page,
	}) => {
		// Every state is driven explicitly — the page persists across the viewport
		// loop, so an unpushed capture would read the previous iteration's frame.
		const fanStates: [string, FanFrame][] = [
			["running", { state: "running", dutyPercent: 47.1 }],
			["off", { state: "off", dutyPercent: 0 }],
			["absent", { state: "absent" }],
			["unknown", { state: "unknown" }],
		];

		for (const [label, viewport] of [
			["kiosk-1024x600", KIOSK],
			["mobile-375", MOBILE],
		] as const) {
			await page.setViewportSize(viewport);
			await navigateTo(page, "settings");
			await expect(page.getByTestId("device-stats")).toBeVisible({ timeout: 15_000 });

			// NOTHING is behind a click. The secondary tier used to be a collapsed
			// <details>; operator feedback on the deployed board rejected hiding
			// telemetry behind an expander, so these must be readable on arrival.
			await expect(page.getByTestId("device-stats-details")).toHaveCount(0);
			await expect(page.getByTestId("device-stat-network")).toBeVisible();
			await expect(page.getByTestId("device-stat-bootSlot")).toBeVisible();

			// The encoder is a FIRST-CLASS glance signal here, not something the
			// operator has to open the Device Health dialog to see.
			await push(page, { "encoder-load": ENCODER_PERCENT });
			const encoderTile = page.getByTestId("device-stat-encoder");
			await expect(encoderTile).toBeVisible();
			await expect(encoderTile).toHaveAttribute("data-tier", "primary");
			await expect(encoderTile.getByTestId("encoder-status-headline")).toHaveAttribute(
				"data-activity",
				"encoding",
			);
			await expect(encoderTile.getByTestId("encoder-core-rkvenc0")).toBeVisible();
			await expect(encoderTile.getByTestId("encoder-core-rkvenc1")).toBeVisible();
			await encoderTile.screenshot({
				path: path.join(EVIDENCE_DIR, `telemetry-v2-stats-encoder-encoding-${label}.png`),
			});

			await push(page, { "encoder-load": ENCODER_IDLE });
			await expect(encoderTile.getByTestId("encoder-status-headline")).toHaveAttribute(
				"data-activity",
				"idle",
			);
			await encoderTile.screenshot({
				path: path.join(EVIDENCE_DIR, `telemetry-v2-stats-encoder-idle-${label}.png`),
			});

			for (const [state, frame] of fanStates) {
				await push(page, { fan: frame });
				await expect(page.getByTestId("device-stat-fan")).toHaveAttribute(
					"data-fan-state",
					state,
				);
				await shot(page, "device-stats", `telemetry-v2-stats-fan-${state}-${label}.png`);
			}

			const box = await page.getByTestId("device-stats").evaluate((el) => ({
				height: el.getBoundingClientRect().height,
			}));
			// eslint-disable-next-line no-console -- evidence for the density budget
			console.log(
				`[density] device-stats ${label} (7 signals, nothing hidden): ${Math.round(box.height)}px`,
			);
			await expectNoHorizontalOverflow(page, "device-stats");
		}
	});

	test("live cockpit — the fourth ENCODER cell", { tag: "@visual" }, async ({ page }) => {
		streaming = true;
		await push(page, { status: { is_streaming: true } });

		for (const [label, viewport] of [
			["kiosk-1024x600", KIOSK],
			["mobile-375", MOBILE],
		] as const) {
			await page.setViewportSize(viewport);
			await navigateTo(page, "live");
			await push(page, { "encoder-load": ENCODER_PERCENT });

			const cell = page.getByTestId("telemetry-encoder");
			await expect(cell).toBeVisible({ timeout: 15_000 });
			await expect(cell.getByTestId("encoder-cores")).toHaveAttribute(
				"data-density",
				"inline",
			);
			// Both cores are always printed, always separately — never averaged.
			await expect(cell.getByTestId("encoder-core-rkvenc0")).toBeVisible();
			await expect(cell.getByTestId("encoder-core-rkvenc1")).toBeVisible();

			const strip = page.locator('section:has([data-testid="telemetry-encoder"])');
			await strip.screenshot({
				path: path.join(EVIDENCE_DIR, `telemetry-v2-live-strip-${label}.png`),
			});

			const overflow = await strip.evaluate((el) => ({
				scrollWidth: el.scrollWidth,
				clientWidth: el.clientWidth,
			}));
			expect(
				overflow.scrollWidth,
				"telemetry strip clips horizontally — it must WRAP",
			).toBeLessThanOrEqual(overflow.clientWidth + 1);

			// The cell must NOT have leaked into the persistent HUD strip (C1).
			await expect(page.locator('[data-hud-region] [data-testid="encoder-cores"]')).toHaveCount(
				0,
			);

			// An `active` core prints a word and never a digit — the inline density
			// drops the bar, so the string shape is the only carrier left.
			await push(page, { "encoder-load": ENCODER_BINARY });
			await expect(cell.getByTestId("encoder-cores")).toHaveAttribute(
				"data-precision",
				"binary",
			);
			for (const core of ["rkvenc0", "rkvenc1"]) {
				const text = (await cell.getByTestId(`encoder-core-value-${core}`).textContent()) ?? "";
				expect(text, `inline ${core} rendered a digit`).not.toMatch(/\d/);
			}
			await strip.screenshot({
				path: path.join(EVIDENCE_DIR, `telemetry-v2-live-strip-binary-${label}.png`),
			});

			await push(page, { "encoder-load": ENCODER_IDLE });
			await expect(cell.getByTestId("encoder-status-headline")).toHaveAttribute(
				"data-activity",
				"idle",
			);
			await strip.screenshot({
				path: path.join(EVIDENCE_DIR, `telemetry-v2-live-strip-idle-${label}.png`),
			});
		}
	});

	/**
	 * Dark graphite is the HERO theme (`.impeccable.md` → Dark-First Hero), and
	 * the encoder widget's activity state is now carried partly by colour — so
	 * evidence captured only in light mode photographs the register the operator
	 * is least likely to be looking at. Scoped deliberately to the two encoder
	 * surfaces: the thermal trace and the fan tile did not change, and paying for
	 * a full second pass of them buys nothing.
	 */
	test("encoder colour — the dark hero theme, idle and encoding", { tag: "@visual" }, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: "dark" });
		await page.reload();
		await ensureAuthenticated(page);

		for (const [label, viewport] of [
			["kiosk-1024x600", KIOSK],
			["mobile-375", MOBILE],
		] as const) {
			await page.setViewportSize(viewport);
			await openDeviceHealth(page);
			const panel = page.getByTestId("device-health");
			await push(page, { revisions: { cerastream: "2026.7.2" } });

			for (const [state, frame] of [
				["idle", ENCODER_IDLE],
				["encoding", ENCODER_PERCENT],
				["binary", ENCODER_BINARY],
				["unreported", ENCODER_UNREPORTED],
			] as const) {
				await push(page, { "encoder-load": frame });
				await expect(panel.getByTestId("encoder-status-headline")).toBeVisible();
				await shot(page, "device-health", `telemetry-v2-dark-health-${state}-${label}.png`);
			}
			await expectNoHorizontalOverflow(page, "device-health");
			await page.keyboard.press("Escape");

			// The Device Stats tile is the SAME widget at `inline compact`. Both are
			// captured so the two densities can be compared side by side — reading
			// as one element across them is the whole point of the treatment.
			await navigateTo(page, "settings");
			const tile = page.getByTestId("device-stat-encoder");
			await expect(tile).toBeVisible({ timeout: 15_000 });
			for (const [state, frame] of [
				["idle", ENCODER_IDLE],
				["encoding", ENCODER_PERCENT],
				["binary", ENCODER_BINARY],
			] as const) {
				await push(page, { "encoder-load": frame });
				await tile.screenshot({
					path: path.join(EVIDENCE_DIR, `telemetry-v2-dark-stats-encoder-${state}-${label}.png`),
				});
			}
		}
	});
});
