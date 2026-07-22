import fs from "node:fs";

import { expect, test } from "./fixtures/index.js";

import { ensureAuthenticated, evidencePath, navigateTo } from "./helpers";
import {
	directRpc,
	installWsHarness,
	openTargetModemDialog,
	patchModem,
	targetModemKey,
} from "./modem-config-surface-fixture";

/**
 * T5.4 — modem_provisioning default-absent USB-mode gate (@functional).
 *
 * Proves the Phase-B gate end-to-end against the REAL dev backend + ModemConfigDialog:
 *
 *   1. UI gate — a modem that reports `usb_mode` renders the USB-mode block with the
 *      "Switch mode" control DISABLED and a disabled-with-reason line, because the
 *      dev backend config carries no `modem_provisioning` key (the default).
 *   2. Server-side refusal — calling `modems.setUsbMode` DIRECTLY over the same
 *      authenticated socket (bypassing the disabled button) is refused server-side
 *      with the typed `provisioning_disabled` error — the gate is a real RPC-layer
 *      refusal, not merely a hidden UI control.
 *
 * The USB-mode block is driven by the injected `usb_mode`/`recommended_usb_mode`
 * fields (multi-modem-wifi does not advertise them); the RPC refusal is served by
 * the real per-worker backend, whose config has no modem_provisioning key.
 *
 * PLAYBOOK.md compliance: role/testid/web-first assertions only — no screenshots,
 * no fixed-delay waits.
 */

const MODEM_INDEX = 1;

test.describe(
	"modem USB-mode gate — modem_provisioning default-absent",
	{ tag: "@functional" },
	() => {
		test.skip(
			({ browserName }) => browserName !== "chromium",
			"single-browser integration proof",
		);

		const evidence: string[] = [];
		const record = (line: string) => evidence.push(line);

		test.beforeEach(async ({ page }, testInfo) => {
			test.skip(
				testInfo.project.name !== "desktop",
				"desktop layout drives the modem config dialog",
			);
			await page.addInitScript(installWsHarness);
			await page.goto("/");
			await ensureAuthenticated(page);
			await navigateTo(page, "network");
			await expect
				.poll(
					() =>
						page.evaluate(() => {
							const m = window.__ceraModemConfigSurface?.lastModems;
							return m ? Object.keys(m).length : 0;
						}),
					{ timeout: 15000, message: "modem snapshot should arrive" },
				)
				.toBeGreaterThan(0);
		});

		test.afterAll(async () => {
			fs.writeFileSync(
				evidencePath("t5-4-modem-usb-mode-gate.txt"),
				[
					"T5.4 — modem_provisioning default-absent USB-mode gate: functional E2E evidence",
					"Driver: real ModemConfigDialog + real per-worker backend; usb_mode injected",
					"        via dev.emit; setUsbMode called directly over the authed socket.",
					`Generated: ${new Date().toISOString()}`,
					"",
					...evidence,
					"",
				].join("\n"),
				"utf8",
			);
		});

		test("a modem reporting usb_mode shows the switch DISABLED with a reason when modem_provisioning is absent", async ({
			page,
		}) => {
			record("── USB-mode UI gate (modem_provisioning absent) ──");
			const key = await targetModemKey(page, MODEM_INDEX);

			await patchModem(page, key, {
				usb_mode: "rndis",
				recommended_usb_mode: "mbim",
			});

			await openTargetModemDialog(page, MODEM_INDEX);
			const dialog = page.getByRole("dialog");
			await expect(dialog).toBeVisible();

			const block = dialog.getByTestId("modem-usb-mode");
			await expect(block).toBeVisible();
			await expect(dialog.getByTestId("modem-usb-mode-active")).toContainText(
				"rndis",
				{ ignoreCase: true },
			);
			await expect(
				dialog.getByTestId("modem-usb-mode-recommended"),
			).toBeVisible();

			// The switch control is disabled-with-reason — not a fake-interactive button.
			const switchBtn = dialog.getByTestId("modem-usb-mode-switch");
			await expect(switchBtn).toBeVisible();
			await expect(switchBtn).toBeDisabled();
			await expect(switchBtn).toHaveAttribute("title", /.+/);
			await expect(
				dialog.getByTestId("modem-usb-mode-locked-reason"),
			).toBeVisible();
			record(
				"usb_mode row renders; Switch mode DISABLED with reason (modem_provisioning absent) ✓",
			);
		});

		test("calling modems.setUsbMode DIRECTLY over the socket is refused server-side with provisioning_disabled", async ({
			page,
		}) => {
			record("── USB-mode server-side refusal (direct RPC) ──");
			const result = await directRpc(page, ["modems", "setUsbMode"], {
				device: "0",
				mode: "mbim",
				confirm: true,
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toEqual({
					success: false,
					error: "provisioning_disabled",
				});
			}
			record(
				"direct modems.setUsbMode → { success:false, error:'provisioning_disabled' } server-side ✓",
			);
		});
	},
);
