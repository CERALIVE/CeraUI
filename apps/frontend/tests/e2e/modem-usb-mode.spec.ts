import fs from "node:fs";

import { expect, test } from "./fixtures/index.js";

import { ensureAuthenticated, evidencePath, navigateTo } from "./helpers";
import {
	armFake,
	installWsHarness,
	openTargetModemDialog,
	patchModem,
	targetModemKey,
} from "./modem-config-surface-fixture";

/**
 * `modems.setUsbMode` round-trip against a mocked transition, @functional.
 *
 * Drives the REAL ModemConfigDialog USB-mode card end to end with DOM/ARIA-only
 * assertions. The transition itself is faked at the socket (`armFake`), which is
 * the point: the whole contract under test is what the UI does BETWEEN the RPC
 * reply and the confirming `modems` broadcast, and only a fake can hold those two
 * events apart deterministically.
 *
 * Three legs, in the order a real switch happens:
 *   1. a successful reply alone does NOT flip the displayed mode — the spinner
 *      holds and the card still reads the pre-switch mode;
 *   2. the confirming broadcast (this device reporting the target) flips it;
 *   3. a typed refusal renders inline with its reason and never flips anything.
 *
 * Topology and harness are shared with `modem-config-surface.spec.ts`.
 */

const MODEM_INDEX = 0;

test.describe(
	"modem USB-mode switch — pessimistic confirmation round-trip",
	{ tag: "@functional" },
	() => {
		test.skip(
			({ browserName }) => browserName !== "chromium",
			"single-browser integration proof",
		);

		const evidence: string[] = [];
		const record = (line: string) => evidence.push(line);
		const shot = (surface: string): string => evidencePath(`${surface}.png`);

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
				evidencePath("modem-usb-mode-round-trip.txt"),
				[
					"modems.setUsbMode — pessimistic confirmation round-trip (functional E2E)",
					"Driver: real ModemConfigDialog USB-mode card + usb-mode-flow state machine;",
					"        modem state injected via dev.emit, setUsbMode pinned via drop+fake.",
					`Generated: ${new Date().toISOString()}`,
					"",
					...evidence,
					"",
				].join("\n"),
				"utf8",
			);
		});

		async function seedSwitchableModem(
			page: Parameters<typeof patchModem>[0],
		): Promise<string> {
			const key = await targetModemKey(page, MODEM_INDEX);
			await patchModem(page, key, {
				stable_key: "platform-xhci-hcd.0-usb-1:2",
				usb_mode: "qmi",
				recommended_usb_mode: "mbim",
			});
			// The switch surface exists only for a device that reports a certified
			// target, so a switchable modem has to report one.
			await armFake(page, "modems.getUsbModeOptions", {
				certified: ["mbim", "ecm-ncm"],
			});
			return key;
		}

		test("a successful reply alone does not flip the mode; the confirming broadcast does", async ({
			page,
		}) => {
			record("── setUsbMode: reply ≠ confirmation ──");
			const key = await seedSwitchableModem(page);

			// The fake reply never lands a broadcast with it, so the ONLY thing that
			// can flip the card is the snapshot injected further down.
			await armFake(page, "modems.setUsbMode", { success: true });

			await openTargetModemDialog(page, MODEM_INDEX);
			const dialog = page.getByRole("dialog");
			await expect(dialog).toBeVisible();

			const card = dialog.getByTestId("modem-usb-mode-card");
			await expect(card).toBeVisible();
			await expect(dialog.getByTestId("modem-usb-mode-active")).toHaveAttribute(
				"data-usb-mode",
				"qmi",
			);
			record("active mode before the switch: qmi");

			await dialog.getByTestId("modem-usb-mode-target-mbim").click();
			await dialog.getByRole("button", { name: /Switch to/i }).click();
			await page.getByRole("button", { name: /Switch mode/i }).click();

			// The RPC has resolved successfully. Nothing else has happened.
			await expect(dialog.getByTestId("modem-usb-mode-switching")).toBeVisible();
			await expect(dialog.getByTestId("modem-usb-mode-active")).toHaveAttribute(
				"data-usb-mode",
				"qmi",
			);
			await expect(
				dialog.getByTestId("modem-usb-mode-confirmed"),
			).toHaveCount(0);
			record("after a SUCCESSFUL reply: spinner held, active mode still qmi");

			// Now the device itself reports the new composition.
			await patchModem(page, key, { usb_mode: "mbim" });

			await expect(dialog.getByTestId("modem-usb-mode-confirmed")).toBeVisible();
			await expect(dialog.getByTestId("modem-usb-mode-active")).toHaveAttribute(
				"data-usb-mode",
				"mbim",
			);
			record("after the confirming broadcast: active mode flipped to mbim");
		});

		test("a typed refusal renders inline and flips nothing", async ({
			page,
		}) => {
			record("── setUsbMode: typed refusal ──");
			await seedSwitchableModem(page);

			// `uncertified` is what EVERY real modem gets today: the shipped catalog
			// carries no reviewed evidence bundle for any shipping SKU.
			await armFake(page, "modems.setUsbMode", {
				success: false,
				error: "uncertified",
			});

			await openTargetModemDialog(page, MODEM_INDEX);
			const dialog = page.getByRole("dialog");
			await dialog.getByTestId("modem-usb-mode-target-mbim").click();
			await dialog.getByRole("button", { name: /Switch to/i }).click();
			await page.getByRole("button", { name: /Switch mode/i }).click();

			const band = dialog.getByTestId("modem-usb-mode-error");
			await expect(band).toBeVisible();
			await expect(band).toContainText(/certified/i);
			await expect(dialog.getByTestId("modem-usb-mode-active")).toHaveAttribute(
				"data-usb-mode",
				"qmi",
			);
			await expect(
				dialog.getByTestId("modem-usb-mode-switching"),
			).toHaveCount(0);
			record("refusal rendered inline; active mode unchanged (qmi)");
		});

		/*
		  THE CLASSIFIED OUTCOME, RENDERED — the half a generic error banner throws
		  away.

		  Both legs arm the SAME procedure with the SAME `transition_failed` /
		  `transaction_error` pair and differ only in the classification riding
		  beside it, which is exactly the point: the wire word for "the transaction
		  blew up" cannot separate a daemon that was busy from a write whose reply
		  never came back, and before this the operator got one red sentence for
		  both.
		*/
		test("a retryable daemon refusal renders its own state, not a generic error", async ({
			page,
		}) => {
			record("── setUsbMode: retryable daemon refusal ──");
			await seedSwitchableModem(page);

			await armFake(page, "modems.setUsbMode", {
				success: false,
				error: "transition_failed",
				reason: "transaction_error",
				operation: {
					status: "refused",
					completion: "failed",
					reason: "InProgress",
					refusal: "busy",
					retryable: true,
				},
			});

			await openTargetModemDialog(page, MODEM_INDEX);
			const dialog = page.getByRole("dialog");
			await dialog.getByTestId("modem-usb-mode-target-mbim").click();
			await dialog.getByRole("button", { name: /Switch to/i }).click();
			await page.getByRole("button", { name: /Switch mode/i }).click();

			const band = dialog.getByTestId("modem-usb-mode-error");
			await expect(band).toBeVisible();
			await expect(
				dialog.getByTestId("modem-usb-mode-outcome"),
			).toHaveAttribute("data-outcome", "refused");
			// The three things a generic banner cannot say: what it MEANS, what the
			// device actually reported, and whether trying again could help.
			await expect(
				dialog.getByTestId("modem-usb-mode-outcome-result"),
			).toBeVisible();
			await expect(
				dialog.getByTestId("modem-usb-mode-outcome-completion"),
			).toBeVisible();
			await expect(
				dialog.getByTestId("modem-usb-mode-outcome-retry"),
			).toBeVisible();
			// A retryable refusal is NOT a reconciliation case.
			await expect(
				dialog.getByTestId("modem-usb-mode-outcome-reconciliation"),
			).toHaveCount(0);
			await expect(dialog.getByTestId("modem-usb-mode-active")).toHaveAttribute(
				"data-usb-mode",
				"qmi",
			);
			record(
				"busy → result + completion + retry hint rendered; no reconciliation pointer",
			);
			await dialog
				.getByTestId("modem-usb-mode-card")
				.screenshot({ path: shot("usb-mode-refusal-retryable") });
		});

		test("an unknown outcome routes to reconciliation and is never findable as an error", async ({
			page,
		}) => {
			record("── setUsbMode: unknown outcome ──");
			await seedSwitchableModem(page);

			await armFake(page, "modems.setUsbMode", {
				success: false,
				error: "transition_failed",
				reason: "transaction_error",
				operation: {
					status: "unknown-outcome",
					completion: "timed-out",
					reason: "write-reply-timed-out",
					requires_reconciliation: true,
					retryable: false,
				},
			});

			await openTargetModemDialog(page, MODEM_INDEX);
			const dialog = page.getByRole("dialog");
			await dialog.getByTestId("modem-usb-mode-target-mbim").click();
			await dialog.getByRole("button", { name: /Switch to/i }).click();
			await page.getByRole("button", { name: /Switch mode/i }).click();

			await expect(
				dialog.getByTestId("modem-usb-mode-unknown-outcome"),
			).toBeVisible();
			await expect(
				dialog.getByTestId("modem-usb-mode-outcome"),
			).toHaveAttribute("data-outcome", "unknown");
			await expect(
				dialog.getByTestId("modem-usb-mode-outcome-reconciliation"),
			).toBeVisible();
			// Never a success claim, never a failure claim, never a retry.
			await expect(dialog.getByTestId("modem-usb-mode-error")).toHaveCount(0);
			await expect(
				dialog.getByTestId("modem-usb-mode-confirmed"),
			).toHaveCount(0);
			await expect(
				dialog.getByTestId("modem-usb-mode-outcome-retry"),
			).toHaveCount(0);
			await expect(dialog.getByTestId("modem-usb-mode-active")).toHaveAttribute(
				"data-usb-mode",
				"qmi",
			);
			record(
				"unknown-outcome → reconciliation band; no error band, no success, no retry",
			);
			await dialog
				.getByTestId("modem-usb-mode-card")
				.screenshot({ path: shot("usb-mode-unknown-outcome") });
		});

		// ── Certified-modes-only: the four device classes, rendered ──────────────
		// The card must offer EXACTLY the certified set and, for a device that has
		// none, no control at all. "No control" is asserted as an absence of every
		// affordance — a disabled button would pass a naive visibility check while
		// still implying a capability the device does not have.
		test("renders ONLY the certified modes, and no control for a device that has none", async ({
			page,
		}) => {
			record("── certified-modes-only: the four device classes ──");
			const key = await targetModemKey(page, MODEM_INDEX);
			const dialog = page.getByRole("dialog");

			async function openWith(
				patch: Record<string, unknown>,
				options: unknown,
			): Promise<void> {
				await patchModem(page, key, patch);
				await armFake(page, "modems.getUsbModeOptions", options);
				await openTargetModemDialog(page, MODEM_INDEX);
				await expect(dialog.getByTestId("modem-usb-mode-card")).toBeVisible();
			}

			/**
			 * Capture the card as EVIDENCE. It sits at the bottom of a scrollable
			 * dialog body, so without scrolling it into view first the element
			 * screenshot is clipped and the very band the leg is proving falls
			 * outside the image.
			 */
			async function captureCard(name: string): Promise<void> {
				const card = dialog.getByTestId("modem-usb-mode-card");
				await card.scrollIntoViewIfNeeded();
				await card.screenshot({ path: shot(name) });
			}

			async function closeDialog(): Promise<void> {
				await dialog.getByRole("button", { name: "Close" }).first().click();
				await expect(dialog).toHaveCount(0);
			}

			/** Every affordance that could switch a mode. All must be absent. */
			async function expectNoControl(): Promise<void> {
				await expect(dialog.getByTestId("modem-usb-mode-targets")).toHaveCount(
					0,
				);
				await expect(dialog.getByTestId("modem-usb-mode-switch")).toHaveCount(
					0,
				);
				await expect(
					dialog.getByRole("button", { name: /Switch to/i }),
				).toHaveCount(0);
				await expect(dialog.getByRole("radio")).toHaveCount(0);
			}

			// (1) CERTIFIED — the exact mode set, and nothing else.
			await openWith(
				{
					stable_key: "platform-xhci-hcd.0-usb-1:2",
					usb_mode: "qmi",
					recommended_usb_mode: "mbim",
					device_class: "usb",
				},
				{ certified: ["mbim", "ecm-ncm"], active: "qmi" },
			);
			const targets = dialog.getByTestId("modem-usb-mode-targets");
			await expect(targets).toBeVisible();
			// Assert the mode the device is IN before asserting what it is offered:
			// a late broadcast overwriting the patched composition would otherwise
			// surface as a confusing "wrong number of radios".
			await expect(dialog.getByTestId("modem-usb-mode-active")).toHaveAttribute(
				"data-usb-mode",
				"qmi",
			);
			await expect(targets.getByRole("radio")).toHaveCount(2);
			await expect(
				dialog.getByTestId("modem-usb-mode-target-mbim"),
			).toBeVisible();
			await expect(
				dialog.getByTestId("modem-usb-mode-target-ecm-ncm"),
			).toBeVisible();
			// The mode the device is IN is never a target.
			await expect(
				dialog.getByTestId("modem-usb-mode-target-qmi"),
			).toHaveCount(0);
			await captureCard("usb-mode-certified");
			record("certified fixture: exactly [mbim, ecm-ncm]; qmi absent");
			await closeDialog();

			// (2) UNKNOWN MODEL/FIRMWARE — no control, and an honest reason.
			await openWith(
				{
					stable_key: "platform-xhci-hcd.0-usb-1:3",
					usb_mode: "qmi",
					recommended_usb_mode: "mbim",
					device_class: "usb",
				},
				{ certified: [], suppressed: "uncertified", active: "qmi" },
			);
			const uncertified = dialog.getByTestId("modem-usb-mode-unavailable");
			await expect(uncertified).toBeVisible();
			await expect(uncertified).toHaveAttribute(
				"data-usb-mode-withheld",
				"uncertified",
			);
			await expectNoControl();
			// The card still REPORTS the active mode — only the control is withdrawn.
			await expect(dialog.getByTestId("modem-usb-mode-active")).toHaveAttribute(
				"data-usb-mode",
				"qmi",
			);
			await captureCard("usb-mode-unknown-firmware");
			record("unknown-firmware fixture: NO control; active mode still reported");
			await closeDialog();

			// (3) NATIVE PCIe — no USB composition exists, so no control.
			await openWith(
				{
					stable_key: "pci-0000:01:00.0",
					usb_mode: "mbim",
					recommended_usb_mode: "mbim",
					device_class: "pcie-mtk",
				},
				{ certified: [], suppressed: "identity_unresolved" },
			);
			const pcie = dialog.getByTestId("modem-usb-mode-unavailable");
			await expect(pcie).toHaveAttribute(
				"data-usb-mode-withheld",
				"identity_unresolved",
			);
			await expectNoControl();
			await captureCard("usb-mode-native-pcie");
			record("native-PCIe fixture: NO control (identity_unresolved)");
			await closeDialog();

			// (4) UFI STICK — a router-ethernet row. The guarantee here is stronger
			// than "no control", which is why this leg asserts a different shape
			// from the three above: the dialog that would host a control is itself
			// UNREACHABLE, because the dongle owns its own settings and its
			// Configure button is disabled-with-reason. A composition switch has no
			// surface to live on at all — which is precisely why the
			// `sethimiusbtether` fence is a grep gate over the source rather than a
			// UI state anyone could assert on.
			await patchModem(page, key, {
				usb_mode: undefined,
				recommended_usb_mode: undefined,
				device_class: "router-ethernet",
				availability_reason: "router_direct",
			});

			const configure = page.getByTestId("open-modem-config-dialog").nth(
				MODEM_INDEX,
			);
			await expect(configure).toBeDisabled();
			// Disabled WITH its reason, on screen and in the accessible name.
			await expect(configure).toHaveAttribute("title", /.+/);
			await expect(configure).toHaveAttribute("aria-label", /.+/);
			// Nothing anywhere on the page offers a composition switch.
			// Scoped to the cellular section: at page scope `/Switch to/i` also
			// matches app chrome such as the theme toggle's "Switch to dark mode".
			const cellular = page
				.locator("section")
				.filter({ has: page.getByTestId("modem-row") })
				.first();
			await expect(
				cellular.getByRole("button", { name: /Switch to/i }),
			).toHaveCount(0);
			await expect(page.getByTestId("modem-usb-mode-card")).toHaveCount(0);
			await expect(page.getByTestId("modem-usb-mode-targets")).toHaveCount(0);
			await cellular
				.screenshot({ path: shot("usb-mode-ufi-no-control") });
			record(
				"UFI fixture: Configure disabled-with-reason; no USB-mode card and no switch anywhere",
			);
		});
	},
);
