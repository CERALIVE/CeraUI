import { expect, test } from "./fixtures/index.js";

import { closeDialog } from "./helpers/aria.js";
import { navigateTo } from "./helpers/index.js";

/**
 * The capability-gate Settings surface is REACHABLE — the gap this closes.
 *
 * Board validation (`.omo/evidence/task-49-full-stack-board-validation.md`)
 * found the band-lock and GPS controls telling operators to turn a feature on
 * "in settings" while a full `#settings` sweep matched ZERO testids against
 * `modem|cellular|location|gps|band|capab`. The copy pointed at a setting that
 * did not exist anywhere in the UI.
 *
 * The first test below is that sweep, inverted: it runs the SAME discovery an
 * operator (and that audit) would, and fails on the pre-fix tree. Everything
 * after it drives the real RPC round-trip against this worker's mock backend —
 * no injected frames, because `modems.getCapabilities`/`setCapabilities` are
 * plain authed procedures that answer from runtime config.
 *
 * PLAYBOOK.md compliance: role / testid / web-first assertions only. The gate is
 * restored to OFF at the end of each mutating test, since `saveConfig()` really
 * does persist it for the worker's backend.
 */

const DIALOG_NAME = "Cellular Features";
const IMPLEMENTED = ["band-lock", "five-g-pref", "gps", "ussd"] as const;
const NOT_IMPLEMENTED = ["sms", "esim", "fcc-auto-unlock"] as const;

async function openCapabilities(page: import("@playwright/test").Page) {
	await navigateTo(page, "settings");
	const entry = page.getByTestId("settings-entry-modemCapabilities");
	await expect(entry).toBeVisible();
	await entry.click();
	await expect(page.getByTestId("modem-capabilities")).toBeVisible();
}

async function readGate(
	page: import("@playwright/test").Page,
	module: string,
): Promise<boolean> {
	const toggle = page.getByTestId(`modem-capability-toggle-${module}`);
	await expect(toggle).toBeVisible();
	return (await toggle.getAttribute("aria-checked")) === "true";
}

/** Drive a gate to a KNOWN state, whatever the device was already carrying. */
async function setGate(
	page: import("@playwright/test").Page,
	module: string,
	want: boolean,
): Promise<void> {
	const toggle = page.getByTestId(`modem-capability-toggle-${module}`);
	if ((await readGate(page, module)) !== want) {
		await toggle.click();
	}
	await expect(toggle).toHaveAttribute("aria-checked", String(want));
}

test.describe("the settings surface the GPS copy points at", () => {
	test("a #settings sweep now FINDS a capability surface", async ({ authedPage: page }) => {
		await navigateTo(page, "settings");
		// The audit's own probe: every testid on the Settings destination, matched
		// against the pattern that previously returned nothing.
		const matches = await page.evaluate(() =>
			Array.from(document.querySelectorAll("[data-testid]"))
				.map((el) => el.getAttribute("data-testid") ?? "")
				.filter((id) => /modem|cellular|location|gps|band|capab/i.test(id)),
		);
		expect(matches.length).toBeGreaterThan(0);
		expect(matches).toContain("settings-entry-modemCapabilities");
	});

	test("the entry opens a dialog", async ({ authedPage: page }) => {
		await openCapabilities(page);
		await expect(page.getByTestId("modem-capabilities-honesty")).toBeVisible();
		await closeDialog(page, DIALOG_NAME);
	});
});

test.describe("CT-1 — implemented modules get a row, the rest get nothing", () => {
	test("every implemented module renders a labelled switch", async ({
		authedPage: page,
	}) => {
		await openCapabilities(page);
		for (const module of IMPLEMENTED) {
			await expect(
				page.getByTestId(`modem-capability-row-${module}`),
			).toBeVisible();
			await expect(
				page.getByTestId(`modem-capability-toggle-${module}`),
			).toBeVisible();
		}
		await closeDialog(page, DIALOG_NAME);
	});

	test("an unimplemented module renders ZERO nodes — not a disabled switch", async ({
		authedPage: page,
	}) => {
		await openCapabilities(page);
		for (const module of NOT_IMPLEMENTED) {
			await expect(
				page.getByTestId(`modem-capability-row-${module}`),
			).toHaveCount(0);
			await expect(
				page.getByTestId(`modem-capability-toggle-${module}`),
			).toHaveCount(0);
		}
		await closeDialog(page, DIALOG_NAME);
	});

	test("no row renders a raw dotted i18n key", async ({ authedPage: page }) => {
		await openCapabilities(page);
		const text =
			(await page.getByTestId("modem-capabilities").textContent()) ?? "";
		expect(text).not.toMatch(/settings\.modemCapabilities\./);
		expect(text.trim().length).toBeGreaterThan(0);
		await closeDialog(page, DIALOG_NAME);
	});
});

test.describe("the gate round-trips through the device", () => {
	// These tests WRITE: `setCapabilities` calls `saveConfig()`, so they share one
	// mutable config per worker backend. Serial mode is what stops two of them
	// interleaving writes to the same file and reading each other's gates.
	test.describe.configure({ mode: "serial" });

	test("turning GPS on persists, and survives closing and reopening", async ({
		authedPage: page,
	}) => {
		await openCapabilities(page);
		await setGate(page, "gps", false);

		await setGate(page, "gps", true);

		// Re-open: the switch is seeded from `modems.getCapabilities`, so this
		// proves the DEVICE persisted it rather than the component remembering.
		await closeDialog(page, DIALOG_NAME);
		await openCapabilities(page);
		await expect(
			page.getByTestId("modem-capability-toggle-gps"),
		).toHaveAttribute("aria-checked", "true");

		await setGate(page, "gps", false);
		await closeDialog(page, DIALOG_NAME);
	});

	test("one module's gate does not move its neighbours", async ({
		authedPage: page,
	}) => {
		await openCapabilities(page);
		const neighbours = ["gps", "ussd", "five-g-pref"] as const;
		// The INVARIANT is "unchanged", not "off" — reading the neighbours first
		// keeps this true whatever the device happened to be carrying.
		const before = await Promise.all(
			neighbours.map((module) => readGate(page, module)),
		);

		await setGate(page, "band-lock", true);
		for (const [index, module] of neighbours.entries()) {
			await expect(
				page.getByTestId(`modem-capability-toggle-${module}`),
			).toHaveAttribute("aria-checked", String(before[index]));
		}

		await setGate(page, "band-lock", false);
		await closeDialog(page, DIALOG_NAME);
	});

	test("no refusal band appears for a module this build ships", async ({
		authedPage: page,
	}) => {
		await openCapabilities(page);
		const restore = await readGate(page, "ussd");

		await setGate(page, "ussd", !restore);
		await expect(page.getByTestId("modem-capabilities-refused")).toHaveCount(0);
		await expect(page.getByTestId("modem-capabilities-load-failed")).toHaveCount(
			0,
		);

		await setGate(page, "ussd", restore);
		await closeDialog(page, DIALOG_NAME);
	});
});
