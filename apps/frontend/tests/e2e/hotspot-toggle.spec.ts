import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { evidencePath, navigateTo } from "./helpers";

/**
 * T18 — Hotspot surface clobber regressions (ceraui-os-interaction-ux), @functional.
 *
 * Proves the HotspotDialog's keyed async-operation contract against the REAL
 * frontend stack (async-operation store + `os-toggle-predicates` confirm logic +
 * the `subscriptions` wifi/status routing) with NO screenshots — every assertion
 * reads the DOM / accessibility tree.
 *
 * The clobber being guarded: the backend re-broadcasts the full wifi snapshot on
 * a periodic `status` tick. A naive surface would drop the in-flight spinner or
 * flip the toggle label when that stale snapshot lands mid-operation. The fix
 * keeps the keyed op `pending` (intent + the pure `hotspotToggleConfirmed`
 * predicate), so the control holds until the authoritative snapshot reports the
 * intended mode — or the deferred `hotspot.config` event resolves a save.
 *
 * ── WebSocket harness (addInitScript) ────────────────────────────────────────
 * Adapted from wifi-surface.spec.ts (field-lock.spec.ts must not be modified).
 * The app socket is wrapped so the test can, WITHOUT touching app source:
 *   1. Authenticate without the device password (rewrite `auth.login` → token).
 *   2. Capture the live wifi snapshot delivered inside `status` and the `device`
 *      the dialog dispatched, so injected echoes target the same interface key.
 *   3. Inject `status`/`wifi` echoes via `dev.emit` at known times.
 *   4. Drop+fake a `wifi.*` RPC so the op's pending window is fully deterministic
 *      (no real backend confirm releases it): `_fake[path] = result`.
 *
 * Prereq: backend on :3002 (NODE_ENV=development, MOCK_SCENARIO=multi-modem-wifi);
 * frontend (:6173) started by playwright.config webServer.
 */

const HOTSPOT_DIALOG = "Configure Hotspot";
const FAIL_TEXT = "Couldn't complete the action";
const FORM_NAME = "CeraTestAP";
const FORM_PASS = "cerapass123";

const TOKEN: string = (() => {
	const tokensPath = path.resolve(
		import.meta.dirname,
		"../../../backend/auth_tokens.json",
	);
	const tokens = Object.keys(
		JSON.parse(fs.readFileSync(tokensPath, "utf8")) as Record<string, true>,
	);
	if (tokens.length === 0) {
		throw new Error(
			`No persistent auth tokens in ${tokensPath}; cannot authenticate e2e socket.`,
		);
	}
	return tokens[0];
})();

const evidence: string[] = [];
function record(line: string): void {
	evidence.push(line);
}

/**
 * Browser-side WebSocket harness. Serialized into the page via addInitScript;
 * must be fully self-contained (no outer-scope references except its `token`).
 */
function installWsHarness(token: string): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__cera) return;
	const Real = w.WebSocket;

	w.__cera = {
		socket: null,
		// Latest full wifi snapshot delivered inside a `status` frame.
		lastWifi: null as Record<string, unknown> | null,
		// The `device` key the dialog dispatched its last hotspot op against.
		lastHotspotDevice: undefined as string | undefined,
		// Map<path, result>. A matched RPC is dropped + resolved locally with the
		// given result, so the op's pending window is owned by the test.
		_fake: {} as Record<string, unknown>,
		_seq: 0,
		emit(type: string, payload: unknown) {
			const s = w.__cera.socket;
			if (s)
				s.__realSend(
					JSON.stringify({
						id: `emit-${++w.__cera._seq}`,
						path: ["dev", "emit"],
						input: { type, payload },
					}),
				);
		},
	};

	const HOTSPOT_PATHS = new Set([
		"wifi.hotspotStart",
		"wifi.hotspotStop",
		"wifi.hotspotConfigure",
	]);

	class HookedWS extends Real {
		// biome-ignore lint/suspicious/noExplicitAny: native ctor signature.
		constructor(url: string, protocols?: any) {
			super(url, protocols);
			w.__cera.socket = this;
			this.__realSend = Real.prototype.send.bind(this);
			this.addEventListener("message", (ev: MessageEvent) => {
				try {
					const o = JSON.parse(ev.data);
					// The wifi snapshot is delivered inside `status` (broadcastWifiState).
					if (o && o.status && o.status.wifi) {
						w.__cera.lastWifi = o.status.wifi;
					}
				} catch {
					/* non-JSON frame */
				}
			});
		}

		// biome-ignore lint/suspicious/noExplicitAny: WebSocket.send payload union.
		send(data: any) {
			try {
				const msg = JSON.parse(data);
				const p = Array.isArray(msg.path) ? msg.path.join(".") : null;

				if (p === "auth.login") {
					msg.input = { token, persistent_token: true };
					return this.__realSend(JSON.stringify(msg));
				}

				// Remember the interface key the dialog is operating on so injected
				// echoes (active snapshot / deferred config) hit the same `device`.
				if (p && HOTSPOT_PATHS.has(p) && msg.input && msg.input.device !== undefined) {
					w.__cera.lastHotspotDevice = String(msg.input.device);
				}

				// Drop+fake an armed RPC: never reaches the backend, resolved locally
				// so osCommand classifies the faked result and the op latches.
				if (p && Object.prototype.hasOwnProperty.call(w.__cera._fake, p)) {
					const result = w.__cera._fake[p];
					const id = msg.id;
					setTimeout(
						() =>
							this.dispatchEvent(
								new MessageEvent("message", {
									data: JSON.stringify({ id, result }),
								}),
							),
						0,
					);
					return undefined;
				}
			} catch {
				/* not an RPC frame (e.g. keepalive) */
			}
			return this.__realSend(data);
		}
	}

	w.WebSocket = HookedWS;
	try {
		localStorage.setItem("auth", "e2e-token-marker");
	} catch {
		/* localStorage unavailable */
	}
}

// ── Browser-bridge helpers ──────────────────────────────────────────────────

function emit(page: Page, type: string, payload: unknown): Promise<void> {
	return page.evaluate(
		([t, p]) => (window as any).__cera.emit(t, p),
		[type, payload] as const,
	);
}

function armFake(page: Page, rpcPath: string, result: unknown): Promise<void> {
	return page.evaluate(
		([pth, res]) => {
			(window as any).__cera._fake[pth] = res;
		},
		[rpcPath, result] as const,
	);
}

function lastHotspotDevice(page: Page): Promise<string | undefined> {
	return page.evaluate(() => (window as any).__cera.lastHotspotDevice);
}

/** Wait until a wifi snapshot has been captured from a status broadcast. */
async function awaitWifiSnapshot(page: Page): Promise<void> {
	await expect
		.poll(() => page.evaluate(() => (window as any).__cera.lastWifi !== null), {
			timeout: 10_000,
			message: "a wifi snapshot should arrive via a status broadcast",
		})
		.toBe(true);
}

/** Re-broadcast the last captured wifi snapshot as a `status` tick (the clobber). */
async function pumpStatusTicks(page: Page, count: number): Promise<void> {
	await awaitWifiSnapshot(page);
	for (let i = 0; i < count; i++) {
		await page.evaluate(() => {
			const w = window as any;
			w.__cera.emit("status", { wifi: w.__cera.lastWifi });
		});
	}
}

/** Inject a wifi snapshot where `device` is now broadcasting a hotspot. */
async function emitHotspotActive(page: Page, device: string): Promise<void> {
	await page.evaluate((dev) => {
		const w = window as any;
		const clone = JSON.parse(JSON.stringify(w.__cera.lastWifi ?? {}));
		const cur = clone[dev] ?? { ifname: dev };
		cur.hotspot = { name: "CeraTestAP", password: "cerapass123", channel: "auto" };
		clone[dev] = cur;
		w.__cera.emit("status", { wifi: clone });
	}, device);
}

function dialog(page: Page) {
	return page.getByRole("dialog", { name: HOTSPOT_DIALOG });
}

async function openHotspotDialog(page: Page): Promise<void> {
	await page.locator("header").first().waitFor({ state: "visible", timeout: 30_000 });
	await navigateTo(page, "network");
	const trigger = page.locator('[data-testid="open-hotspot-dialog"]');
	await expect(trigger).toBeEnabled();
	await trigger.click();
	await expect(dialog(page)).toBeVisible();
}

/** Fill name + password so isFormValid is true (start / save are gated on it). */
async function fillValidForm(page: Page): Promise<void> {
	await page.locator("#hotspot-name").fill(FORM_NAME);
	await page.locator("#hotspot-password").fill(FORM_PASS);
	await expect(page.locator("#hotspot-name")).toHaveValue(FORM_NAME);
	await expect(page.locator("#hotspot-password")).toHaveValue(FORM_PASS);
}

test.describe.configure({ mode: "serial" });

test.describe(
	"hotspot surface — clobber regressions",
	{ tag: "@functional" },
	() => {
		test.skip(
			({ browserName }) => browserName !== "chromium",
			"single-browser integration proof",
		);

		test.beforeEach(async ({ page }, testInfo) => {
			test.skip(
				testInfo.project.name !== "desktop",
				"desktop layout drives the hotspot UI",
			);
			await page.addInitScript(installWsHarness, TOKEN);
			await page.goto("/");
			await page
				.waitForFunction(() => (window as any).__ceraAppMounted === true, undefined, {
					timeout: 60_000,
				})
				.catch(() => undefined);
			await page.evaluate(() => document.getElementById("js-failed")?.remove());
			await openHotspotDialog(page);
		});

		test.afterAll(async () => {
			const header = [
				"T18 — Hotspot surface clobber regressions: functional E2E evidence",
				"Driver: real frontend (async-operation store + os-toggle-predicates +",
				"        subscriptions wifi/status routing) vs. real dev backend; echoes",
				"        injected via dev.emit, pending windows pinned via drop+fake.",
				`Generated: ${new Date().toISOString()}`,
				"",
			];
			fs.writeFileSync(
				evidencePath("task-18-hotspot-surface.txt"),
				[...header, ...evidence, ""].join("\n"),
				"utf8",
			);
		});

		// ── Scenario 1: hotspot start pending survives periodic status ticks ──────
		test("hotspot start pending survives periodic status ticks without flipping the label", async ({
			page,
		}) => {
			record("── hotspot start: clobber-resist + confirm ──");
			await fillValidForm(page);
			await armFake(page, "wifi.hotspotStart", { success: true });

			const enable = dialog(page).getByRole("button", {
				name: "Enable Hotspot",
				exact: true,
			});
			await expect(enable).toBeEnabled();
			await enable.click();

			// Op pending: the toggle disables and HOLDS its "Enable Hotspot" label.
			await expect(enable).toBeDisabled();
			record('clicked "Enable Hotspot" → op pending (button disabled, label held)');

			const device = await lastHotspotDevice(page);
			expect(device, "hotspot start must capture a device key").toBeTruthy();

			// Periodic status re-broadcasts (still inactive) must NOT flip the label
			// or drop the pending state, and must not auto-close the dialog.
			await pumpStatusTicks(page, 4);
			await expect(
				dialog(page).getByRole("button", { name: "Turn Off", exact: true }),
			).toHaveCount(0);
			await expect(enable).toBeVisible();
			await expect(enable).toBeDisabled();
			await expect(dialog(page)).toBeVisible();
			record("injected 4 periodic status ticks → label held, still pending, dialog OPEN ✓");

			// Authoritative snapshot reports the hotspot active → confirm releases it
			// and the label flips to "Turn Off".
			await emitHotspotActive(page, device as string);
			const turnOff = dialog(page).getByRole("button", {
				name: "Turn Off",
				exact: true,
			});
			await expect(turnOff).toBeVisible();
			await expect(turnOff).toBeEnabled();
			record(`emitted active wifi snapshot for device ${device} → confirmed, label "Turn Off" ✓`);
		});

		// ── Scenario 2: deferred hotspot.config SUCCESS confirms the save ─────────
		test("hotspot configure deferred hotspot.config success confirms the save", async ({
			page,
		}) => {
			record("── hotspot configure: deferred success ──");
			await fillValidForm(page);
			await armFake(page, "wifi.hotspotConfigure", { success: true });

			const saveSettled = dialog(page).getByRole("button", {
				name: "Save",
				exact: true,
			});
			const savePending = dialog(page).getByRole("button", { name: "Saving..." });
			await expect(saveSettled).toBeEnabled();
			await saveSettled.click();

			// Dispatch ack only — the op stays pending until the deferred event.
			await expect(savePending).toBeVisible();
			record('clicked "Save" → op pending ("Saving…"), awaiting deferred hotspot.config');

			const device = await lastHotspotDevice(page);
			expect(device, "configure must capture a device key").toBeTruthy();

			// Periodic status re-broadcasts must NOT resolve the pending save.
			await pumpStatusTicks(page, 3);
			await expect(savePending).toBeVisible();
			record("injected 3 periodic status ticks → still Saving (no clobber) ✓");

			// Deferred success event routes into hotspot-config:<device> → confirmed.
			await emit(page, "wifi", {
				hotspot: { config: { device, success: true } },
			});
			await expect(saveSettled).toBeEnabled();
			await expect(dialog(page)).toBeVisible();
			record(`emitted hotspot.config {device:${device},success:true} → confirmed, Save re-enabled ✓`);
		});

		// ── Scenario 3: deferred hotspot.config ERROR calmly re-enables save ──────
		test("hotspot configure deferred hotspot.config error calmly re-enables save with the form intact", async ({
			page,
		}) => {
			record("── hotspot configure: deferred error ──");
			await fillValidForm(page);
			await armFake(page, "wifi.hotspotConfigure", { success: true });

			const saveSettled = dialog(page).getByRole("button", {
				name: "Save",
				exact: true,
			});
			const savePending = dialog(page).getByRole("button", { name: "Saving..." });
			await expect(saveSettled).toBeEnabled();
			await saveSettled.click();
			await expect(savePending).toBeVisible();

			const device = await lastHotspotDevice(page);
			expect(device, "configure must capture a device key").toBeTruthy();

			// Deferred error event routes into hotspot-config:<device> → failed.
			await emit(page, "wifi", {
				hotspot: { config: { device, success: false, error: "mock_config_error" } },
			});

			// Calm treatment: the save returns enabled (no stuck spinner), the form
			// values are intact so the operator can retry, and NO error toast fires
			// (deferred failures re-enable calmly — same contract as wifi connectNew).
			await expect(saveSettled).toBeEnabled();
			await expect(page.locator("#hotspot-name")).toHaveValue(FORM_NAME);
			await expect(page.locator("#hotspot-password")).toHaveValue(FORM_PASS);
			await expect(dialog(page)).toBeVisible();
			await expect(page.getByText(FAIL_TEXT)).toHaveCount(0);
			record(
				`emitted hotspot.config {device:${device},success:false} → calm re-enable, form intact, no error toast ✓`,
			);
		});
	},
);
