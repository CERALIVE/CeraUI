import fs from "node:fs";
import path from "node:path";

import type { Locator } from "@playwright/test";

import { expect, test } from "../fixtures/index.js";
import {
	type BluetoothWire,
	installBluetoothWire,
} from "../helpers/bluetooth-wire.js";
import { ensureAuthenticated, navigateTo } from "../helpers/index.js";

/**
 * @visual evidence capture for the Network destination's Bluetooth card.
 *
 * The PNGs are evidence for a human reader, NEVER the check — every criterion
 * below is a PASS/FAIL assertion this file makes itself, following
 * `modem-ux.visual.spec.ts`'s rule that a capture proves nothing on its own.
 * There are deliberately no committed baselines and no `toHaveScreenshot()`:
 * this is not a pixel-regression gate, so demanding baselines nobody has
 * reviewed would be worse than no gate.
 *
 * The payload is injected for the reason `helpers/bluetooth-wire.ts` records —
 * todo 14's mock provider is not wired into the device's broadcast yet.
 */
test.use({ backendScenario: "bt-mic-paired" });

const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../../../test-results",
);

const CARD = '[data-testid="bluetooth-section"]';

async function capture(locator: Locator, name: string): Promise<void> {
	fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
	await locator.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`) });
}

test.describe("@visual Bluetooth card", () => {
	let wire: BluetoothWire;

	test.beforeEach(async ({ page }) => {
		wire = await installBluetoothWire(page);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
		await wire.publish();
		await expect(page.locator(CARD)).toBeVisible();
	});

	test(
		"the bonded microphone, the disconnected row, and the operator-off state",
		{ tag: "@visual" },
		async ({ page }) => {
			const card = page.locator(CARD);

			// 1. The steady state an operator returns to on the next boot.
			await expect(page.getByTestId("bluetooth-chip-connected")).toBeVisible();
			await expect(page.getByTestId("bluetooth-chip-battery")).toContainText(
				"80",
			);
			await expect(
				page.getByTestId("bluetooth-audio-source-hint"),
			).toBeVisible();
			await capture(card, "bt-card-paired-mic");

			// 2. Disconnected: BlueZ retracts `Battery1`, so the level and the
			//    audio-source pointer both go with it.
			await page.getByTestId("bluetooth-action-disconnect").click();
			await expect(page.getByTestId("bluetooth-chip-connected")).toHaveCount(0);
			await expect(page.getByTestId("bluetooth-chip-battery")).toHaveCount(0);
			await expect(page.getByTestId("bluetooth-audio-source-hint")).toHaveCount(
				0,
			);
			await capture(card, "bt-card-disconnected");

			await page.getByTestId("bluetooth-action-connect").click();
			await expect(page.getByTestId("bluetooth-chip-connected")).toBeVisible();

			// 3. Operator-off: the OFF state, never a service-fault band.
			await page.getByTestId("bluetooth-enable").click();
			await expect(page.getByTestId("bluetooth-off")).toBeVisible();
			await expect(page.getByTestId("bluetooth-unavailable")).toHaveCount(0);
			await capture(card, "bt-card-off");
		},
	);

	test(
		"the card is contained on the 1024x600 kiosk viewport",
		{ tag: "@visual" },
		async ({ page }) => {
			await page.setViewportSize({ width: 1024, height: 600 });
			const card = page.locator(CARD);
			await expect(card).toBeVisible();

			// BP-1: no horizontal overflow at the kiosk width.
			const box = await card.boundingBox();
			expect(box).not.toBeNull();
			if (box) expect(Math.round(box.x + box.width)).toBeLessThanOrEqual(1024);

			await capture(card, "bt-card-kiosk-1024x600");
		},
	);
});
