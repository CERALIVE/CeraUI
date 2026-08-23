import fs from "node:fs";
import path from "node:path";

import type { Locator, Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { type AxeViolationSummary, runAxe } from "./helpers/axe.js";
import { ensureAuthenticated, navigateTo, setLocale } from "./helpers/index.js";
import { openModemAdvanced } from "./helpers/modem-advanced.js";
// ONE probe, shared with the pass-4 capture: a containment rule that exists
// twice is a rule that can disagree with itself. Do not re-inline it here.
import {
	expectContained,
	KIOSK_VIEWPORT,
	MANDATORY_BREAKPOINTS,
	openRowDisclosures,
	probeContainment,
	probeDialogOverflow,
} from "./helpers/modem-containment.js";

/**
 * Accessibility gate for the modem-stack Phase-B operator surfaces (todo 29),
 * @a11y. Sibling of `a11y.spec.ts` — the CI "Accessibility gate" step filters on
 * `a11y.spec.ts`, which matches this path as a substring, so these run in the
 * same job without a workflow change.
 *
 * Seven legs, every one a PASS/FAIL assertion with no human-judgment step.
 * Legs 3b-3d discharge `DESIGN.md` Pass 3 (harden/adapt) and cite its rule ids:
 *
 *   1. axe (critical+serious) on the Network destination carrying the full modem
 *      roster, and again with EACH modem dialog OPEN — `ModemConfigDialog` and
 *      `RouterDongleDialog`, which a Configure button reaches by
 *      `device_class`. The NEW surfaces are
 *      held to an ABSOLUTE zero via a scoped run; the whole page is additionally
 *      held to "no new rule beyond the documented `a11y-baseline.json`" so the
 *      pre-existing app-wide contrast debt cannot false-fail this gate, and a
 *      regression outside the modem markup still does.
 *   2. a keyboard/focus walk: the open dialog is a real focus TRAP, and the
 *      USB-mode switch's confirm flow completes with the keyboard alone.
 *   3. an RTL (`ar`) smoke asserted with `getBoundingClientRect()` containment,
 *      never a screenshot review, at every mandatory width.
 *   3b. the same containment in the base locale at 375 / 768 / 1280 and the
 *      1024x600 kiosk, for the rows AND the dialog (BP-1…BP-3).
 *   3e. the same containment at FLEET SCALE — the 8-device hardware-verified
 *      fleet — plus a measured no-collapse check on every row's box and its
 *      identity column, and the class badge measured with the disclosures OPEN.
 *   3f. identity stability: an MM restart that renumbers the whole roster, and a
 *      same-MAC twin pair renaming against each other, must move no row.
 *   3c. the eight non-base catalogs at the narrowest width — no overflow, no
 *      unresolved dotted key, and a state badge that MEASURES the word it says,
 *      which is what makes the CJK fallback claim falsifiable (LO-1…LO-5).
 *   3d. `prefers-reduced-motion: reduce` emulated, asserted from the COMPUTED
 *      style of the live tree rather than from the stylesheet, plus the proof
 *      that stilling took no state with it (RM-1…RM-4).
 *   4. a 44px touch-target inventory PIN, plus the >= 8px separation rule and
 *      the disabled-controls-keep-their-size rule (TT-1…TT-5). The pin is an
 *      EXACT SET of sanctioned deviations and it is empty, so any control that
 *      falls short reddens here. The measurement is the HIT AREA rather than
 *      the box, because a switch carries its target on an `::after` overlay
 *      that `getBoundingClientRect()` structurally cannot see.
 *
 * Determinism mirrors `visual/modem-ux.visual.spec.ts`: the page socket is
 * proxied, the backend's `status`/`config`/`netif` echoes are dropped so the
 * injected roster is the only truth on screen, and `modems.setUsbMode` is
 * answered client-side.
 */

// e2e -> tests -> frontend -> apps -> CeraUI (repo root). Repo-local, gitignored.
const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../../test-results/modem-phase-b/29",
);
const BASELINE_ALLOWLIST = path.resolve(import.meta.dirname, "a11y-baseline.json");

const KIOSK = KIOSK_VIEWPORT;

let pageWs: WebSocketRoute | null = null;
let usbModeReply: Record<string, unknown> | null = null;

function send(payload: unknown): void {
	pageWs?.send(JSON.stringify(payload));
}

const MM_MODEM_ID = "mm-healthy";
const MM_MODEM_NAME = "Quectel RM520N";

function mmManaged(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ifname: "wwan0",
		name: MM_MODEM_NAME,
		network_type: { supported: ["5g", "lte"], active: "lte" },
		config: { apn: "", username: "", password: "", roaming: false, network: "" },
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
		...extra,
	};
}

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

/**
 * Deliberately carries NO PIN-locked modem.
 *
 * A `sim_lock` entry makes `SimUnlockDialog` auto-prompt, and it re-opens after
 * being dismissed — so its overlay would own every click in a gate whose whole
 * subject is the CONFIG dialog beneath it. The locked row's rendering is covered
 * by the state table in `visual/modem-ux.visual.spec.ts`, which never clicks, and
 * it is structurally identical to these rows for axe's purposes.
 */
function fullRoster(): Record<string, unknown> {
	return {
		[MM_MODEM_ID]: mmManaged(),
		"dongle-up": routerDongle("router_managed", 0),
		"dongle-acquiring": routerDongle("dongle_acquiring", 1),
		"dongle-down": routerDongle("dongle_down", 2),
		unmanaged: {
			ifname: "wwx0",
			name: "Unrecognised WWAN",
			network_type: { supported: [], active: null },
			device_class: "thunderbolt-wwan",
		},
	};
}

/**
 * The fleet a real bench has run. HARDWARE-VERIFIED.
 *
 * modem-stack's `control/src/providers/conformance-scale.test.ts` additionally
 * carries a SIXTEEN-modem bound, and says in as many words that it is a FIXTURE
 * result which must never be reported as hardware. The rendered-tree proof at
 * that bound lives in `CellularSection.scale.test.ts`, which labels it as such;
 * this browser leg deliberately drives the number a board has actually produced.
 */
const HARDWARE_VERIFIED_FLEET = 8;

/**
 * A fleet in the shape the renderer actually receives.
 *
 * Every wire id is `String(number)`, so the object's own key semantics hand the
 * roster over in ASCENDING NUMERIC ID order whatever the backend emitted — a
 * fixture built on emission order is canonicalised away before anything can
 * observe it, and proves nothing. What IS variable is which PORT each id
 * describes, because mmcli re-issues the index. `descending` inverts that
 * relationship, so an unsorted render reads exactly backwards; every unit is
 * anchored on its own `stable_key`, the only thing separating two units of one
 * SKU.
 */
function scaleRoster(
	size: number,
	{ idBase = 100, descending = true }: { idBase?: number; descending?: boolean } = {},
): Record<string, unknown> {
	return Object.fromEntries(
		Array.from({ length: size }, (_unused, i) => {
			const port = descending ? size - 1 - i : i;
			return [
				`${idBase + i}`,
				mmManaged({
					ifname: `wwan${port}`,
					name: `RM520N-GL - ${port}`,
					slot_label: `SIM ${port + 1}`,
					stable_key: `pci-0000:00:14.0-usb-0:1.${port}`,
				}),
			];
		}),
	);
}

/** The rendered rows, in DOM order, with the two facts an operator navigates by. */
function readRowOrder(
	page: Page,
): Promise<{ id: string | null; ifname: string | null }[]> {
	return page.evaluate(() =>
		[...document.querySelectorAll('[data-testid="modem-row"]')].map((row) => ({
			id: row.getAttribute("data-modem-id"),
			ifname: row.getAttribute("data-ifname"),
		})),
	);
}

const DONGLE_NETIF: Record<string, unknown> = {
	eth0: { ip: "192.168.1.50", tp: 0, enabled: true },
	dg0h: { ip: "10.208.0.1", tp: 0, enabled: true, dongle: { slot: 0, state: "up" } },
	dg1h: { tp: 0, enabled: false, dongle: { slot: 1, state: "acquiring" } },
	dg2h: { tp: 0, enabled: false, dongle: { slot: 2, state: "down" } },
};

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

const cellularSection = (page: Page): Locator =>
	page.locator("section").filter({ has: page.getByTestId("modem-row") }).first();

async function openModemDialog(page: Page): Promise<Locator> {
	// Nothing may already own the overlay, or the click below fails as an opaque
	// timeout rather than naming the dialog that swallowed it (see fullRoster).
	await expect(page.getByRole("dialog")).toHaveCount(0);
	const configure = page
		.locator(`[data-testid="modem-row"][data-modem-id="${MM_MODEM_ID}"]`)
		.getByTestId("open-modem-config-dialog");
	await expect(configure).toBeEnabled({ timeout: 15_000 });
	await configure.click();
	const dialog = page.getByRole("dialog", { name: MM_MODEM_NAME });
	await expect(dialog).toBeVisible({ timeout: 15_000 });
	return dialog;
}

function writeEvidence(fileName: string, value: unknown): void {
	fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
	fs.writeFileSync(
		path.join(EVIDENCE_DIR, fileName),
		`${JSON.stringify(value, null, 2)}\n`,
		"utf8",
	);
}

function ruleIdsOf(violations: readonly AxeViolationSummary[]): string[] {
	return [...new Set(violations.map((v) => v.id))].sort();
}

function networkBaselineRuleIds(): ReadonlySet<string> {
	const raw = JSON.parse(fs.readFileSync(BASELINE_ALLOWLIST, "utf8")) as Record<
		string,
		string[]
	>;
	return new Set(raw.network ?? []);
}

/**
 * `DESIGN.md` §4 — the three mandatory verification widths, plus the kiosk case.
 * Shared with the pass-4 confirmation capture, which measures the SAME contract.
 */
const BREAKPOINTS = MANDATORY_BREAKPOINTS;

/**
 * Re-enter the Network destination under `locale`.
 *
 * The reload is what applies the locale, and it re-arms the cold-start hazard
 * `ensureAuthenticated` documents: past ~5s to mount, `index.html` reveals a
 * full-screen `#js-failed` overlay that never hides again and swallows every
 * click. One reload got away with it; a sweep over nine catalogs does not.
 */
async function enterNetworkAs(page: Page, locale: string): Promise<void> {
	await setLocale(page, locale);
	await page.reload();
	await page
		.waitForFunction(() => (window as { __ceraAppMounted?: boolean }).__ceraAppMounted === true, undefined, {
			timeout: 60_000,
		})
		.catch(() => undefined);
	await page.evaluate(() => document.getElementById("js-failed")?.remove());
	await navigateTo(page, "network");
	serverConfig({ modem_provisioning: true });
	send({ status: { modems: fullRoster() } });
	send({ netif: DONGLE_NETIF });
	await expect(cellularSection(page)).toBeVisible({ timeout: 15_000 });
}

test.describe("modem UX a11y gate (modem-stack Phase B)", () => {
	test.describe.configure({ mode: "serial" });
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-engine accessibility proof (cage/Chromium parity)",
	);

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"the gate drives its own viewports; run once",
		);

		pageWs = null;
		usbModeReply = null;

		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();

			ws.onMessage((m) => {
				if (usbModeReply !== null) {
					const text = typeof m === "string" ? m : m.toString();
					try {
						const frame = JSON.parse(text) as { id?: string | number; path?: unknown };
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
	});

	// ── 1. axe ───────────────────────────────────────────────────────────────
	test("axe reports zero critical/serious violations on the cellular surface and the modem dialog @a11y", async ({
		authedPage: page,
	}) => {
		await navigateTo(page, "network");
		serverConfig({ modem_provisioning: true });
		send({ status: { modems: fullRoster() } });
		send({ netif: DONGLE_NETIF });

		await expect(cellularSection(page)).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("modem-row")).toHaveCount(5);

		const allowed = networkBaselineRuleIds();

		// Each NEW surface is scoped and pinned to an EXACT rule set, so pre-existing
		// app-wide debt elsewhere on the page can neither mask a regression here nor
		// manufacture one.
		//
		// The pinned set is `color-contrast`, and it is NOT this effort's debt: the
		// `Badge` status palette composites `text-status-<tone>` on a 10%-alpha
		// `bg-status-<tone>` tint of the SAME hue, so every semantic pill in the app
		// trips the rule — `netif-link-local`, the SourceSection pills and
		// `AudioDialogContent` all predate wave 5 and use the identical pair, and
		// `a11y-baseline.json` already allowlists the rule on all three destinations.
		// The cellular redesign added MORE instances of an already-baselined token
		// defect; it did not introduce a rule. Repairing it means re-toning
		// `--status-*` app-wide, which is a design-system change with its own QA
		// pass — the same call todo 19 made for the `Badge size="micro"` defect. It
		// is NOT the call made for the 44px touch targets, which leg 4 below now
		// holds at zero: that fix is a hit area, and it changes no colour.
		//
		// Pinning as an exact SET is what keeps that honest: a NEW rule (an unlabelled
		// control, a focus trap escape) grows the set and reddens, and re-toning the
		// palette empties it and reddens too, so neither can pass unnoticed.
		const PINNED_SURFACE_RULES: readonly string[] = ["color-contrast"];

		const cellularScoped = await runAxe(page, {
			include: ['section:has([data-testid="modem-row"])'],
		});
		expect(
			ruleIdsOf(cellularScoped),
			`CellularSection critical/serious rule set changed:\n${JSON.stringify(cellularScoped, null, 2)}`,
		).toEqual([...PINNED_SURFACE_RULES]);

		// Whatever the palette does to legibility, it may never be the only carrier
		// of a state: every row's state badge must also say a WORD and draw a GLYPH.
		// That is the property a contrast failure cannot take away, so it is asserted
		// rather than assumed while the token debt stands.
		const stateBadges = page.getByTestId("modem-state-badge");
		const badgeCount = await stateBadges.count();
		expect(badgeCount).toBe(5);
		for (let i = 0; i < badgeCount; i++) {
			const badge = stateBadges.nth(i);
			expect((await badge.innerText()).trim().length).toBeGreaterThan(0);
			await expect(badge.locator("svg")).toHaveCount(1);
		}

		// The whole destination is held to the documented baseline, so a regression
		// in the surrounding Network markup still fails here.
		const wholePage = await runAxe(page);
		const freshOnPage = wholePage.filter((v) => !allowed.has(v.id));
		expect(
			freshOnPage,
			`NEW critical/serious a11y violations on the Network destination:\n${JSON.stringify(freshOnPage, null, 2)}`,
		).toEqual([]);

		const dialog = await openModemDialog(page);
		await openModemAdvanced(dialog);
		await expect(dialog.getByTestId("modem-usb-mode-card")).toBeVisible();

		const dialogScoped = await runAxe(page, { include: ['[role="dialog"]'] });
		expect(
			ruleIdsOf(dialogScoped).filter((id) => !allowed.has(id)),
			`NEW critical/serious a11y violations inside ModemConfigDialog:\n${JSON.stringify(dialogScoped, null, 2)}`,
		).toEqual([]);

		// …AND THE OTHER DIALOG. `ModemConfigDialog` is one of TWO modem surfaces
		// a Configure button can open: `NetworkView.openModemConfig` routes on
		// `device_class`, so a `router-ethernet` row opens `RouterDongleDialog`
		// instead — a whole second dialog (lock section, net-mode catalog, the
		// action surface) that no scoped axe run had ever reached. Its Configure
		// is refused unless a write was PROVEN, which is why the roster above
		// cannot reach it and this leg injects a dongle that publishes `controls`.
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);

		const DONGLE_ID = "dongle-verified";
		send({
			status: {
				modems: {
					[DONGLE_ID]: {
						...routerDongle("router_managed", 9),
						name: "Huawei E3372",
						availability_reason: "router_direct",
						stable_key: "pci-0000:00:14.0-usb-0:1.4.1",
						router_admin: {
							admin_url: "http://192.168.8.1",
							reachable: true,
							sim: "present",
							connection: "connected",
							signal_bars: 3,
							signal_max_bars: 5,
							apn: "3gnet",
							serial: "Y4QDU17621000872",
							controls: [
								{
									id: "mobile_data",
									kind: "toggle",
									value: "on",
									writable: true,
								},
							],
						},
					},
				},
			},
		});

		const dongleConfigure = page
			.locator(`[data-testid="modem-row"][data-modem-id="${DONGLE_ID}"]`)
			.getByTestId("open-modem-config-dialog");
		await expect(dongleConfigure).toBeEnabled({ timeout: 15_000 });
		await dongleConfigure.click();
		const dongleDialog = page.getByRole("dialog", { name: "Huawei E3372" });
		await expect(dongleDialog).toBeVisible({ timeout: 15_000 });

		const dongleScoped = await runAxe(page, { include: ['[role="dialog"]'] });
		expect(
			ruleIdsOf(dongleScoped).filter((id) => !allowed.has(id)),
			`NEW critical/serious a11y violations inside RouterDongleDialog:\n${JSON.stringify(dongleScoped, null, 2)}`,
		).toEqual([]);

		const evidence: {
			generatedAt: string;
			gatedImpacts: readonly string[];
			scopedSurfaces: Record<string, AxeViolationSummary[]>;
			networkDestination: {
				baselineAllowlist: string[];
				violations: AxeViolationSummary[];
				newViolations: AxeViolationSummary[];
			};
		} = {
			generatedAt: new Date().toISOString(),
			gatedImpacts: ["critical", "serious"],
			scopedSurfaces: {
				cellularSection: cellularScoped,
				modemConfigDialog: dialogScoped,
			},
			networkDestination: {
				baselineAllowlist: [...allowed].sort(),
				violations: wholePage,
				newViolations: freshOnPage,
			},
		};
		writeEvidence("axe-modem.json", evidence);
	});

	// ── 2. keyboard / focus walk ─────────────────────────────────────────────
	test("the modem dialog traps focus and its USB-mode confirm flow is fully keyboard-operable @a11y", async ({
		authedPage: page,
	}) => {
		await navigateTo(page, "network");
		serverConfig({ modem_provisioning: true });
		send({ status: { modems: fullRoster() } });

		const dialog = await openModemDialog(page);

		// A dialog that lets focus escape is a dialog a keyboard operator cannot
		// leave OR use. Walk further than the control count so a wrap is exercised.
		const focusableCount = await dialog
			.locator(
				'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
			)
			.count();
		expect(focusableCount, "the dialog must expose focusable controls").toBeGreaterThan(0);

		const escapes: string[] = [];
		for (let i = 0; i < focusableCount + 3; i++) {
			await page.keyboard.press("Tab");
			const inside = await page.evaluate(() => {
				const active = document.activeElement;
				const surface = document.querySelector('[role="dialog"]');
				if (!active || !surface) return { contained: false, describe: "no active element" };
				return {
					contained: surface.contains(active),
					describe: `${active.tagName.toLowerCase()}${
						active.getAttribute("data-testid")
							? `[data-testid=${active.getAttribute("data-testid")}]`
							: ""
					}`,
				};
			});
			if (!inside.contained) escapes.push(`Tab #${i + 1} -> ${inside.describe}`);
		}
		// Backwards too: a trap implemented only on the forward edge is not a trap.
		for (let i = 0; i < focusableCount + 3; i++) {
			await page.keyboard.press("Shift+Tab");
			const contained = await page.evaluate(() => {
				const active = document.activeElement;
				const surface = document.querySelector('[role="dialog"]');
				return Boolean(active && surface?.contains(active));
			});
			if (!contained) escapes.push(`Shift+Tab #${i + 1}`);
		}
		expect(escapes, `focus escaped the open modem dialog:\n${escapes.join("\n")}`).toEqual([]);

		// The confirm flow, keyboard only — no click anywhere below this line.
		//
		// The USB-mode card is SECONDARY, behind the Advanced disclosure, whose
		// collapsed body is `inert` + `visibility: hidden` — so it is genuinely
		// unreachable until opened, which is exactly what the focus walk above
		// just measured. Open it before driving the control, like every other leg.
		//
		// MATCHED ON THE OPERATOR LABEL, NEVER THE WIRE TOKEN. §3 OL-1 moved the
		// composition name out of every operator-facing string, so `Switch to
		// mbim` stopped naming anything on screen; the token now lives only in
		// `data-usb-mode`, which is what the assertion below reads.
		await openModemAdvanced(dialog);
		usbModeReply = { success: true };
		const trigger = dialog.getByRole("button", { name: /^Switch to / });
		await trigger.focus();
		await expect(trigger).toBeFocused();
		await page.keyboard.press("Enter");

		const confirm = page.getByRole("button", { name: /Switch mode/i });
		await expect(confirm).toBeVisible();
		// bits-ui moves focus INTO the alert dialog itself as it opens, and its
		// focus trap takes focus back from anything that grabbed it first. Taking
		// focus before that lands is a race — observed failing once as
		// `toBeFocused() … Received: inactive` under load — so wait for the
		// dialog's own focus management to settle, and only then take it. This
		// asserts strictly MORE than the bare `.focus()` did: the trap must have
		// engaged, and the confirm button must then be able to hold focus anyway.
		await expect
			.poll(() =>
				page.evaluate(() => {
					const surface = document.querySelector(
						'[data-slot="alert-dialog-content"]',
					);
					return Boolean(
						surface &&
							document.activeElement &&
							surface.contains(document.activeElement),
					);
				}),
			)
			.toBe(true);
		await confirm.focus();
		await expect(confirm).toBeFocused();
		await page.keyboard.press("Enter");

		// Dispatch happened: the spinner is the ONLY optimistic element, and the
		// reported mode must NOT move on the reply alone.
		await expect(dialog.getByTestId("modem-usb-mode-switching")).toBeVisible();
		await expect(dialog.getByTestId("modem-usb-mode-active")).toHaveAttribute(
			"data-usb-mode",
			"rndis",
		);

		// Escape closes it, and focus returns to the document rather than being lost.
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
		expect(await page.evaluate(() => document.activeElement?.tagName ?? null)).not.toBeNull();
	});

	// ── 3. RTL (ar) containment ──────────────────────────────────────────────
	test("the modem surfaces contain their content under the ar locale at every mandatory width @a11y", async ({
		authedPage: page,
	}) => {
		await enterNetworkAs(page, "ar");

		await expect
			.poll(() => page.evaluate(() => document.documentElement.dir))
			.toBe("rtl");

		const report: Record<string, unknown> = {};

		// Mirrored layout puts the control cluster on the opposite edge, so a row
		// that fits in LTR can overrun in RTL — the failure this leg exists to
		// catch, and the one it did catch: the cluster was pinned at max-content by
		// `shrink-0` and hung 5px off the row's RTL end at 390px.
		for (const viewport of [...BREAKPOINTS, { width: 390, height: 844 }] as const) {
			await page.setViewportSize(viewport);
			const label = `ar @ ${viewport.width}x${viewport.height}`;
			const measured = await probeContainment(page);
			expectContained(measured, label);
			report[label] = measured;
		}

		// (d) the dialog, at the tightest width, keeps its cards inside itself.
		await page.setViewportSize(KIOSK);
		const dialog = await openModemDialog(page);
		await openModemAdvanced(dialog);
		await expect(dialog.getByTestId("modem-usb-mode-card")).toBeVisible();

		const dialogOverflow = await probeDialogOverflow(page);
		expect(
			dialogOverflow,
			`ar @ kiosk: dialog content escapes the dialog: ${dialogOverflow.join(", ")}`,
		).toEqual([]);

		report.dialogKiosk = { escapedTestIds: dialogOverflow };
		writeEvidence("rtl-ar-containment.json", report);
	});

	// ── 3b. BP-1…BP-3 at the three mandatory widths + the kiosk case ─────────
	test("the modem surfaces contain their content at 375, 768, 1280 and the kiosk viewport @a11y", async ({
		authedPage: page,
	}) => {
		await navigateTo(page, "network");
		serverConfig({ modem_provisioning: true });
		send({ status: { modems: fullRoster() } });
		send({ netif: DONGLE_NETIF });
		await expect(cellularSection(page)).toBeVisible({ timeout: 15_000 });

		const report: Record<string, unknown> = {};
		for (const viewport of BREAKPOINTS) {
			await page.setViewportSize(viewport);
			const label = `en @ ${viewport.width}x${viewport.height}`;
			const measured = await probeContainment(page);
			expectContained(measured, label);

			// A bonded link's NAME is how an operator tells one link from another, and
			// at 375px it used to measure 0: every instrument beside it is `shrink-0`,
			// so the zero-basis identity column absorbed the entire squeeze. It was a
			// KNOWN gap carried in `apps/frontend/AGENTS.md` as "a responsive change to
			// the shared row, with its own visual QA" — which is this pass. Asserted as
			// a WIDTH, because the column kept rendering its text the whole time.
			const labelWidths = await page.evaluate(() =>
				[...document.querySelectorAll('[data-testid="bonded-link-card"]')].map((card) => ({
					link: card.getAttribute("data-link-id"),
					width: card.querySelector(".truncate")?.getBoundingClientRect().width ?? 0,
				})),
			);
			expect(labelWidths.length, `${label}: bonded links must be laid out`).toBeGreaterThan(0);
			for (const link of labelWidths) {
				expect(
					link.width,
					`${label}: bonded link "${link.link}" label column measured ${link.width}px`,
				).toBeGreaterThan(40);
			}
			report[label] = { ...measured, bondedLinkLabels: labelWidths };
		}

		// The dialog is the tightest surface on these destinations, so it is held
		// to the same rule at the SAME widths rather than at the kiosk case alone.
		for (const viewport of BREAKPOINTS) {
			await page.setViewportSize(viewport);
			const label = `dialog @ ${viewport.width}x${viewport.height}`;
			const dialog = await openModemDialog(page);
			await openModemAdvanced(dialog);
			await expect(dialog.getByTestId("modem-usb-mode-card")).toBeVisible();

			const escaped = await probeDialogOverflow(page);
			expect(escaped, `${label}: dialog content escapes the dialog: ${escaped.join(", ")}`).toEqual(
				[],
			);
			report[label] = { escapedTestIds: escaped };

			await page.keyboard.press("Escape");
			await expect(page.getByRole("dialog")).toHaveCount(0);
		}

		writeEvidence("breakpoint-containment.json", report);
	});

	// ── 3e. FLEET SCALE — the roster an operator actually plugs in ───────────
	test("a fleet-scale roster contains every row at every mandatory width @a11y", async ({
		authedPage: page,
	}) => {
		test.setTimeout(120_000);
		await navigateTo(page, "network");
		serverConfig({ modem_provisioning: true });
		send({ status: { modems: scaleRoster(HARDWARE_VERIFIED_FLEET) } });
		await expect(cellularSection(page)).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("modem-row")).toHaveCount(HARDWARE_VERIFIED_FLEET);
		// The fixture's ids describe its ports BACKWARDS, so this both proves the
		// inversion is real and pins the order the rest of the leg measures.
		expect((await readRowOrder(page)).map((row) => row.ifname)).toEqual(
			Array.from({ length: HARDWARE_VERIFIED_FLEET }, (_unused, i) => `wwan${i}`),
		);

		const report: Record<string, unknown> = {};
		for (const viewport of BREAKPOINTS) {
			await page.setViewportSize(viewport);
			const label = `fleet@${viewport.width}x${viewport.height}`;
			const measured = await probeContainment(page);
			expectContained(measured, label);
			expect(measured.rows, `${label}: every device must draw a row`).toBe(
				HARDWARE_VERIFIED_FLEET,
			);

			// COLLAPSE, measured rather than eyeballed. Every instrument beside the
			// identity column is `shrink-0` and the column itself is `flex-1`
			// (basis 0), which is exactly the shape that measured 0px on the bonded
			// link card at 375px — the row wraps instead, and this is what proves
			// it still does with eight rows competing for the same width.
			const boxes = await page.evaluate(() =>
				[...document.querySelectorAll('[data-testid="modem-row"]')].map((row) => {
					const rect = row.getBoundingClientRect();
					const name = row.querySelector('[data-testid="modem-name"]');
					return {
						id: row.getAttribute("data-modem-id"),
						width: Math.round(rect.width),
						height: Math.round(rect.height),
						nameWidth: Math.round(name?.getBoundingClientRect().width ?? 0),
					};
				}),
			);
			for (const box of boxes) {
				expect(box.height, `${label}: row ${box.id} collapsed vertically`).toBeGreaterThan(24);
				expect(box.width, `${label}: row ${box.id} collapsed horizontally`).toBeGreaterThan(200);
				expect(
					box.nameWidth,
					`${label}: row ${box.id} squeezed its name column to ${box.nameWidth}px`,
				).toBeGreaterThan(40);
			}

			// Eight identical-model rows must stay eight distinguishable rows.
			const ids = boxes.map((box) => box.id);
			expect(new Set(ids).size, `${label}: rows share a modem id`).toBe(
				HARDWARE_VERIFIED_FLEET,
			);

			report[label] = { ...measured, boxes };
		}

		// The DISCLOSURE half. `modem-class-badge` is the element todo 29 flagged:
		// its copy is now a translated sentence fragment, and it is unmeasurable
		// while the disclosure is shut. 375px is the width that bites.
		await page.setViewportSize({ width: 375, height: 812 });
		const opened = await openRowDisclosures(page);
		expect(opened).toBe(HARDWARE_VERIFIED_FLEET);
		const disclosed = await probeContainment(page);
		expectContained(disclosed, "fleet@375 (disclosures open)");
		const badges = await page.evaluate(() =>
			[...document.querySelectorAll('[data-testid="modem-class-badge"]')].map(
				(el) => ({
					text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
					width: Math.round(el.getBoundingClientRect().width),
					// A collapsed disclosure still lays its content out at full size —
					// it is CLIPPED, not unlaid — so a width alone would pass with the
					// disclosures shut and prove nothing. `visibility` is the property
					// the collapse actually flips, and it is what `probeContainment`'s
					// own `laidOut()` filter reads.
					visible: getComputedStyle(el as HTMLElement).visibility === "visible",
				}),
			),
		);
		expect(badges).toHaveLength(HARDWARE_VERIFIED_FLEET);
		for (const badge of badges) {
			expect(badge.visible, `class badge "${badge.text}" is still clipped`).toBe(true);
			expect(badge.text.length).toBeGreaterThan(0);
			expect(badge.width, `class badge "${badge.text}" measured 0px`).toBeGreaterThan(16);
		}
		report["fleet@375 (disclosures open)"] = { ...disclosed, badges };

		writeEvidence("fleet-scale-containment.json", report);
	});

	// ── 3f. IDENTITY STABILITY — a replug must move nothing ──────────────────
	test("a replug and an MM renumber leave every row where the operator left it @a11y", async ({
		authedPage: page,
	}) => {
		await navigateTo(page, "network");
		serverConfig({ modem_provisioning: true });
		send({ status: { modems: scaleRoster(HARDWARE_VERIFIED_FLEET) } });
		await expect(cellularSection(page)).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("modem-row")).toHaveCount(HARDWARE_VERIFIED_FLEET);

		const before = await readRowOrder(page);
		expect(before.map((row) => row.ifname)).toEqual([
			"wwan0",
			"wwan1",
			"wwan2",
			"wwan3",
			"wwan4",
			"wwan5",
			"wwan6",
			"wwan7",
		]);

		// A ModemManager restart re-issues the WHOLE roster's ids (board-measured:
		// 11,13,14,15 -> 0,1,2,3) in whatever order it re-probes the ports, so the
		// id no longer describes the same port it did a moment ago — here the
		// relationship inverts outright. Nothing about the operator's hardware
		// changed, so nothing on screen may move.
		send({
			status: {
				modems: scaleRoster(HARDWARE_VERIFIED_FLEET, {
					idBase: 500,
					descending: false,
				}),
			},
		});
		await expect
			.poll(async () => (await readRowOrder(page)).map((row) => row.id))
			.toEqual(
				Array.from({ length: HARDWARE_VERIFIED_FLEET }, (_unused, i) => `${500 + i}`),
			);
		const afterRenumber = await readRowOrder(page);
		expect(afterRenumber.map((row) => row.ifname)).toEqual(
			before.map((row) => row.ifname),
		);

		// THE FAILURE SCENARIO: two physically distinct HiLink units publish ONE
		// factory MAC, so systemd names only one of them predictably and the loser
		// falls back to `eth1` — and which one loses can change on any replug.
		// They must neither merge into one row nor swap places.
		const twin = (port: string, ifname: string): Record<string, unknown> => ({
			...routerDongle("router_managed", 0),
			ifname,
			name: "Huawei E3372",
			availability_reason: "router_direct",
			stable_key: `pci-0000:00:14.0-usb-0:${port}`,
		});

		send({
			status: {
				modems: {
					"3001": twin("1.4.1", "enx0c5b8f279a64"),
					"3002": twin("1.4.3", "eth1"),
				},
			},
		});
		await expect(page.getByTestId("modem-row")).toHaveCount(2);
		expect(await readRowOrder(page)).toEqual([
			{ id: "3001", ifname: "enx0c5b8f279a64" },
			{ id: "3002", ifname: "eth1" },
		]);

		// (a) They rename against each other and keep their ids. The `{#each}` key
		//     is the id, so neither row may remount, merge or swap.
		send({
			status: {
				modems: {
					"3001": twin("1.4.1", "eth1"),
					"3002": twin("1.4.3", "enx0c5b8f279a64"),
				},
			},
		});
		await expect
			.poll(async () => (await readRowOrder(page)).map((row) => row.ifname))
			.toEqual(["eth1", "enx0c5b8f279a64"]);
		expect(await page.getByTestId("modem-row").count()).toBe(2);
		expect((await readRowOrder(page)).map((row) => row.id)).toEqual(["3001", "3002"]);

		// (b) A dongle's id is an ALLOCATED index, so a backend restart that
		//     re-walks the sources can hand the unit at 1.4.3 the lower one. The
		//     port decides, so the rows must not swap.
		send({
			status: {
				modems: {
					"3001": twin("1.4.3", "enx0c5b8f279a64"),
					"3002": twin("1.4.1", "eth1"),
				},
			},
		});
		await expect
			.poll(async () => (await readRowOrder(page)).map((row) => row.id))
			.toEqual(["3002", "3001"]);
		expect((await readRowOrder(page)).map((row) => row.ifname)).toEqual([
			"eth1",
			"enx0c5b8f279a64",
		]);
		expect(await page.getByTestId("modem-row").count()).toBe(2);

		writeEvidence("replug-identity.json", {
			generatedAt: new Date().toISOString(),
			fleet: HARDWARE_VERIFIED_FLEET,
			beforeRenumber: before,
			afterRenumber,
			twinsAfterRenameAndIdSwap: await readRowOrder(page),
		});
	});

	// ── 3c. LO-1 / LO-4 / LO-5 — the nine non-base catalogs ──────────────────
	test("every shipped locale contains its content on the modem surfaces at the narrowest width @a11y", async ({
		authedPage: page,
	}) => {
		// `de`/`hi` are the long-string overflow probes and `ja`/`ko`/`zh` the CJK
		// fallback probes (§5), but the remaining catalogs are swept too: a rule
		// that only holds for the locales someone remembered to name is not a rule.
		const LOCALES = ["es", "de", "fr", "pt-BR", "hi", "ja", "ko", "zh"] as const;
		const report: Record<string, unknown> = {};
		test.setTimeout(300_000);

		await page.setViewportSize({ width: 375, height: 812 });
		for (const locale of LOCALES) {
			await enterNetworkAs(page, locale);

			const measured = await probeContainment(page);
			expectContained(measured, `${locale} @ 375x812`);

			// LO-4: the fallback has to RENDER, not merely be declared. A tofu run
			// and a dropped glyph both collapse the box, so a state badge that says
			// a word must also MEASURE one — asserted per row, since a single
			// aggregate could be carried by the one Latin-script row in the roster.
			const badgeWidths = await page.evaluate(() =>
				[...document.querySelectorAll('[data-testid="modem-state-badge"]')].map((el) => ({
					text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
					width: el.getBoundingClientRect().width,
				})),
			);
			expect(badgeWidths.length, `${locale}: state badges must be laid out`).toBe(5);
			for (const badge of badgeWidths) {
				expect(badge.text.length, `${locale}: a state badge rendered no word`).toBeGreaterThan(0);
				expect(
					badge.width,
					`${locale}: state badge "${badge.text}" measured ${badge.width}px — the glyph run did not render`,
				).toBeGreaterThan(16);
			}

			// The DISCLOSURE half, and it is where the long strings live. Todo 29
			// reworded the class band from a wire token into a translated sentence
			// fragment (`Gerenciado diretamente`, `Gestionado directamente`), and
			// filed it behind the per-row disclosure — so the probe above cannot
			// see it at all. `openRowDisclosures` is what makes it measurable, and
			// `modem-class-badge` is a GATED id, so a clipped one fails here.
			await openRowDisclosures(page);
			const disclosed = await probeContainment(page);
			expectContained(disclosed, `${locale} @ 375x812 (disclosures open)`);

			const classBadges = await page.evaluate(() =>
				[...document.querySelectorAll('[data-testid="modem-class-badge"]')].map(
					(el) => ({
						band: el.getAttribute("data-class-band"),
						text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
						width: el.getBoundingClientRect().width,
						visible:
							getComputedStyle(el as HTMLElement).visibility === "visible",
					}),
				),
			);
			expect(classBadges.length, `${locale}: class badges must be laid out`).toBe(5);
			for (const badge of classBadges) {
				expect(
					badge.visible,
					`${locale}: the ${badge.band} class badge is still clipped`,
				).toBe(true);
				expect(
					badge.text.length,
					`${locale}: the ${badge.band} class badge rendered no word`,
				).toBeGreaterThan(0);
				expect(
					badge.width,
					`${locale}: class badge "${badge.text}" measured ${badge.width}px`,
				).toBeGreaterThan(16);
			}

			report[locale] = {
				...measured,
				badges: badgeWidths,
				disclosed: { ...disclosed, classBadges },
			};
		}

		writeEvidence("locale-containment.json", report);
	});

	// ── 3d. RM-1…RM-4 — reduced motion, as a RENDERED state ──────────────────
	test("reduced motion stills the modem surfaces without taking a state with it @a11y", async ({
		authedPage: page,
	}) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.setViewportSize(KIOSK);
		await navigateTo(page, "network");
		serverConfig({ modem_provisioning: true });
		send({ status: { modems: fullRoster() } });
		send({ netif: DONGLE_NETIF });
		await expect(cellularSection(page)).toBeVisible({ timeout: 15_000 });

		const dialog = await openModemDialog(page);
		await openModemAdvanced(dialog);
		await expect(dialog.getByTestId("modem-usb-mode-card")).toBeVisible();

		// RM-1/RM-4: read the COMPUTED duration off the live tree. Grepping the
		// stylesheet would prove a rule exists, not that it reached these nodes —
		// and the disclosures here animate `grid-template-rows`/`visibility`, which
		// a component-level `transition-*` utility sets independently of app.css.
		const moving = await page.evaluate(() => {
			const toMs = (value: string): number =>
				Math.max(
					0,
					...value
						.split(",")
						.map((part) => part.trim())
						.map((part) =>
							part.endsWith("ms")
								? Number.parseFloat(part)
								: Number.parseFloat(part) * 1000,
						)
						.filter((n) => Number.isFinite(n)),
				);
			const out: string[] = [];
			for (const scope of ['section:has([data-testid="modem-row"])', '[role="dialog"]']) {
				const root = document.querySelector(scope);
				if (!root) continue;
				for (const el of [root, ...root.querySelectorAll("*")]) {
					const style = getComputedStyle(el as HTMLElement);
					const animated =
						style.animationName !== "none" && toMs(style.animationDuration) > 1;
					const transitioned = toMs(style.transitionDuration) > 1;
					if (animated || transitioned) {
						const name =
							el.getAttribute("data-testid") ??
							el.getAttribute("class") ??
							el.tagName;
						out.push(
							`${name} anim=${style.animationDuration} trans=${style.transitionDuration}`,
						);
					}
				}
			}
			return [...new Set(out)];
		});
		expect(
			moving,
			`reduced motion is not honoured on the modem surfaces:\n${moving.slice(0, 20).join("\n")}`,
		).toEqual([]);

		// RM-2: stilling must cost NO information. Every row's state is still
		// carried by a word AND a glyph, and the five rows are still told apart —
		// the property a pulse could otherwise have been the sole carrier of.
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);

		const states = await page.evaluate(() =>
			[...document.querySelectorAll('[data-testid="modem-row"]')].map((row) => {
				const badge = row.querySelector('[data-testid="modem-state-badge"]');
				return {
					modem: row.getAttribute("data-modem-id"),
					state: badge?.getAttribute("data-modem-state") ?? null,
					word: (badge?.textContent ?? "").replace(/\s+/g, " ").trim(),
					glyphs: badge?.querySelectorAll("svg").length ?? 0,
				};
			}),
		);
		expect(states.length).toBe(5);
		for (const row of states) {
			expect(row.word.length, `${row.modem}: state carries no word under reduced motion`).toBeGreaterThan(
				0,
			);
			expect(row.glyphs, `${row.modem}: state carries no glyph under reduced motion`).toBe(1);
		}

		writeEvidence("reduced-motion.json", {
			generatedAt: new Date().toISOString(),
			stillMoving: moving,
			states,
		});
	});

	// ── 4. 44px touch targets + the pinned known deviation ───────────────────
	test("touch mode lifts every modem control to 44px, and the known switch deviation is pinned @a11y", async ({
		page,
	}) => {
		await page.setViewportSize(KIOSK);
		// `data-layout-mode` must be set BEFORE first paint: applying it afterwards
		// measures the pre-lift geometry (32px where the at-load path measures 44).
		await page.goto("/?mode=touch");
		await ensureAuthenticated(page);
		await expect(page.locator("html")).toHaveAttribute("data-layout-mode", "touch");

		await navigateTo(page, "network");
		serverConfig({ modem_provisioning: true });
		send({ status: { modems: fullRoster() } });
		send({ netif: DONGLE_NETIF });
		await expect(cellularSection(page)).toBeVisible({ timeout: 15_000 });

		const dialog = await openModemDialog(page);
		await openModemAdvanced(dialog);
		await expect(dialog.getByTestId("modem-usb-mode-card")).toBeVisible();

		const measured = await page.evaluate(() => {
			const scopes: [string, Element | null][] = [
				["section", document.querySelector('section:has([data-testid="modem-row"])')],
				["dialog", document.querySelector('[role="dialog"]')],
			];

			// TT-1 says HIT AREA, and on this surface those are two different
			// numbers: a switch keeps an 18.4px painted track and carries its
			// target on an `::after` overlay, which `getBoundingClientRect()`
			// structurally cannot see.
			//
			// The overlay's extent is read from the pseudo's own resolved style
			// rather than probed with `elementFromPoint`, and that is not a
			// shortcut. This gate measures with the modem dialog OPEN, so the
			// section behind it sits under a scrim and part of the dialog's own
			// body is scrolled past — most controls answer no hit test at all at
			// the moment of measurement (`reachable` below already records that,
			// and TT-2 already filters on it). A declared target is the property
			// TT-1 is about; whether a given pixel is momentarily covered is not.
			//
			// An absolutely-positioned pseudo resolves its insets against the
			// PADDING box, so the overlay's height is that box minus both insets.
			// A control with no overlay reports `content: none` and static
			// position, falls through, and is measured on its box as before.
			const overlayHeight = (node: HTMLElement, rect: DOMRect): number => {
				const after = getComputedStyle(node, "::after");
				if (after.position !== "absolute" || after.content === "none") return 0;
				const style = getComputedStyle(node);
				const padded =
					rect.height -
					Number.parseFloat(style.borderTopWidth) -
					Number.parseFloat(style.borderBottomWidth);
				const height =
					padded -
					Number.parseFloat(after.insetBlockStart) -
					Number.parseFloat(after.insetBlockEnd);
				return Number.isFinite(height) ? height : 0;
			};

			const seen = new Set<Element>();
			const out: {
				scope: string;
				slot: string;
				reachable: boolean;
				height: number;
				hitHeight: number;
				label: string;
				disabled: boolean;
				box: { left: number; right: number; top: number; bottom: number };
			}[] = [];
			for (const [scopeName, scope] of scopes) {
				if (scope === null) continue;
				for (const el of scope.querySelectorAll("[data-slot]")) {
					const node = el as HTMLElement;
					if (seen.has(node) || node.offsetParent === null) continue;
					if (getComputedStyle(node).visibility === "hidden") continue;
					const slot = node.getAttribute("data-slot") ?? "";
					if (!["button", "switch", "input", "select-trigger"].includes(slot)) continue;
					seen.add(node);
					const rect = node.getBoundingClientRect();
					const atCentre = document.elementFromPoint(
						rect.left + rect.width / 2,
						rect.top + rect.height / 2,
					);
					out.push({
						scope: scopeName,
						slot,
						reachable: atCentre !== null && node.contains(atCentre),
						height: rect.height,
						hitHeight: Math.max(rect.height, overlayHeight(node, rect)),
						disabled:
							node.hasAttribute("disabled") ||
							node.getAttribute("aria-disabled") === "true",
						box: {
							left: rect.left,
							right: rect.right,
							top: rect.top,
							bottom: rect.bottom,
						},
						label:
							node.getAttribute("data-testid") ??
							node.getAttribute("aria-label") ??
							(node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
					});
				}
			}
			return out;
		});

		expect(measured.length, "no interactive controls were measured").toBeGreaterThan(0);

		const TARGET_PX = 44;
		const short = measured.filter((c) => c.hitHeight < TARGET_PX - 0.5);
		const shortSlots = [...new Set(short.map((c) => c.slot))].sort();

		// THE PIN: no control on these surfaces is sanctioned below the target.
		//
		// It is an EXACT SET rather than a floor, which is what makes it a gate and
		// not a running complaint — any control that regresses grows the set and
		// reddens here, and it cannot be silenced without an explicit edit.
		//
		// `[data-slot='switch']` and `[data-slot='select-trigger']` are the two the
		// `[data-layout-mode='touch']` lift in `app.css` reaches LAST, and they are
		// reached differently on purpose. A select trigger takes `min-height` like
		// every other control. A switch may not: growing its box stretches the
		// painted track into a 44px pill and strands the thumb, whose checked
		// position is a translate off its own width. A switch therefore carries its
		// target on the `::after` overlay the component ships — a HIT AREA, which is
		// what TT-1 asks for and why `hitHeight` above is measured rather than read
		// off the box.
		const KNOWN_SHORT_SLOTS: readonly string[] = [];
		expect(
			shortSlots,
			`touch-target inventory changed. Controls under ${TARGET_PX}px:\n${JSON.stringify(short, null, 2)}\n` +
				"There is no sanctioned deviation left — fix the control, not this list.",
		).toEqual([...KNOWN_SHORT_SLOTS]);

		// Every control is genuinely at the target, including each modem row's
		// Configure button, the USB-mode switch trigger and every toggle.
		const lifted = measured.filter((c) => !KNOWN_SHORT_SLOTS.includes(c.slot));
		expect(lifted.length, "no lifted controls were measured").toBeGreaterThan(0);
		for (const control of lifted) {
			expect(
				control.hitHeight,
				`${control.slot} "${control.label}" reaches ${control.hitHeight}px, below the ${TARGET_PX}px target`,
			).toBeGreaterThanOrEqual(TARGET_PX - 0.5);
		}

		// A switch reaches the target through its overlay and NOT through its box,
		// so its box must stay small. Asserting both bounds is what stops the
		// tempting one-line "fix" of listing it beside the `min-height` controls.
		const switches = measured.filter((c) => c.slot === "switch");
		expect(
			switches.length,
			"the roster must render at least one switch, or the rule below is vacuous",
		).toBeGreaterThan(0);
		for (const control of switches) {
			expect(
				control.height,
				`switch "${control.label}" was grown to ${control.height}px — lift its ::after hit area, not its box`,
			).toBeLessThan(TARGET_PX - 0.5);
		}

		// TT-4: a DISABLED control keeps its full target. It must not shrink, because
		// a control that resizes when its block clears is a layout jump under the
		// operator's finger — and the roster is built to guarantee the sample (the
		// three dongle rows all refuse Configure).
		const disabledLifted = lifted.filter((c) => c.disabled);
		expect(
			disabledLifted.length,
			"the roster must render at least one disabled control, or TT-4 is vacuous",
		).toBeGreaterThan(0);
		for (const control of disabledLifted) {
			expect(
				control.hitHeight,
				`disabled ${control.slot} "${control.label}" shrank to ${control.hitHeight}px`,
			).toBeGreaterThanOrEqual(TARGET_PX - 0.5);
		}

		// TT-2: >= 8px between adjacent interactive elements, so a fingertip cannot
		// straddle two of them. Measured pairwise on the RENDERED boxes rather than
		// read off the `gap-2` utility — a wrapped cluster's real neighbours are not
		// the ones the class list implies, and only the boxes know which those are.
		//
		// Only genuinely CO-REACHABLE controls can be straddled, and two filters are
		// what make that true. Pairs are compared WITHIN a surface only — an open
		// dialog is its own layer, so section/dialog pairs "overlap" by tens of
		// pixels across a modal scrim no fingertip crosses. And each control must
		// win the hit test at its own centre: a control scrolled UNDER the dialog's
		// sticky header still reports a box there, but the header owns those pixels,
		// so the pair is occluded rather than adjacent. Both filters removed real
		// phantom findings; neither can hide a control that a finger can reach.
		const SEPARATION_PX = 8;
		const tooClose: string[] = [];
		for (let i = 0; i < measured.length; i++) {
			for (let j = i + 1; j < measured.length; j++) {
				const a = measured[i];
				const b = measured[j];
				if (a === undefined || b === undefined) continue;
				if (a.scope !== b.scope) continue;
				if (!a.reachable || !b.reachable) continue;
				const dx = Math.max(a.box.left - b.box.right, b.box.left - a.box.right);
				const dy = Math.max(a.box.top - b.box.bottom, b.box.top - a.box.bottom);
				// Separated on either axis is separated; the gap is the larger one.
				const gap = Math.max(dx, dy);
				if (gap < SEPARATION_PX - 0.5) {
					const box = (c: (typeof measured)[number]): string =>
						`[${Math.round(c.box.left)},${Math.round(c.box.top)} ${Math.round(c.box.right)},${Math.round(c.box.bottom)}]`;
					tooClose.push(
						`${a.slot} "${a.label}" ${box(a)} <-> ${b.slot} "${b.label}" ${box(b)} = ${gap.toFixed(1)}px`,
					);
				}
			}
		}
		expect(
			tooClose,
			`interactive elements closer than ${SEPARATION_PX}px:\n${tooClose.join("\n")}`,
		).toEqual([]);

		writeEvidence("touch-targets.json", {
			generatedAt: new Date().toISOString(),
			viewport: KIOSK,
			targetPx: TARGET_PX,
			separationPx: SEPARATION_PX,
			knownShortSlots: KNOWN_SHORT_SLOTS,
			measured,
		});
	});
});
