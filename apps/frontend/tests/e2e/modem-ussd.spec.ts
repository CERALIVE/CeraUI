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
 * The USSD dialogue, end to end in a real browser, @functional.
 *
 * The unit suites cover the rule and the rendered states; what only a browser
 * can prove is the two properties that span the whole session rather than one
 * render:
 *
 *  1. a full dialogue actually round-trips — code in, menu out, answer in, reply
 *     out, closed — through the REAL component against socket-level fakes, which
 *     is the only way to hold the RPC reply and the session snapshot apart
 *     deterministically;
 *  2. neither direction of that dialogue leaks. Both carry subscriber content, so
 *     the spec greps the live document AND every console channel for the fixture
 *     strings, then greps again after the operator starts over — at which point
 *     the carrier's text must be gone from the page entirely.
 *
 * Topology and harness are shared with `modem-config-surface.spec.ts`.
 */

const MODEM_INDEX = 0;

/**
 * Shaped like the content that actually leaks — a voucher-looking code and a
 * balance. A fixture of `"test"` would pass a containment grep that a real
 * dialogue fails, because that string occurs in ordinary markup.
 */
const COMMAND = "*611*4242118899#";
const MENU = "1. Balance 2. Top up 3. My number";
const BALANCE = "Your balance is COP 17,400 and expires 2026-09-30.";

test.describe(
	"modem USSD — the session surface",
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
				evidencePath("modem-ussd-session.txt"),
				[
					"modems.getUssd / ussdInitiate / ussdRespond / ussdCancel — session surface (functional E2E)",
					"Driver: real ModemUssdSection inside ModemConfigDialog; USSD verbs pinned via drop+fake.",
					`Generated: ${new Date().toISOString()}`,
					"",
					...evidence,
					"",
					"NOTE: the fixture code and replies are synthetic. No real subscriber",
					"content is used, and the strings are never written to this file.",
				].join("\n"),
				"utf8",
			);
		});

		/** Claim the modem can do USSD, and pin the read the section makes on mount. */
		async function armSection(
			page: import("./fixtures/index.js").Page,
			key: string,
		): Promise<void> {
			await armFake(page, "modems.getUssd", {
				success: true,
				session: { state: "idle" },
			});
			await patchModem(page, key, {
				capability_modules: {
					"band-lock": "unavailable",
					sms: "unavailable",
					"five-g-pref": "unavailable",
					"fcc-auto-unlock": "unavailable",
					gps: "unavailable",
					ussd: "capable",
					esim: "unavailable",
				},
			});
		}

		test("a modem with no USSD claim renders no USSD surface at all", async ({
			page,
		}) => {
			const key = await targetModemKey(page, MODEM_INDEX);
			await patchModem(page, key, {
				capability_modules: {
					"band-lock": "unavailable",
					sms: "unavailable",
					"five-g-pref": "unavailable",
					"fcc-auto-unlock": "unavailable",
					gps: "unavailable",
					ussd: "unavailable",
					esim: "unavailable",
				},
			});
			await openTargetModemDialog(page, MODEM_INDEX, key);

			const dialog = page.getByRole("dialog").first();
			await expect(dialog.getByTestId("modem-ussd")).toHaveCount(0);
			await expect(dialog.getByTestId("modem-ussd-session")).toHaveCount(0);
			await expect(dialog.getByTestId("modem-ussd-command")).toHaveCount(0);
			record("no-claim modem: 0 USSD nodes rendered");
		});

		test("a dialogue round-trips, and neither direction leaks", async ({
			page,
		}) => {
			const logged: string[] = [];
			page.on("console", (message) => logged.push(message.text()));
			page.on("pageerror", (error) => logged.push(String(error)));

			const key = await targetModemKey(page, MODEM_INDEX);
			await armSection(page, key);
			await openTargetModemDialog(page, MODEM_INDEX, key);

			const dialog = page.getByRole("dialog").first();
			const section = dialog.getByTestId("modem-ussd-session");
			await expect(section).toBeVisible();

			// ── initiate ─────────────────────────────────────────────────────────
			await armFake(page, "modems.ussdInitiate", {
				success: true,
				session: { state: "awaiting-reply" },
				ussdReply: MENU,
			});
			await dialog.getByTestId("modem-ussd-command").fill(COMMAND);
			await dialog.getByTestId("modem-ussd-send").click();

			await expect(dialog.getByTestId("modem-ussd-reply")).toContainText(
				"1. Balance",
			);
			await expect(section).toHaveAttribute(
				"data-session-state",
				"awaiting-reply",
			);
			// The code is out of the page the instant it is dispatched.
			await expect(page.locator("body")).not.toContainText(COMMAND);
			record("initiate: menu rendered, command cleared from the page");

			// ── a second dialogue is refused HERE, with no RPC dispatched ────────
			await expect(dialog.getByTestId("modem-ussd-command")).toHaveCount(0);
			await expect(dialog.getByTestId("modem-ussd-send")).toHaveCount(0);
			record("second initiate: no command control offered while the slot is held");

			// ── respond ──────────────────────────────────────────────────────────
			await armFake(page, "modems.ussdRespond", {
				success: true,
				session: { state: "closed", outcome: "completed" },
				ussdReply: BALANCE,
			});
			await dialog.getByTestId("modem-ussd-response").fill("1");
			await dialog.getByTestId("modem-ussd-respond").click();

			await expect(dialog.getByTestId("modem-ussd-reply")).toContainText(
				"balance is COP",
			);
			await expect(dialog.getByTestId("modem-ussd-outcome")).toHaveAttribute(
				"data-outcome",
				"applied",
			);
			await expect(section).toHaveAttribute("data-session-outcome", "completed");
			record("respond: reply rendered, dialogue closed as completed");

			// ── the carrier's text lives in ONE node, and goes when the operator
			//    starts over ───────────────────────────────────────────────────────
			await expect(dialog.getByTestId("modem-ussd-reply")).toHaveCount(1);
			await dialog.getByTestId("modem-ussd-new").click();
			await expect(dialog.getByTestId("modem-ussd-reply")).toHaveCount(0);

			const rendered = await page.evaluate(
				() => `${document.body.innerHTML}\u0000${document.body.textContent ?? ""}`,
			);
			expect(rendered).not.toContain(COMMAND);
			expect(rendered).not.toContain(BALANCE);
			expect(rendered).not.toContain(MENU);
			record("start over: no fixture string survives anywhere in the document");

			const consoleText = logged.join("\u0000");
			for (const secret of [COMMAND, MENU, BALANCE]) {
				expect(consoleText).not.toContain(secret);
			}
			record(`console: ${logged.length} messages, 0 containing dialogue text`);
		});

		test("an unanswered dialogue ends in an explicit unknown, not a spinner", async ({
			page,
		}) => {
			const key = await targetModemKey(page, MODEM_INDEX);
			await armSection(page, key);
			await openTargetModemDialog(page, MODEM_INDEX, key);

			const dialog = page.getByRole("dialog").first();
			await armFake(page, "modems.ussdInitiate", {
				success: true,
				session: { state: "closed", outcome: "timed-out" },
			});
			await dialog.getByTestId("modem-ussd-command").fill("*611#");
			await dialog.getByTestId("modem-ussd-send").click();

			const band = dialog.getByTestId("modem-ussd-outcome");
			await expect(band).toHaveAttribute("data-outcome", "unknown");
			await expect(band).toContainText(/unknown/i);
			await expect(dialog.getByTestId("modem-ussd-working")).toHaveCount(0);
			// The command form is back: the operator decides whether to try again.
			await expect(dialog.getByTestId("modem-ussd-command")).toBeVisible();
			record("timeout: unknown-outcome band, spinner retired, no auto-retry");
		});

		test("a carrier that will not carry USSD says so in its own words", async ({
			page,
		}) => {
			const key = await targetModemKey(page, MODEM_INDEX);
			await armSection(page, key);
			await openTargetModemDialog(page, MODEM_INDEX, key);

			const dialog = page.getByRole("dialog").first();
			await armFake(page, "modems.ussdInitiate", {
				success: false,
				error: "lte-only-unsupported",
				session: {
					state: "closed",
					outcome: "failed",
					refusal: "lte-only-unsupported",
				},
			});
			await dialog.getByTestId("modem-ussd-command").fill("*611#");
			await dialog.getByTestId("modem-ussd-send").click();

			const policy = dialog.getByTestId("modem-ussd-policy");
			await expect(policy).toBeVisible();
			await expect(policy).toHaveAttribute(
				"data-ussd-policy",
				"lte-only-unsupported",
			);
			// It says the DEVICE is fine — that is the whole reason it is its own band.
			await expect(policy).toContainText(/nothing to fix|nothing is wrong/i);
			// And it never doubles as the generic device-refusal line.
			await expect(dialog.getByTestId("modem-ussd-reason")).toHaveCount(0);
			record("lte-only-unsupported: dedicated policy band, no generic refusal line");
		});
	},
);
