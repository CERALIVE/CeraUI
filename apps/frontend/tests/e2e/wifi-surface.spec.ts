import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { evidencePath, navigateTo } from "./helpers";

/**
 * T9 — WiFi surface clobber regressions (ceraui-os-interaction-ux), @functional.
 *
 * Proves the WifiSelectorDialog's operation-phase contract against the REAL
 * frontend stack (async-operation store + subscriptions `wifi`/`status` routing +
 * the pure outcome predicates from T5–T7) with NO screenshots — every assertion
 * reads the DOM / accessibility tree.
 *
 * The clobber being guarded: a periodic full `status`/`wifi` re-broadcast
 * re-references the available-network set on every tick. A naive surface would
 * reset the in-flight spinner or auto-close the dialog when that snapshot lands.
 * The fix keeps the keyed op `pending` (intent flags + the pure predicates), so
 * the control holds until an authoritative confirm / failure / TTL arrives.
 *
 * ── WebSocket harness (addInitScript) ────────────────────────────────────────
 * Adapted from field-lock.spec.ts (which must not be modified). The app socket is
 * wrapped so the test can:
 *   1. Authenticate without the device password (rewrite `auth.login` → token).
 *   2. Inject `wifi`/`status` echoes via `dev.emit` at known times.
 *   3. Drop+fake a `wifi.*` RPC so the op's pending window is fully deterministic
 *      (no real backend confirm releases it): `_wifiFake[path] = result`.
 *
 * Prereq: backend on :3002 (NODE_ENV=development, MOCK_SCENARIO=multi-modem-wifi);
 * frontend (:6173) started by playwright.config webServer.
 */

const DIALOG = "Available Networks";
const DEVICE_ID = "0"; // primary wlan0 → WifiStatus key "0" → op key `wifi:0`
const SAVED_SSID = "Office_Secure"; // seeded saved (non-active) → Connect affordance
const NEW_SECURED_SSID = "CoffeeShop_5G"; // seeded unsaved + WPA → inline password form
const BUSY_TEXT = "Device is busy, try again in a moment";

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
		lastWifi: null,
		// Map<path, result>. A wifi RPC whose path is present is dropped and its
		// promise resolved locally with the given result, so the op's pending window
		// is owned by the test (no real backend confirm).
		_wifiFake: {} as Record<string, unknown>,
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

				// Drop+fake an armed wifi RPC: never reaches the backend (no mock-state
				// mutation, no eventual snapshot confirm), resolved locally so osCommand
				// classifies the faked result and the op latches as the test intends.
				if (p && Object.prototype.hasOwnProperty.call(w.__cera._wifiFake, p)) {
					const result = w.__cera._wifiFake[p];
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

function armWifiFake(page: Page, path: string, result: unknown): Promise<void> {
	return page.evaluate(
		([pth, res]) => {
			(window as any).__cera._wifiFake[pth] = res;
		},
		[path, result] as const,
	);
}

/** Re-broadcast the last captured wifi snapshot as a `status` tick (the clobber). */
async function pumpStatusTicks(page: Page, count: number): Promise<void> {
	await expect
		.poll(() => page.evaluate(() => (window as any).__cera.lastWifi !== null), {
			timeout: 10_000,
			message: "a wifi snapshot should arrive via a status broadcast",
		})
		.toBe(true);
	for (let i = 0; i < count; i++) {
		await page.evaluate(() => {
			const w = window as any;
			w.__cera.emit("status", { wifi: w.__cera.lastWifi });
		});
	}
}

async function openWifiDialog(page: Page): Promise<void> {
	// The authed shell must be mounted before the nav rail is clickable; under the
	// parallel suite a cold vite can still show the #js-failed overlay (see
	// global-setup). Wait for the header, then navigate.
	await page.locator("header").first().waitFor({ state: "visible", timeout: 30_000 });
	await navigateTo(page, "network");
	const trigger = page.locator('[data-testid="open-wifi-selector-dialog"]');
	await expect(trigger).toBeEnabled();
	await trigger.click();
	await expect(page.getByRole("dialog", { name: DIALOG })).toBeVisible();
}

function dialog(page: Page) {
	return page.getByRole("dialog", { name: DIALOG });
}

test.describe.configure({ mode: "serial" });

test.describe(
	"wifi selector surface — clobber regressions",
	{ tag: "@functional" },
	() => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser integration proof",
	);

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the WiFi selector UI",
		);
		await page.addInitScript(installWsHarness, TOKEN);
		await page.goto("/");
		await page.waitForFunction(() => (window as any).__ceraAppMounted === true, undefined, {
			timeout: 60_000,
		});
		await page.evaluate(() => document.getElementById("js-failed")?.remove());
		await openWifiDialog(page);
	});

	test.afterAll(async () => {
		const header = [
			"T9 — WiFi surface clobber regressions: functional E2E evidence",
			"Driver: real frontend (async-operation store + subscriptions wifi/status",
			"        routing + T5–T7 pure predicates) vs. real dev backend; echoes",
			"        injected via dev.emit, pending windows pinned via drop+fake.",
			`Generated: ${new Date().toISOString()}`,
			"",
		];
		fs.writeFileSync(
			evidencePath("task-9-wifi-surface.txt"),
			[...header, ...evidence, ""].join("\n"),
			"utf8",
		);
	});

	// ── Scenarios 1 + 2: pending survives periodic status ticks; confirm closes ──
	test("pending connect survives periodic status ticks, then {connect:true} confirms + closes", async ({
		page,
	}) => {
		record("── pending connect: clobber-resist + confirm ──");
		// Drop+fake the connect so it stays pending with no backend confirm.
		await armWifiFake(page, "wifi.connect", { success: true });

		const connectBtn = dialog(page).getByRole("button", {
			name: `Connect ${SAVED_SSID}`,
		});
		await expect(connectBtn).toBeEnabled();
		await connectBtn.click();

		// The row drops into the inline "Connecting…" state (op pending).
		await expect(dialog(page).getByText(/Connecting/).first()).toBeVisible();
		record(`clicked Connect ${SAVED_SSID} → inline "Connecting…" (op pending)`);

		// Periodic status re-broadcasts must NOT reset the spinner or close dialog.
		await pumpStatusTicks(page, 4);
		await expect(dialog(page).getByText(/Connecting/).first()).toBeVisible();
		await expect(dialog(page)).toBeVisible();
		record("injected 4 periodic status ticks → still Connecting, dialog OPEN (no clobber) ✓");

		// The authoritative confirm frame releases it → dialog closes.
		await emit(page, "wifi", { connect: true, device: DEVICE_ID });
		await expect(dialog(page)).toBeHidden();
		record(`emitted wifi {connect:true,device:${DEVICE_ID}} → confirmed + dialog closed ✓`);
	});

	// ── Scenario 3: wrong-password connectNew → re-enable ──────────────────────
	test("wrong-password connectNew surfaces auth failure and re-enables the row", async ({
		page,
	}) => {
		record("── connectNew wrong password ──");
		await armWifiFake(page, "wifi.connectNew", { success: true });

		// Open the inline password form for an unsaved secured network.
		await dialog(page)
			.getByRole("button", { name: `Connect ${NEW_SECURED_SSID}` })
			.click();
		const pw = page.locator("#wifi-new-password");
		await expect(pw).toBeVisible();
		await pw.fill("password1");
		await expect(pw).toHaveValue("password1");
		// The form's submit is gated on the schema password floor — clicking it once
		// enabled guarantees the bound password propagated (no Enter-key race). Its
		// accessible name is the bare "Connect" (row buttons are "Connect <ssid>").
		const submit = dialog(page).getByRole("button", {
			name: "Connect",
			exact: true,
		});
		await expect(submit).toBeEnabled();
		await submit.click(); // submit → osCommand pending (faked success)
		await expect(dialog(page).getByText(/Connecting/).first()).toBeVisible();
		record(`submitted password for new ${NEW_SECURED_SSID} → "Connecting…" (op pending)`);

		// A status tick mid-flight must not clobber the pending op.
		await pumpStatusTicks(page, 2);
		await expect(dialog(page).getByText(/Connecting/).first()).toBeVisible();
		record("status tick mid-connectNew → still Connecting (no clobber) ✓");

		// Wrong-password result frame → op fails, row re-enables its Connect button.
		await emit(page, "wifi", { new: { error: "auth", device: DEVICE_ID } });
		const reConnect = dialog(page).getByRole("button", {
			name: `Connect ${NEW_SECURED_SSID}`,
		});
		await expect(reConnect).toBeVisible();
		await expect(reConnect).toBeEnabled();
		await expect(dialog(page)).toBeVisible();
		record("emitted wifi {new:{error:'auth'}} → row re-enabled, dialog stays open ✓");
	});

	// ── Scenario 4: never-confirming → timed_out Retry, dialog NOT auto-closed ──
	test("a never-confirming connect times out to an inline Retry without closing the dialog", async ({
		page,
	}) => {
		test.setTimeout(40_000); // ASYNC_OP_TTL_MS (15s) + headroom
		record("── never-confirming connect → timed_out ──");
		await armWifiFake(page, "wifi.connect", { success: true });

		await dialog(page)
			.getByRole("button", { name: `Connect ${SAVED_SSID}` })
			.click();
		await expect(dialog(page).getByText(/Connecting/).first()).toBeVisible();
		record(`Connect ${SAVED_SSID} dispatched; no confirm will ever arrive`);

		// After the TTL valve fires, the row shows the calm "still working" + Retry
		// affordance — the dialog must NOT have auto-closed mid-flight.
		await expect(dialog(page).getByText(/Still working/)).toBeVisible({
			timeout: 22_000,
		});
		await expect(
			dialog(page).getByRole("button", { name: `Retry ${SAVED_SSID}` }),
		).toBeVisible();
		await expect(dialog(page)).toBeVisible();
		record("TTL elapsed → inline 'Still working' + Retry, dialog still OPEN ✓");
	});

	// ── Scenario 5: DEVICE_BUSY → calm busy toast + re-enable ───────────────────
	test("a DEVICE_BUSY connect result raises a calm busy toast and re-enables the button", async ({
		page,
	}) => {
		record("── DEVICE_BUSY connect ──");
		await armWifiFake(page, "wifi.connect", {
			success: false,
			error: "DEVICE_BUSY",
		});

		await dialog(page)
			.getByRole("button", { name: `Connect ${SAVED_SSID}` })
			.click();

		// osCommand classifies busy → single calm toast (no error treatment).
		await expect(page.getByText(BUSY_TEXT)).toBeVisible();
		record(`Connect ${SAVED_SSID} → DEVICE_BUSY → calm busy toast ✓`);

		// The op fails out of pending → the Connect button returns enabled.
		const connectBtn = dialog(page).getByRole("button", {
			name: `Connect ${SAVED_SSID}`,
		});
		await expect(connectBtn).toBeVisible();
		await expect(connectBtn).toBeEnabled();
		await expect(dialog(page)).toBeVisible();
		record("op left pending → Connect button re-enabled, dialog stays open ✓");
	});
});
