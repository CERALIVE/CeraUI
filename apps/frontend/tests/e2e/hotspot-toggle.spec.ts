import fs from "node:fs";
import path from "node:path";
import type { WifiStatus } from "@ceraui/rpc/schemas";

import { type BackendRpc, expect, type Page, test } from "./fixtures/index.js";

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
 * Topology: local Vite dev on :6173 uses `__ceraSocketPort`; CI prebuilt Vite
 * preview on :6173 uses the HttpOnly cookie. Both target this worker's 31xx
 * development backend.
 */

const HOTSPOT_DIALOG = "Configure Hotspot";
const FAIL_TEXT = "Couldn't complete the action";
const FORM_NAME = "CeraTestAP";
const FORM_PASS = "cerapass123";

const TOKEN: string = (() => {
	const tokenPath = path.resolve(
		import.meta.dirname,
		"../../../backend/.e2e-auth-token",
	);
	let token: string;
	try {
		token = fs.readFileSync(tokenPath, "utf8").trim();
	} catch {
		throw new Error(
			`No persistent auth token at ${tokenPath}; cannot authenticate e2e socket.`,
		);
	}
	if (token.length === 0) {
		throw new Error(
			`Empty persistent auth token at ${tokenPath}; cannot authenticate e2e socket.`,
		);
	}
	return token;
})();

const evidence: string[] = [];
function record(line: string): void {
	evidence.push(line);
}

/**
 * Browser-side WebSocket harness. Serialized into the page via addInitScript;
 * must be fully self-contained (no outer-scope references except its `token`).
 */
type HarnessWifi = Record<string, Record<string, unknown> & { supports_hotspot?: boolean }>;

interface HotspotSocketHarness {
	socket: (WebSocket & { readonly __realSend: WebSocket["send"] }) | null;
	lastWifi: HarnessWifi | null;
	lastHotspotDevice?: string;
	lastHotspotIncarnation?: string;
	startTokens: Array<string | undefined>;
	holdStartReply: boolean;
	releaseStartReply?: () => void;
	_fake: Record<string, unknown>;
	_seq: number;
	emit(type: string, payload: unknown): Promise<void>;
}

type HotspotTestWindow = typeof window & {
	__ceraHotspot: HotspotSocketHarness;
	__ceraAppMounted?: boolean;
};

function installWsHarness(token: string): void {
	const w = window as HotspotTestWindow;
	if (w.__ceraHotspot) return;
	const Real = w.WebSocket;

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	function parseRecord(data: unknown): Record<string, unknown> | undefined {
		if (typeof data !== "string") return undefined;
		try {
			const parsed: unknown = JSON.parse(data);
			if (isRecord(parsed)) return parsed;
		} catch {
			// Non-JSON messages are not part of the harness.
		}
		return undefined;
	}

	function isWifiSnapshot(value: unknown): value is HarnessWifi {
		return isRecord(value) && Object.values(value).every((row) =>
			isRecord(row) && (row.supports_hotspot === undefined || typeof row.supports_hotspot === "boolean"),
		);
	}

	const harness: HotspotSocketHarness = w.__ceraHotspot = {
		socket: null,
		// Latest full wifi snapshot delivered inside a `status` frame.
		lastWifi: null,
		// The `device` key the dialog dispatched its last hotspot op against.
		startTokens: [],
		// The replacement test controls both the Start reply and Wi-Fi snapshots.
		holdStartReply: false,
		// Map<path, result>. A matched RPC is dropped + resolved locally with the
		// given result, so the op's pending window is owned by the test.
		_fake: {},
		_seq: 0,
		emit(type: string, payload: unknown): Promise<void> {
			const s = harness.socket;
			if (!s) throw new Error("hotspot harness socket is not connected");
			const id = `emit-${++harness._seq}`;
			// dev.emit sends the broadcast before its reply on this same socket.
			return new Promise<void>((resolve, reject) => {
				const onMessage = (event: MessageEvent<string>) => {
					const receipt = parseRecord(event.data);
					if (receipt?.id !== id) return;
					clearTimeout(timeout);
					s.removeEventListener("message", onMessage);
					if (receipt.error || !isRecord(receipt.result) || receipt.result.success !== true) {
						reject(new Error(`dev.emit ${id} failed: ${event.data}`));
					} else {
						resolve();
					}
				};
				const timeout = setTimeout(() => {
					s.removeEventListener("message", onMessage);
					reject(new Error(`dev.emit ${id} receipt timed out`));
				}, 10_000);
				s.addEventListener("message", onMessage);
				s.__realSend(
					JSON.stringify({
						id,
						path: ["dev", "emit"],
						input: { type, payload },
					}),
				);
			});
		},
	};

	const HOTSPOT_PATHS = new Set([
		"wifi.hotspotPrepare",
		"wifi.hotspotStart",
		"wifi.hotspotStop",
		"wifi.hotspotConfigure",
	]);

	class HookedWS extends Real {
		readonly __realSend: WebSocket["send"];

		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols);
			harness.socket = this;
			this.__realSend = Real.prototype.send.bind(this);
			this.addEventListener("message", (ev: MessageEvent<string>) => {
				const status = parseRecord(ev.data)?.status;
				if (!isRecord(status) || !isWifiSnapshot(status.wifi)) return;
				if (harness.holdStartReply && ev.isTrusted) {
					ev.stopImmediatePropagation();
					return;
				}
				harness.lastWifi = status.wifi;
			});
		}

		override send(data: Parameters<WebSocket["send"]>[0]) {
			const msg = parseRecord(data);
			if (
				!msg || typeof msg.id !== "string" || !Array.isArray(msg.path) ||
				!msg.path.every((segment: unknown) => typeof segment === "string")
			) {
				return this.__realSend(data);
			}
			const p = msg.path.join(".");

			if (p === "auth.login") {
				return this.__realSend(JSON.stringify({ ...msg, input: { token, persistent_token: true } }));
			}

			// Remember the interface key the dialog is operating on so injected
			// echoes (active snapshot / deferred config) hit the same `device`.
			if (HOTSPOT_PATHS.has(p)) {
				if (!isRecord(msg.input)) return this.__realSend(data);
				const { device, incarnation } = msg.input;
				if (
					(typeof device !== "string" && typeof device !== "number") ||
					(incarnation !== undefined && typeof incarnation !== "string")
				) {
					return this.__realSend(data);
				}
				harness.lastHotspotDevice = String(device);
				if (incarnation === undefined) delete harness.lastHotspotIncarnation;
				else harness.lastHotspotIncarnation = incarnation;
				if (p === "wifi.hotspotStart") harness.startTokens.push(incarnation);
			}

			// Resolve an armed RPC locally so the test owns the pending window.
			if (Object.hasOwn(harness._fake, p)) {
				const result = harness._fake[p];
				const id = msg.id;
				const reply = () => this.dispatchEvent(
					new MessageEvent("message", { data: JSON.stringify({ id, result }) }),
				);
				if (p === "wifi.hotspotStart" && harness.holdStartReply) {
					harness.releaseStartReply = reply;
				} else {
					setTimeout(reply, 0);
				}
				return undefined;
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
		([t, p]) => (window as HotspotTestWindow).__ceraHotspot.emit(t, p),
		[type, payload] as const,
	);
}

function armFake(page: Page, rpcPath: string, result: unknown): Promise<void> {
	return page.evaluate(
		([pth, res]) => {
			(window as HotspotTestWindow).__ceraHotspot._fake[pth] = res;
		},
		[rpcPath, result] as const,
	);
}

function lastHotspotDevice(page: Page): Promise<string | undefined> {
	return page.evaluate(() => (window as HotspotTestWindow).__ceraHotspot.lastHotspotDevice);
}

function lastHotspotIncarnation(page: Page): Promise<string | undefined> {
	return page.evaluate(() => (window as HotspotTestWindow).__ceraHotspot.lastHotspotIncarnation);
}

/** Wait until a wifi snapshot has been captured from a status broadcast. */
async function awaitWifiSnapshot(page: Page): Promise<void> {
	await expect
		.poll(() => page.evaluate(() => (window as HotspotTestWindow).__ceraHotspot.lastWifi !== null), {
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
			const harness = (window as HotspotTestWindow).__ceraHotspot;
			return harness.emit("status", { wifi: harness.lastWifi });
		});
	}
}

/** Commit the mock AP state before injecting its confirming snapshot. */
async function emitHotspotActive(page: Page, device: string, backendRpc: BackendRpc): Promise<void> {
	const { incarnation } = (await backendRpc.call<WifiStatus>(["wifi", "getStatus"]))[device] ?? {};
	const prepared = await backendRpc.call<{ success: boolean }>(
		["wifi", "hotspotPrepare"],
		{ device, incarnation, name: FORM_NAME, password: FORM_PASS },
	);
	if (!prepared.success) throw new Error("mock hotspot preparation failed");
	// Bypass the page's fake start so subsequent real status ticks keep the AP on.
	const started = await backendRpc.call<{ success: boolean }>(
		["wifi", "hotspotStart"],
		{ device, incarnation },
	);
	if (!started.success) throw new Error("mock hotspot start failed");
	await page.evaluate((dev) => {
		const harness = (window as HotspotTestWindow).__ceraHotspot;
		const wifi = {
			...harness.lastWifi,
			[dev]: {
				...(harness.lastWifi?.[dev] ?? { ifname: dev }),
				hotspot: { name: "CeraTestAP", password: "cerapass123", channel: "auto" },
			},
		};
		return harness.emit("status", { wifi });
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

/**
 * #413: a start goes through the credential gate. Waits for the device's own
 * credentials, acknowledges them and confirms.
 */
async function startThroughGate(page: Page): Promise<void> {
	await dialog(page)
		.getByRole("button", { name: "Enable Hotspot", exact: true })
		.click();
	const gate = page.locator(
		'[data-testid="hotspot-activation-confirm"][data-phase="ready"]',
	);
	await expect(gate).toBeVisible();
	await gate.getByRole("checkbox").click();
	await page.getByTestId("hotspot-confirm-activate").click();
}

/**
 * The edit form exists only for a LIVE AP (#413), so configure scenarios first
 * inject a snapshot where the dialog's adapter is broadcasting.
 */
async function makeHotspotActive(page: Page, backendRpc: BackendRpc): Promise<string> {
	await awaitWifiSnapshot(page);
	const device = await page.evaluate(() => {
		const wifi = (window as HotspotTestWindow).__ceraHotspot.lastWifi ?? {};
		return Object.keys(wifi).find((k) => wifi[k]?.supports_hotspot) ?? Object.keys(wifi)[0];
	});
	if (!device) throw new Error("No Wi-Fi row in the hotspot test snapshot");
	await emitHotspotActive(page, device, backendRpc);
	await expect(page.locator("#hotspot-name")).toBeVisible();
	return device;
}

/** Fill name + password so isFormValid is true (save is gated on it). */
async function fillValidForm(page: Page): Promise<void> {
	await page.locator("#hotspot-name").fill(FORM_NAME);
	await page.locator("#hotspot-password").fill(FORM_PASS);
	await expect(page.locator("#hotspot-name")).toHaveValue(FORM_NAME);
	await expect(page.locator("#hotspot-password")).toHaveValue(FORM_PASS);
}


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
				.waitForFunction(() => (window as HotspotTestWindow).__ceraAppMounted === true, undefined, {
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

		test("a replacement radio requires a fresh hotspot confirmation after an unobserved Start", async ({
			page,
			backendRpc,
		}) => {
			await armFake(page, "wifi.hotspotStart", {
				success: false,
				error: "radio-changed",
				reason: "current-unobserved",
			});
			await page.evaluate(() => {
				(window as HotspotTestWindow).__ceraHotspot.holdStartReply = true;
			});
			await startThroughGate(page);
			await expect(
				dialog(page).getByRole("button", { name: "Enable Hotspot", exact: true }),
			).toBeDisabled();

			const device = await lastHotspotDevice(page);
			const incarnation = await lastHotspotIncarnation(page);
			if (!device || !incarnation) throw new Error("Start did not capture its radio");
			await backendRpc.call(["dev", "rebindWifi"], { device });
			const wifi = await backendRpc.call<WifiStatus>(["wifi", "getStatus"]);
			const replacement = wifi[device]?.incarnation;
			expect(replacement).toBeTruthy();
			expect(replacement).not.toBe(incarnation);
			await page.evaluate(async (status) => {
				const { releaseStartReply, socket } = (window as HotspotTestWindow).__ceraHotspot;
				if (!releaseStartReply || !socket) throw new Error("Expected a held Start reply");
				releaseStartReply();
				// Give the refusal's promise continuations a turn to register for
				// status before delivering the only Wi-Fi frame this test allows.
				await new Promise<void>((resolve) => {
					setTimeout(() => {
						socket.dispatchEvent(new MessageEvent("message", {
							data: JSON.stringify({ status: { wifi: status } }),
						}));
						resolve();
					}, 0);
				});
			}, wifi);

			const gate = dialog(page).getByTestId("hotspot-activation-confirm");
			await expect(gate.getByTestId("hotspot-confirm-radio-changed")).toBeVisible();
			await expect(gate.getByTestId("hotspot-confirm-name")).toBeVisible();
			await expect(gate.getByRole("checkbox")).not.toBeChecked();
			await expect(gate.getByTestId("hotspot-confirm-activate")).toBeDisabled();
			expect(await page.evaluate(() => (window as HotspotTestWindow).__ceraHotspot.startTokens)).toEqual([incarnation]);
		});

		// ── Scenario 1: hotspot start pending survives periodic status ticks ──────
		test("hotspot start pending survives periodic status ticks without flipping the label", async ({
			page,
			backendRpc,
		}) => {
			record("── hotspot start: clobber-resist + confirm ──");
			await armFake(page, "wifi.hotspotStart", { success: true });

			const enable = dialog(page).getByRole("button", {
				name: "Enable Hotspot",
				exact: true,
			});
			await expect(enable).toBeEnabled();
			await startThroughGate(page);

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
			await emitHotspotActive(page, device as string, backendRpc);
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
			backendRpc,
		}) => {
			record("── hotspot configure: deferred success ──");
			await makeHotspotActive(page, backendRpc);
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
				hotspot: { config: { device, incarnation: await lastHotspotIncarnation(page), success: true } },
			});
			await expect(saveSettled).toBeEnabled();
			await expect(dialog(page)).toBeVisible();
			record(`emitted hotspot.config {device:${device},success:true} → confirmed, Save re-enabled ✓`);
		});

		// ── Scenario 3: deferred hotspot.config ERROR calmly re-enables save ──────
		test("hotspot configure deferred hotspot.config error calmly re-enables save with the form intact", async ({
			page,
			backendRpc,
		}) => {
			record("── hotspot configure: deferred error ──");
			await makeHotspotActive(page, backendRpc);
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
				hotspot: { config: { device, incarnation: await lastHotspotIncarnation(page), success: false, error: "mock_config_error" } },
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
