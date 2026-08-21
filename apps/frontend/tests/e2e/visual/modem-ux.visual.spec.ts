import fs from "node:fs";
import path from "node:path";

import type { Locator, Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "../fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "../helpers/index.js";
import { openModemAdvanced } from "../helpers/modem-advanced.js";

/**
 * @visual + programmatic gate for the modem-stack Phase-B operator surfaces
 * (todo 29). Covers the three surfaces waves 4-5 introduced:
 *
 *   · `CellularSection`'s per-device rows across its full class/state table
 *     (todo 26) plus the `cellular-initializing` band (todo 28);
 *   · `ModemConfigDialog`'s three instrument cards + the Auto-APN default
 *     (todo 27), and the USB-mode card's THREE mutually-exclusive terminal
 *     presentations (todos 27/28);
 *   · `EthernetSection`'s isolated-dongle row across `up`/`acquiring`/`down`
 *     (todo 19).
 *
 * EVERY criterion here is a PASS/FAIL assertion the suite makes itself. The PNGs
 * are evidence for a human reader, never the check — nothing in this file passes
 * or fails on how a capture looks. The two assertions that would otherwise be
 * eyeball work are made mechanical instead:
 *
 *   1. the three USB-mode terminals are proven pairwise distinct in their TEXT
 *      and their non-colour STRUCTURE, so an operator who cannot see colour
 *      still reads three different answers (todo 28 flagged this as the gate
 *      this todo must close);
 *   2. the three dongle lifecycle states are proven to draw three DIFFERENT
 *      glyphs, by comparing the rendered SVG geometry rather than a class name.
 *
 * Determinism: the page socket is proxied. The backend's own `status` / `config`
 * / `netif` echoes are DROPPED so the injected roster is the only truth on
 * screen (the per-worker `multi-modem-wifi` backend publishes three modems of
 * its own, which would otherwise race every row assertion), and
 * `modems.setUsbMode` is answered client-side so a typed refusal is reachable
 * without real hardware — the same drop+fake shape `truthfulness.spec.ts` and
 * `modem-usb-mode.spec.ts` already use.
 */

// visual -> e2e -> tests -> frontend -> apps -> CeraUI (repo root). Repo-local and
// gitignored; tests never write above the checkout (root AGENTS.md Rule D).
const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../../../test-results/modem-phase-b/29",
);

// ── Proxy control state (reset per test) ─────────────────────────────────────
let pageWs: WebSocketRoute | null = null;
let usbModeReply: Record<string, unknown> | null = null;

function send(payload: unknown): void {
	pageWs?.send(JSON.stringify(payload));
}

/** A configured server keeps the shell out of its empty state. */
function serverConfig(extra: Record<string, unknown> = {}): void {
	send({
		config: {
			srtla_addr: "127.0.0.1",
			srtla_port: 5000,
			srt_streamid: "e2e",
			max_br: 6000,
			pipeline: "hdmi",
			...extra,
		},
	});
}

function sendModems(modems: Record<string, unknown>): void {
	send({ status: { modems } });
}

function sendNetif(netif: Record<string, unknown>): void {
	send({ netif });
}

// ── Roster fixtures ──────────────────────────────────────────────────────────
// One entry per row of todo 26's state table. They are injected together so a
// single capture carries the whole table and the assertions compare siblings
// rendered under identical conditions.

const MM_HEALTHY_ID = "mm-healthy";
const MM_HEALTHY_NAME = "Quectel RM520N";

function mmManaged(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ifname: "wwan0",
		name: MM_HEALTHY_NAME,
		network_type: { supported: ["5g", "lte"], active: "lte" },
		config: {
			apn: "",
			username: "",
			password: "",
			roaming: false,
			network: "",
		},
		status: {
			connection: "connected",
			network_type: "lte",
			signal: 71,
			roaming: false,
			network: "Test Carrier",
		},
		no_sim: false,
		device_class: "usb",
		slot_label: "SIM 1",
		stable_key: "pci-0000:00:14.0-usb-0:2",
		usb_mode: "rndis",
		recommended_usb_mode: "mbim",
		...extra,
	};
}

// The router-dongle rows deliberately carry NO `status` block: the backend
// refuses to fabricate a zeroed one, and "absence renders as absence" is only
// exercised by a payload that really omits it.
function routerDongle(
	availability_reason: "router_managed" | "dongle_acquiring" | "dongle_down",
	slot: number,
): Record<string, unknown> {
	return {
		ifname: `dg${slot}h`,
		name: `Cellular dongle ${slot}`,
		network_type: { supported: [], active: null },
		device_class: "router-ethernet",
		availability_reason,
		slot_label: `Dongle ${slot}`,
	};
}

/** todo 26's full state table, one modem per row, in table order. */
const STATE_TABLE: ReadonlyArray<{
	readonly id: string;
	readonly state: string;
	readonly modem: Record<string, unknown>;
}> = [
	{ id: MM_HEALTHY_ID, state: "connected", modem: mmManaged() },
	{
		id: "mm-registering",
		state: "registered",
		modem: mmManaged({
			ifname: "wwan1",
			name: "Fibocom FM350",
			device_class: "pcie-mhi",
			slot_label: "SIM 2",
			stable_key: "pci-0000:01:00.0",
			status: {
				connection: "registered",
				network_type: "5g",
				signal: 35,
				roaming: false,
			},
		}),
	},
	{
		id: "mm-locked",
		state: "locked",
		modem: mmManaged({
			ifname: "wwan2",
			name: "Sierra EM9191",
			slot_label: "SIM 3",
			stable_key: "pci-0000:00:14.0-usb-0:4",
			status: undefined,
			sim_lock: { required: "sim-pin", remainingAttempts: 3 },
		}),
	},
	{ id: "dongle-up", state: "router-up", modem: routerDongle("router_managed", 0) },
	{
		id: "dongle-acquiring",
		state: "router-acquiring",
		modem: routerDongle("dongle_acquiring", 1),
	},
	{ id: "dongle-down", state: "router-down", modem: routerDongle("dongle_down", 2) },
	{
		id: "unmanaged",
		state: "unknown",
		modem: {
			ifname: "wwx0",
			name: "Unrecognised WWAN",
			network_type: { supported: [], active: null },
			device_class: "thunderbolt-wwan",
		},
	},
];

function fullStateRoster(): Record<string, unknown> {
	return Object.fromEntries(STATE_TABLE.map((row) => [row.id, row.modem]));
}

/** The Phase-B detail payload every dialog card reads. */
const FULL_DETAIL = {
	firmware_revision: "RM520NGLAAR01A08M4G",
	cell_info: {
		tech: "nr",
		band: "n78",
		cell_id: "0x1A2B3C",
		rsrp: -92,
		rsrq: -11,
		sinr: 18,
		provenance: { source: "qmi", observed_at: 1_770_000_000 },
	},
	esim: { sim_type: "esim", esim_status: "with-profiles" },
	data_usage: {
		session_bytes: 1_572_864,
		cycle_bytes: 3_221_225_472,
		cycle_day: 17,
		threshold_bytes: 10_737_418_240,
	},
};

/** The three isolated-dongle lifecycle states, as ONE netif frame (todo 19). */
const DONGLE_NETIF: Record<string, unknown> = {
	eth0: { ip: "192.168.1.50", tp: 0, enabled: true },
	dg0h: {
		ip: "10.208.0.1",
		tp: 0,
		enabled: true,
		dongle: { slot: 0, state: "up" },
	},
	dg1h: { tp: 0, enabled: false, dongle: { slot: 1, state: "acquiring" } },
	dg2h: { tp: 0, enabled: false, dongle: { slot: 2, state: "down" } },
};

// ── Locators ─────────────────────────────────────────────────────────────────
// Both sections are located by the content they own rather than a new testid, so
// this gate stays test-only and adds nothing to shipped markup.

const cellularSection = (page: Page): Locator =>
	page.locator("section").filter({ has: page.getByTestId("modem-row") }).first();

const ethernetSection = (page: Page): Locator =>
	page.locator("section").filter({ has: page.getByTestId("netif-dongle") }).first();

const modemRow = (page: Page, id: string): Locator =>
	page.locator(`[data-testid="modem-row"][data-modem-id="${id}"]`);

// ── Conditions ───────────────────────────────────────────────────────────────
// The three viewports the gate requires. `kiosk` also enters TOUCH layout mode:
// 1024x600 is the shipped panel (docs/TOUCHSCREEN.md), and a kiosk capture taken
// in default layout is not a kiosk capture. `?mode=touch` is applied at NAVIGATION
// so `data-layout-mode` is set before first paint — setting it after load measures
// the pre-lift geometry (recorded in the todo-26 notes).

type Condition = {
	readonly name: string;
	readonly project: "desktop" | "mobile";
	readonly viewport: { width: number; height: number };
	readonly touch?: boolean;
};

const CONDITIONS: readonly Condition[] = [
	{ name: "desktop", project: "desktop", viewport: { width: 1280, height: 800 } },
	{
		name: "kiosk-1024x600",
		project: "desktop",
		viewport: { width: 1024, height: 600 },
		touch: true,
	},
	{ name: "mobile", project: "mobile", viewport: { width: 390, height: 844 } },
];

/**
 * A colour-independent signature of one USB-mode terminal presentation.
 *
 * `text` is what an operator reads and what a screen reader announces; `shape`
 * is the structure a monochrome display still conveys (ARIA role, whether the
 * switch is offered at all, whether it is disabled). Neither carries a colour,
 * so two states with different signatures are distinguishable with colour
 * removed — which is exactly the property this gate has to prove.
 */
type TerminalSignature = {
	readonly text: string;
	readonly shape: string;
};

async function usbTerminalSignature(dialog: Locator): Promise<TerminalSignature> {
	const card = dialog.getByTestId("modem-usb-mode-card");
	await expect(card).toBeVisible();

	const raw = (await card.innerText()).replace(/\s+/g, " ").trim();

	const errorBand = card.getByTestId("modem-usb-mode-error");
	const hasError = (await errorBand.count()) > 0;
	const role = hasError ? await errorBand.getAttribute("role") : null;
	const refusal = hasError
		? await errorBand.getAttribute("data-usb-mode-refusal")
		: null;

	const gate = card.locator("[data-usb-mode-gate]");
	const gateKind =
		(await gate.count()) > 0 ? await gate.getAttribute("data-usb-mode-gate") : null;

	const switchButton = card.getByTestId("modem-usb-mode-switch");
	const switchCount = await switchButton.count();
	const switchDisabled = switchCount > 0 ? await switchButton.isDisabled() : null;

	// Counted by ROLE, not testid: the confirm-dialog trigger carries no testid,
	// so a testid count reads 0 for the transient failure and collapses it into
	// the standing refusal — the one distinction this gate exists to prove.
	const buttons = card.getByRole("button");
	const buttonCount = await buttons.count();
	let enabledButtons = 0;
	for (let i = 0; i < buttonCount; i++) {
		if (await buttons.nth(i).isEnabled()) enabledButtons++;
	}

	return {
		text: raw,
		shape: JSON.stringify({
			role,
			refusal,
			gateKind,
			switchOffered: switchCount > 0,
			switchDisabled,
			buttonCount,
			enabledButtons,
		}),
	};
}

/**
 * Re-enter the modem surface on a FRESH page and re-inject the premise.
 *
 * `usbFlow` is component-scoped `$state` on `ModemConfigDialog`, and AppDialog
 * only gates its CHILDREN on `open` — so a terminal reached in one leg survives
 * a close/reopen and withdraws the switch the next leg needs. A reload is the
 * only way to walk the three terminals in one test.
 */
async function enterModemSurface(
	page: Page,
	config: Record<string, unknown>,
): Promise<void> {
	await page.reload();
	await ensureAuthenticated(page);
	await navigateTo(page, "network");
	serverConfig(config);
	sendModems({ [MM_HEALTHY_ID]: mmManaged(FULL_DETAIL) });
}

/**
 * Open the mm-managed modem's config dialog and return it.
 * The dialog title is the DEVICE name (`modem.name`), not the row's carrier
 * headline — deriving it from the row's visible text resolves nothing.
 */
async function openModemDialog(page: Page): Promise<Locator> {
	const configure = modemRow(page, MM_HEALTHY_ID).getByTestId(
		"open-modem-config-dialog",
	);
	await expect(configure).toBeEnabled({ timeout: 15_000 });
	await configure.click();

	const dialog = page.getByRole("dialog", { name: MM_HEALTHY_NAME });
	await expect(dialog).toBeVisible({ timeout: 15_000 });
	// The instrument cards this spec photographs live behind the dialog's
	// "Advanced" disclosure (todo 64); expand it so every existing shot and
	// assertion still sees them.
	await openModemAdvanced(dialog);
	return dialog;
}

for (const condition of CONDITIONS) {
	test.describe(`@visual modem UX — ${condition.name}`, () => {
		const shot = (surface: string): string =>
			path.join(EVIDENCE_DIR, `${surface}-${condition.name}.png`);

		test.beforeEach(async ({ page }, testInfo) => {
			test.skip(
				testInfo.project.name !== condition.project,
				`${condition.name} renders in the ${condition.project} project`,
			);

			pageWs = null;
			usbModeReply = null;
			fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

			await page.setViewportSize(condition.viewport);

			await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
				pageWs = ws;
				const server = ws.connectToServer();

				ws.onMessage((m) => {
					// Answer `modems.setUsbMode` client-side when a reply is armed. The
					// refusal taxonomy is the whole subject of the terminal-state test
					// and no mock backend can produce it on demand.
					if (usbModeReply !== null) {
						const text = typeof m === "string" ? m : m.toString();
						try {
							const frame = JSON.parse(text) as {
								id?: string | number;
								path?: unknown;
							};
							const rpc = Array.isArray(frame.path) ? frame.path.join(".") : null;
							if (rpc === "modems.setUsbMode" && frame.id !== undefined) {
								ws.send(JSON.stringify({ id: frame.id, result: usbModeReply }));
								return;
							}
						} catch {
							/* non-RPC frame */
						}
					}
					server.send(m);
				});

				server.onMessage((m) => {
					const text = typeof m === "string" ? m : m.toString();
					try {
						const frame = JSON.parse(text) as object;
						// The injected roster / interfaces / config are authoritative.
						if ("status" in frame) return;
						if ("config" in frame) return;
						if ("netif" in frame) return;
						if ("modems" in frame) return;
					} catch {
						/* non-JSON / binary frame */
					}
					ws.send(m);
				});
			});

			await page.goto(condition.touch === true ? "/?mode=touch" : "/");
			await ensureAuthenticated(page);
			await navigateTo(page, "network");

			if (condition.touch === true) {
				// The kiosk captures are only kiosk captures in touch layout — assert it
				// rather than assume the URL flag took.
				await expect(page.locator("html")).toHaveAttribute(
					"data-layout-mode",
					"touch",
				);
			}
		});

		// ── CellularSection: the full class/state table (todo 26) ────────────────
		test("cellular section renders every class band and state, none hidden", {
			tag: "@visual",
		}, async ({ page }) => {
			serverConfig();
			sendModems(fullStateRoster());

			const section = cellularSection(page);
			await expect(section).toBeVisible({ timeout: 15_000 });

			// Every state in the table renders its OWN row — the redesign's core
			// promise is that an uncontrollable device is dimmed-with-a-reason,
			// never dropped from the list.
			await expect(page.getByTestId("modem-row")).toHaveCount(STATE_TABLE.length);
			for (const row of STATE_TABLE) {
				await expect(modemRow(page, row.id)).toHaveAttribute(
					"data-modem-state",
					row.state,
				);
			}

			// No leaf renders a bare i18n dot-path (a missing catalog entry) and no
			// row leaks a raw wire token.
			const sectionText = await section.innerText();
			expect(sectionText).not.toMatch(/network\.[a-z]+\.[a-zA-Z.]+/);
			for (const token of ["router_managed", "dongle_acquiring", "dongle_down"]) {
				expect(sectionText).not.toContain(token);
			}

			await section.screenshot({ path: shot("cellular-state-table") });
		});

		test("cellular section renders the initializing band instead of a no-SIM claim", {
			tag: "@visual",
		}, async ({ page }) => {
			serverConfig();
			send({ status: { cellular_initializing: true, modems: {} } });

			const band = page.getByTestId("cellular-initializing");
			await expect(band).toBeVisible({ timeout: 15_000 });
			await expect(band).toHaveAttribute("role", "status");

			const section = page
				.locator("section")
				.filter({ has: page.getByTestId("cellular-initializing") })
				.first();
			await expect(section.getByText("No SIM cards detected")).toHaveCount(0);

			await section.screenshot({ path: shot("cellular-initializing") });
		});

		// ── ModemConfigDialog: the three cards + Auto-APN default (todo 27) ──────
		test("modem dialog renders the usage, detail and USB-mode cards with the Auto-APN default", {
			tag: "@visual",
		}, async ({ page }) => {
			serverConfig({ modem_provisioning: true });
			sendModems({ [MM_HEALTHY_ID]: mmManaged(FULL_DETAIL) });

			const dialog = await openModemDialog(page);

			await expect(dialog.getByTestId("modem-usage-card")).toBeVisible();
			await expect(dialog.getByTestId("modem-detail-card")).toBeVisible();
			await expect(dialog.getByTestId("modem-usb-mode-card")).toBeVisible();
			await expect(dialog.getByTestId("modem-autoapn-recommended")).toBeVisible();

			// The eSIM badge is read-only FOREVER: prove it against the real DOM,
			// not by reading the markup.
			const esim = dialog.getByTestId("modem-esim");
			await expect(esim).toBeVisible();
			expect(await esim.locator("button, a, input, select, textarea").count()).toBe(0);

			// The usage card reports policy values but offers no way to set them.
			const usage = dialog.getByTestId("modem-usage-card");
			expect(await usage.locator("input, select, textarea, button").count()).toBe(0);

			await dialog.screenshot({ path: shot("modem-dialog") });
		});

		// ── The SIM's own number: hidden by default, revealed on request ─────────
		// The PNGs are evidence; every criterion below is asserted. The one that
		// matters most is NEGATIVE — the number must not be anywhere in the
		// dialog's rendered text before the reveal, because a CSS mask or a
		// `hidden` attribute would still put it in a screen share and in the
		// accessibility tree.
		test("the SIM own-number is masked until revealed, and absent when unpublished", {
			tag: "@visual",
		}, async ({ page }) => {
			const OWN_NUMBER = "+573115422359";
			serverConfig({ modem_provisioning: true });
			sendModems({
				[MM_HEALTHY_ID]: mmManaged({
					...FULL_DETAIL,
					own_numbers: [OWN_NUMBER],
				}),
			});

			const dialog = await openModemDialog(page);
			const field = dialog.getByTestId("modem-own-number");
			await expect(field).toBeVisible();

			const value = dialog.getByTestId("modem-own-number-value-0");
			await expect(value).toHaveAttribute("data-revealed", "false");
			expect(await dialog.textContent()).not.toContain(OWN_NUMBER);

			const toggle = dialog.getByTestId("modem-own-number-toggle");
			await expect(toggle).toHaveAttribute("aria-pressed", "false");
			await field.screenshot({ path: shot("own-number-hidden") });

			await toggle.click();

			await expect(value).toHaveAttribute("data-revealed", "true");
			await expect(value).toHaveText(OWN_NUMBER);
			await expect(toggle).toHaveAttribute("aria-pressed", "true");
			await field.screenshot({ path: shot("own-number-revealed") });

			// Honest absence: a SIM that published no number renders no field at
			// all — no label, no dash, no "Unknown".
			await enterModemSurface(page, { modem_provisioning: true });
			const plain = await openModemDialog(page);
			await expect(plain.getByTestId("modem-detail-card")).toBeVisible();
			await expect(plain.getByTestId("modem-own-number")).toHaveCount(0);
			await expect(plain.getByTestId("modem-own-number-toggle")).toHaveCount(0);
			await plain.screenshot({ path: shot("own-number-absent") });
		});

		// ── USB-mode card: the THREE terminal presentations (todos 27/28) ────────
		test("the three USB-mode terminal presentations are pairwise distinguishable without colour", {
			tag: "@visual",
		}, async ({ page }) => {
			// Three terminals, each needing its own page load (see enterModemSurface).
			test.slow();
			const signatures = new Map<string, TerminalSignature>();

			// (1) provisioning-disabled — a PRE-RENDERED amber gate. The device said
			// the mutation is off, so the switch is offered disabled-with-reason and
			// no RPC is ever dispatched.
			serverConfig({ modem_provisioning: false });
			sendModems({ [MM_HEALTHY_ID]: mmManaged(FULL_DETAIL) });

			let dialog = await openModemDialog(page);
			const gate = dialog.locator('[data-usb-mode-gate="provisioning-disabled"]');
			await expect(gate).toBeVisible();
			await expect(dialog.getByTestId("modem-usb-mode-switch")).toBeDisabled();
			await expect(
				dialog.getByTestId("modem-usb-mode-provisioning-blocked"),
			).toBeVisible();
			signatures.set("provisioning-disabled", await usbTerminalSignature(dialog));
			await dialog
				.getByTestId("modem-usb-mode-card")
				.screenshot({ path: shot("usb-mode-provisioning-disabled") });
			await page.keyboard.press("Escape");
			await expect(dialog).toBeHidden();

			// (2) uncertified — a STANDING refusal. Calm `role="status"` band, and the
			// switch is WITHDRAWN, because a retry button beside a permanent refusal
			// misrepresents what pressing it does.
			usbModeReply = { success: false, error: "uncertified" };
			await enterModemSurface(page, { modem_provisioning: true });

			dialog = await openModemDialog(page);
			await dialog.getByRole("button", { name: /Switch to mbim/i }).click();
			await page.getByRole("button", { name: /Switch mode/i }).click();

			const standing = dialog.getByTestId("modem-usb-mode-error");
			await expect(standing).toBeVisible();
			await expect(standing).toHaveAttribute("data-usb-mode-refusal", "uncertified");
			await expect(standing).toHaveAttribute("role", "status");
			await expect(dialog.getByTestId("modem-usb-mode-switch")).toHaveCount(0);
			// The refusal never moves the reported mode.
			await expect(dialog.getByTestId("modem-usb-mode-active")).toHaveText("rndis");
			signatures.set("uncertified", await usbTerminalSignature(dialog));
			await dialog
				.getByTestId("modem-usb-mode-card")
				.screenshot({ path: shot("usb-mode-uncertified") });
			await page.keyboard.press("Escape");
			await expect(dialog).toBeHidden();

			// (3) transition_failed — a TRANSIENT failure. Red `role="alert"`, and the
			// switch is KEPT, because the condition it names can change.
			usbModeReply = {
				success: false,
				error: "transition_failed",
				reason: "postcondition_mismatch",
			};
			await enterModemSurface(page, { modem_provisioning: true });

			dialog = await openModemDialog(page);
			await dialog.getByRole("button", { name: /Switch to mbim/i }).click();
			await page.getByRole("button", { name: /Switch mode/i }).click();

			const transient = dialog.getByTestId("modem-usb-mode-error");
			await expect(transient).toBeVisible();
			await expect(transient).toHaveAttribute("role", "alert");
			expect(await transient.getAttribute("data-usb-mode-refusal")).toBeNull();
			await expect(dialog.getByTestId("modem-usb-mode-switch")).toHaveCount(0);
			await expect(
				dialog.getByRole("button", { name: /Switch to mbim/i }),
			).toBeVisible();
			await expect(dialog.getByTestId("modem-usb-mode-active")).toHaveText("rndis");
			signatures.set("transition_failed", await usbTerminalSignature(dialog));
			await dialog
				.getByTestId("modem-usb-mode-card")
				.screenshot({ path: shot("usb-mode-transition-failed") });

			// THE GATE todo 28 asked for. Colour is reinforcement here — amber, muted
			// and destructive-red — so the three must already differ in what they SAY
			// and in how they are BUILT. Both are asserted pairwise; neither reads a
			// colour, so an operator on a monochrome panel (or with a colour-vision
			// deficiency) still gets three different answers.
			const names = [...signatures.keys()];
			expect(names).toHaveLength(3);
			for (const [a, b] of pairs(names)) {
				const left = signatures.get(a);
				const right = signatures.get(b);
				expect(left, `missing signature for ${a}`).toBeDefined();
				expect(right, `missing signature for ${b}`).toBeDefined();
				expect(
					left?.text,
					`"${a}" and "${b}" render the same words — colour would be the only discriminator`,
				).not.toBe(right?.text);
				expect(
					left?.shape,
					`"${a}" and "${b}" render the same structure — colour would be the only discriminator`,
				).not.toBe(right?.shape);
			}

			// Each terminal names its own condition in plain words, so the text
			// difference above is meaningful rather than incidental.
			expect(signatures.get("provisioning-disabled")?.text).toMatch(/turned off/i);
			expect(signatures.get("uncertified")?.text).toMatch(/certified/i);
			expect(signatures.get("transition_failed")?.text).toMatch(/didn't complete/i);

			fs.writeFileSync(
				path.join(EVIDENCE_DIR, `usb-mode-terminals-${condition.name}.json`),
				`${JSON.stringify(Object.fromEntries(signatures), null, 2)}\n`,
				"utf8",
			);
		});

		// ── Isolated-dongle row: up / acquiring / down (todo 19) ─────────────────
		test("the isolated-dongle row renders three states with three distinct glyphs", {
			tag: "@visual",
		}, async ({ page }) => {
			serverConfig();
			sendModems({});
			sendNetif(DONGLE_NETIF);

			const section = ethernetSection(page);
			await expect(section).toBeVisible({ timeout: 15_000 });

			const stateBadges = page.getByTestId("netif-dongle-state");
			await expect(stateBadges).toHaveCount(3);

			// Each lifecycle state carries its own WORD and its own GLYPH, so colour
			// is only reinforcement. The glyph comparison reads the rendered SVG
			// geometry — a class-name comparison would walk straight through an icon
			// swap that produced three identical drawings.
			const glyphs: string[] = [];
			const words: string[] = [];
			for (const state of ["up", "acquiring", "down"]) {
				const badge = page.locator(
					`[data-testid="netif-dongle-state"][data-dongle-state="${state}"]`,
				);
				await expect(badge).toHaveCount(1);
				glyphs.push(
					await badge.locator("svg").first().evaluate((svg) => svg.innerHTML),
				);
				words.push(((await badge.innerText()) ?? "").replace(/\s+/g, " ").trim());
			}
			expect(new Set(glyphs).size, "the three dongle states must draw three different glyphs").toBe(3);
			expect(new Set(words).size, "the three dongle states must read as three different words").toBe(3);

			// The `Badge size="micro"` defect is worked around per call site
			// (`text-(length:--text-micro)`, todo 19) because `tailwind-merge` files
			// the bare `text-micro` utility under text-COLOUR and the `text-status-*`
			// class that follows wins. Verify the workaround still LANDS: the badge
			// must render at the micro token, not at the inherited size.
			const micro = await page.evaluate(() =>
				getComputedStyle(document.documentElement)
					.getPropertyValue("--text-micro")
					.trim(),
			);
			expect(micro, "--text-micro must be defined").not.toBe("");
			const badgeFontSize = await page
				.getByTestId("netif-dongle")
				.first()
				.evaluate((el) => getComputedStyle(el).fontSize);
			expect(
				pxOf(badgeFontSize),
				`the micro badge must honour --text-micro (${micro}), not the inherited size`,
			).toBeLessThan(14);

			// An address-less dongle veth cannot carry bonded traffic, so its toggle
			// is disabled WITH a reason that is on screen (a kiosk cannot hover).
			await expect(page.getByTestId("netif-dongle-blocked-hint")).toHaveCount(2);

			await section.screenshot({ path: shot("dongle-rows") });
		});
	});
}

/** Every unordered pair from a list, for pairwise-distinctness assertions. */
function pairs(values: readonly string[]): ReadonlyArray<readonly [string, string]> {
	const out: Array<readonly [string, string]> = [];
	for (let i = 0; i < values.length; i++) {
		for (let j = i + 1; j < values.length; j++) {
			const a = values[i];
			const b = values[j];
			if (a !== undefined && b !== undefined) out.push([a, b]);
		}
	}
	return out;
}

/** Parse a computed `px` length. Throws rather than silently reading 0. */
function pxOf(value: string): number {
	const parsed = Number.parseFloat(value);
	if (Number.isNaN(parsed)) throw new Error(`not a px length: "${value}"`);
	return parsed;
}
