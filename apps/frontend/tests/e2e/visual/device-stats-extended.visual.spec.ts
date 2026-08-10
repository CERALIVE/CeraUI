import path from "node:path";

import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "../fixtures/index.js";
import { EVIDENCE_DIR, ensureAuthenticated, navigateTo } from "../helpers/index.js";

/**
 * @visual evidence for the four collector signals the Device Stats section
 * gained: memory + swap, per-policy CPU frequency, DDR bus and GPU.
 *
 * The pixels are the smaller half. The gate is that an OPTIONAL signal the board
 * did not publish leaves NO element behind — not a dash, not a zero, not an
 * "Unavailable" line — because every one of these keys is absent on a kernel
 * that has no such interface, and mainline RK3588 genuinely has none for DDR.
 * A placeholder there would tell an operator to wait for a figure that is never
 * coming. The absent leg is therefore asserted at the DOM, at both viewports.
 *
 * The `device-stats` broadcast is REWRITTEN on the proxy rather than merely
 * pushed: unlike `fan` and `encoder-load`, the dev backend publishes this one on
 * its own 5s tick, so an unrewritten absent leg would be re-populated mid-test.
 */

const KIOSK = { width: 1024, height: 600 };
const MOBILE = { width: 375, height: 812 };

const GIB = 1024 ** 3;

/** The five always-present signals — the S1-locked floor of the payload. */
const BASE_STATS = {
	disk: { used: 40 * GIB, total: 128 * GIB, type: "SSD" },
	cpuLoad1: 0.42,
	socTemp: 52.0,
	ifaceRxTx: { iface: "eth0", rxBytesPerSec: 1_250_000, txBytesPerSec: 640_000 },
	raucSlot: "A",
};

/** A vendor-6.1 RK3588 shape: every optional collector answered. */
const FULL_STATS = {
	...BASE_STATS,
	memTotalBytes: 8 * GIB,
	memAvailableBytes: 6 * GIB,
	memUsedPercent: 25,
	swapTotalBytes: 2 * GIB,
	swapFreeBytes: 2 * GIB,
	cpuFreq: [
		{ id: "policy0", curKhz: 1_008_000, maxKhz: 1_800_000 },
		{ id: "policy4", curKhz: 1_416_000, maxKhz: 2_400_000 },
		{ id: "policy6", curKhz: 2_016_000, maxKhz: 2_400_000 },
	],
	ddr: { loadPercent: 37, curFreqHz: 528_000_000, maxFreqHz: 1_560_000_000 },
	gpu: { loadPercent: 61, curFreqHz: 300_000_000, maxFreqHz: 1_000_000_000 },
};

/** The mainline/edge shape: no meminfo collector, no devfreq, no cpufreq tree. */
const BARE_STATS = { ...BASE_STATS };

/** Mali kbase: a load with no clock beside it, which is a WHOLE reading. */
const KBASE_GPU_STATS = { ...BASE_STATS, gpu: { loadPercent: 61 } };

const OPTIONAL_TILES = [
	"device-stat-memory",
	"device-stat-swap",
	"device-stat-cpuFreq",
	"device-stat-ddr",
	"device-stat-gpu",
] as const;

test.describe("@visual device stats — memory, cpufreq, DDR and GPU", () => {
	let pageWs: WebSocketRoute | null;
	let stats: Record<string, unknown> = FULL_STATS;

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "this spec sets its own viewports");
		pageWs = null;
		stats = FULL_STATS;

		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as Record<string, unknown>;
					if (frame && "device-stats" in frame) {
						ws.send(JSON.stringify({ "device-stats": stats }));
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

	async function applyStats(page: Page, payload: Record<string, unknown>): Promise<void> {
		stats = payload;
		pageWs?.send(JSON.stringify({ "device-stats": payload }));
		await page.evaluate(() => new Promise((r) => setTimeout(r, 40)));
	}

	async function openStats(page: Page): Promise<void> {
		await navigateTo(page, "settings");
		await expect(page.getByTestId("device-stats")).toBeVisible({ timeout: 15_000 });
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

	test("every collector signal, rendered in its own unit", { tag: "@visual" }, async ({
		page,
	}) => {
		for (const [label, viewport] of [
			["kiosk-1024x600", KIOSK],
			["mobile-375", MOBILE],
		] as const) {
			await page.setViewportSize(viewport);
			await openStats(page);
			await applyStats(page, FULL_STATS);

			const section = page.getByTestId("device-stats");

			// Memory — a percentage against MemAvailable, with used-of-total in the
			// binary GiB the kernel actually reports.
			await expect(page.getByTestId("device-stat-memory-value")).toHaveText("25 %");
			await expect(page.getByTestId("device-stat-memory")).toContainText(
				"2.0 GiB / 8.0 GiB",
			);

			// CPU frequency — one row per POLICY, printed under its sysfs id. kHz on
			// the wire, GHz on screen; the ceiling is `cpuinfo_max_freq`.
			for (const [id, reading] of [
				["policy0", "1.01 GHz / 1.80 GHz"],
				["policy4", "1.42 GHz / 2.40 GHz"],
				["policy6", "2.02 GHz / 2.40 GHz"],
			] as const) {
				await expect(page.getByTestId(`cpufreq-policy-value-${id}`)).toHaveText(reading);
				await expect(page.getByTestId(`cpufreq-policy-${id}`)).toContainText(id);
			}
			// The ids are directory names. RK3588's big.LITTLE split is board
			// knowledge the array does not carry, and x86 has one policy per CPU.
			await expect(page.getByTestId("cpufreq-policies")).not.toContainText(/big|little/i);

			// DDR and GPU are devfreq — Hz on the wire, MHz on screen. cpufreq above
			// is kHz. Both units in one panel is exactly the 1000x trap.
			await expect(page.getByTestId("device-stat-ddr-value")).toHaveText("37 %");
			await expect(page.getByTestId("device-stat-ddr")).toContainText("528 MHz / 1560 MHz");
			await expect(page.getByTestId("device-stat-gpu-value")).toHaveText("61 %");
			await expect(page.getByTestId("device-stat-gpu")).toContainText("300 MHz / 1000 MHz");

			await expect(page.getByTestId("device-stat-swap-value")).toHaveText("0.0 GiB / 2.0 GiB");

			// Each percentage that has a real denominator draws a bar; each one that
			// does not (SoC temperature) still must not grow one.
			for (const key of ["memory", "ddr", "gpu"]) {
				await expect(page.getByTestId(`device-stat-${key}-bar`)).toHaveCount(1);
			}
			await expect(page.getByTestId("device-stat-socTemp-bar")).toHaveCount(0);

			await section.screenshot({
				path: path.join(EVIDENCE_DIR, `device-stats-extended-full-${label}.png`),
			});

			const box = await section.evaluate((el) =>
				Math.round(el.getBoundingClientRect().height),
			);
			// eslint-disable-next-line no-console -- evidence for the density budget
			console.log(`[density] device-stats ${label} (11 signals, nothing hidden): ${box}px`);
			await expectNoHorizontalOverflow(page, "device-stats");
		}
	});

	test("a board that publishes none of them renders none of them", { tag: "@visual" }, async ({
		page,
	}) => {
		for (const [label, viewport] of [
			["kiosk-1024x600", KIOSK],
			["mobile-375", MOBILE],
		] as const) {
			await page.setViewportSize(viewport);
			await openStats(page);
			await applyStats(page, BARE_STATS);

			for (const testId of OPTIONAL_TILES) {
				await expect(page.getByTestId(testId), `${testId} must not exist`).toHaveCount(0);
				await expect(page.getByTestId(`${testId}-value`)).toHaveCount(0);
			}
			await expect(page.getByTestId("cpufreq-policies")).toHaveCount(0);

			// The five always-present signals are untouched by any of this.
			for (const testId of [
				"device-stat-socTemp",
				"device-stat-cpuLoad",
				"device-stat-disk",
				"device-stat-network",
				"device-stat-bootSlot",
			]) {
				await expect(page.getByTestId(testId)).toBeVisible();
			}

			await page.getByTestId("device-stats").screenshot({
				path: path.join(EVIDENCE_DIR, `device-stats-extended-absent-${label}.png`),
			});
			await expectNoHorizontalOverflow(page, "device-stats");
		}
	});

	test("the kbase GPU reads as a load with no clock", { tag: "@visual" }, async ({ page }) => {
		await page.setViewportSize(KIOSK);
		await openStats(page);
		await applyStats(page, KBASE_GPU_STATS);

		const gpu = page.getByTestId("device-stat-gpu");
		await expect(page.getByTestId("device-stat-gpu-value")).toHaveText("61 %");
		// No frequency exists to read on this path. A "0 MHz" beside the load would
		// be a measurement the interface structurally cannot make.
		await expect(gpu).not.toContainText("MHz");
		// And the load itself is NOT withheld for the missing clock.
		await expect(page.getByTestId("device-stat-gpu-bar")).toHaveCount(1);
		// DDR is a separate probe over the same directory — one answering says
		// nothing about the other.
		await expect(page.getByTestId("device-stat-ddr")).toHaveCount(0);

		await gpu.screenshot({
			path: path.join(EVIDENCE_DIR, "device-stats-extended-gpu-kbase-kiosk-1024x600.png"),
		});
	});

	/**
	 * Dark graphite is the hero theme (`.impeccable.md` → Dark-First Hero), and
	 * three of the four new signals carry a filled bar — evidence captured only in
	 * light mode photographs the register the operator is least likely to see.
	 */
	test("the new signals in the dark hero theme", { tag: "@visual" }, async ({ page }) => {
		await page.emulateMedia({ colorScheme: "dark" });
		await page.reload();
		await ensureAuthenticated(page);

		for (const [label, viewport] of [
			["kiosk-1024x600", KIOSK],
			["mobile-375", MOBILE],
		] as const) {
			await page.setViewportSize(viewport);
			await openStats(page);
			await applyStats(page, FULL_STATS);

			await expect(page.getByTestId("device-stat-memory-value")).toHaveText("25 %");
			await page.getByTestId("device-stats").screenshot({
				path: path.join(EVIDENCE_DIR, `device-stats-extended-dark-${label}.png`),
			});
		}
	});
});
