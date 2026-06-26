import fs from "node:fs";

import { expect, type Page, test } from "./fixtures/index.js";

import { ensureAuthenticated, evidencePath, navigateTo } from "./helpers";

/**
 * T13 — Modem config surface clobber regressions (ceraui-os-interaction-ux), @functional.
 *
 * Drives the REAL ModemConfigDialog against the dev backend with DOM/ARIA-only
 * assertions (no screenshots). Three regressions are pinned, all turning on the
 * pure predicates from T10/T11 (`modemScanSignature`, `modemConfigEchoMatches`):
 *
 *   1. scan false-confirm: a periodic full-state re-broadcast that RE-SENDS the
 *      same operator set must NOT confirm an in-flight scan (the spinner holds);
 *      only a genuinely changed operator set confirms it.
 *   2. configure clobber: a Save in flight stays pending while a non-matching
 *      `modems` re-broadcast ticks — only an echo that proves the device stored
 *      what we sent closes the dialog.
 *   3. configure DEVICE_BUSY: a busy result raises a calm busy toast and re-opens
 *      the form for retry.
 *
 * Determinism comes from the same WS harness the sibling specs use (modem-scan /
 * sim-pin-unlock / field-lock): the modem state is injected via `dev.emit` and
 * the scan/configure RPCs are dropped + faked so their pending window is owned by
 * the test, never released by a real backend confirm. No fixed-delay waits.
 *
 * Prereq (playwright.config webServer): frontend :6173 + backend :3002 with
 * NODE_ENV=development and MOCK_SCENARIO=multi-modem-wifi.
 */

const BUSY_TEXT = "Device is busy, try again in a moment";
const TYPED_APN = "internet.e2e.test";

// Drive a NON-first modem so the sibling modem-scan.spec (which only ever scans /
// configures the first modem, broadcasting modem 0 to every page over the shared
// dev backend) can never perturb this spec's modem under parallel execution.
const MODEM_INDEX = 1;

function installWsHarness(): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__cera) return;
	const Real = w.WebSocket;

	w.__cera = {
		socket: null,
		lastModems: null as null | Record<string, unknown>,
		// Map<path, result>. A modem RPC whose path is present is dropped and its
		// promise resolved locally with the given result, so the op's pending
		// window is owned by the test (no real backend mutation / broadcast).
		_rpcFake: {} as Record<string, unknown>,
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
					const modems = o?.modems ?? o?.status?.modems;
					if (modems && typeof modems === "object") {
						w.__cera.lastModems = modems;
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
				if (p && Object.prototype.hasOwnProperty.call(w.__cera._rpcFake, p)) {
					const result = w.__cera._rpcFake[p];
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
}

function emit(page: Page, type: string, payload: unknown): Promise<void> {
	return page.evaluate(
		([t, p]) => (window as any).__cera.emit(t, p),
		[type, payload] as const,
	);
}

function armFake(page: Page, path: string, result: unknown): Promise<void> {
	return page.evaluate(
		([pth, res]) => {
			(window as any).__cera._rpcFake[pth] = res;
		},
		[path, result] as const,
	);
}

function targetModemKey(page: Page): Promise<string> {
	return page.evaluate((index) => {
		const m = (window as any).__cera.lastModems;
		const keys = m ? Object.keys(m) : [];
		const key = keys[index];
		if (!key) throw new Error(`no modem at index ${index} to patch`);
		return key;
	}, MODEM_INDEX);
}

function openTargetModemDialog(page: Page): Promise<void> {
	return page
		.getByTestId("open-modem-config-dialog")
		.nth(MODEM_INDEX)
		.click();
}

/**
 * Clone the live modem `key`, deep-merge `patch` (config/network_type merged
 * sub-object, everything else replaced), and re-broadcast it. Mirrors the
 * field-by-field `mergeModemList` ingestion so only the named fields change.
 */
function patchModem(
	page: Page,
	key: string,
	patch: Record<string, unknown>,
): Promise<void> {
	return page.evaluate(
		([k, p]) => {
			const w = window as any;
			const modems = w.__cera.lastModems;
			if (!modems?.[k]) throw new Error("no modem snapshot to patch");
			const clone = JSON.parse(JSON.stringify(modems[k]));
			for (const topKey of Object.keys(p)) {
				if (topKey === "config" || topKey === "network_type") {
					clone[topKey] = { ...(clone[topKey] ?? {}), ...(p as any)[topKey] };
				} else {
					clone[topKey] = (p as any)[topKey];
				}
			}
			w.__cera.emit("modems", { [k]: clone });
		},
		[key, patch] as const,
	);
}

function availableOperatorCount(page: Page): Promise<number> {
	return page.evaluate(() => {
		const m = (window as any).__cera.lastModems;
		if (!m) return 0;
		let n = 0;
		for (const k of Object.keys(m)) {
			const nets = m[k]?.available_networks ?? {};
			for (const code of Object.keys(nets)) {
				if (nets[code]?.availability === "available") n++;
			}
		}
		return n;
	});
}


test.describe(
	"modem config surface — scan false-confirm + configure clobber regressions",
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
							const m = (window as any).__cera.lastModems;
							return m ? Object.keys(m).length : 0;
						}),
					{ timeout: 15000, message: "modem snapshot should arrive" },
				)
				.toBeGreaterThan(0);
		});

		test.afterAll(async () => {
			fs.writeFileSync(
				evidencePath("task-13-modem-config-surface.txt"),
				[
					"T13 — Modem config surface clobber regressions: functional E2E evidence",
					"Driver: real ModemConfigDialog (async-operation store + modemScanSignature",
					"        / modemConfigEchoMatches predicates) vs. real dev backend; modem",
					"        state injected via dev.emit, scan/configure pinned via drop+fake.",
					`Generated: ${new Date().toISOString()}`,
					"",
					...evidence,
					"",
				].join("\n"),
				"utf8",
			);
		});

		test("a modem scan holds pending across same-list re-broadcasts and only a changed operator set confirms it", async ({
			page,
		}) => {
			record("── modem scan: false-confirm + clobber resistance ──");
			const key = await targetModemKey(page);

			// Roaming on (so the scan UI shows) + a baseline operator set captured
			// as the scan signature when the scan is dispatched.
			await patchModem(page, key, {
				config: { roaming: true },
				available_networks: {
					"310260": { name: "T-Mobile", availability: "available" },
				},
			});

			await openTargetModemDialog(page);
			const dialog = page.getByRole("dialog");
			await expect(dialog).toBeVisible();

			const scan = dialog.getByTestId("modem-scan-button");
			await expect(scan).toBeEnabled();

			// Drop+fake the scan so the backend never broadcasts a real operator set.
			await armFake(page, "modems.scan", { success: true });
			await scan.click();
			await expect(scan).toBeDisabled();
			record("clicked Scan → op pending (scan button disabled)");

			// Same-list re-broadcasts (the periodic full-state tick): the operator
			// signature is unchanged, so the scan must NOT confirm — it stays pending.
			for (let i = 0; i < 3; i++) {
				await patchModem(page, key, {
					available_networks: {
						"310260": { name: "T-Mobile", availability: "available" },
					},
				});
			}
			await expect(scan).toBeDisabled();
			expect(await availableOperatorCount(page)).toBe(1);
			record(
				"injected 3 same-list re-broadcasts → scan STILL pending (no false-confirm) ✓",
			);

			// A genuinely changed operator set (a new operator) flips the signature
			// and confirms the scan: the spinner clears, the button re-enables.
			await patchModem(page, key, {
				available_networks: {
					"310260": { name: "T-Mobile", availability: "available" },
					"310410": { name: "AT&T", availability: "available" },
				},
			});
			await expect(scan).toBeEnabled();
			await expect(dialog).toBeVisible();
			record(
				"injected a changed operator set (added 310410) → scan confirmed, button re-enabled ✓",
			);
		});

		test("a configure Save in flight survives a non-matching modem re-broadcast and only the echo confirm closes it", async ({
			page,
		}) => {
			record("── modem configure: clobber resistance + echo confirm ──");
			const key = await targetModemKey(page);

			// Known manual baseline (empty APN) so the dialog seeds a deterministic
			// form and the echo predicate has clear sent-vs-stored fields.
			await patchModem(page, key, {
				config: {
					autoconfig: false,
					apn: "",
					username: "",
					password: "",
					roaming: false,
					network: "",
				},
			});

			await openTargetModemDialog(page);
			const dialog = page.getByRole("dialog");
			await expect(dialog).toBeVisible();

			const apn = dialog.locator("#modem-apn");
			await expect(apn).toBeVisible();
			await apn.fill(TYPED_APN);
			await expect(apn).toHaveValue(TYPED_APN);

			const save = dialog.getByRole("button", { name: "Save" });
			await expect(save).toBeEnabled();

			// Drop+fake the configure so the op stays pending with no backend echo.
			await armFake(page, "modems.configure", { success: true });
			await save.click();
			await expect(save).toBeDisabled();
			await expect(dialog).toBeVisible();
			record("clicked Save → op pending (Save shows loading, dialog open)");

			// Non-matching re-broadcasts (stored APN still empty ≠ what we sent) must
			// NOT confirm: the configure stays pending and the dialog stays open.
			for (let i = 0; i < 3; i++) {
				await patchModem(page, key, {
					config: {
						autoconfig: false,
						apn: "",
						username: "",
						password: "",
						roaming: false,
						network: "",
					},
				});
			}
			await expect(dialog).toBeVisible();
			await expect(save).toBeDisabled();
			record(
				"injected 3 non-matching modem re-broadcasts → Save STILL pending, dialog OPEN (no clobber) ✓",
			);

			// The echo that proves the device stored what we sent confirms + closes.
			await patchModem(page, key, {
				config: {
					autoconfig: false,
					apn: TYPED_APN,
					username: "",
					password: "",
					roaming: false,
					network: "",
				},
			});
			await expect(dialog).toBeHidden();
			record(
				`injected a matching echo (stored apn="${TYPED_APN}") → configure confirmed, dialog closed ✓`,
			);
		});

		test("a configure DEVICE_BUSY result raises a calm busy toast and re-enables the modem Save button", async ({
			page,
		}) => {
			record("── modem configure: DEVICE_BUSY ──");
			const key = await targetModemKey(page);

			await patchModem(page, key, {
				config: {
					autoconfig: false,
					apn: "",
					username: "",
					password: "",
					roaming: false,
					network: "",
				},
			});

			await openTargetModemDialog(page);
			const dialog = page.getByRole("dialog");
			await expect(dialog).toBeVisible();

			const apn = dialog.locator("#modem-apn");
			await apn.fill(TYPED_APN);
			await expect(apn).toHaveValue(TYPED_APN);

			const save = dialog.getByRole("button", { name: "Save" });
			await expect(save).toBeEnabled();

			await armFake(page, "modems.configure", {
				success: false,
				error: "DEVICE_BUSY",
			});
			await save.click();

			await expect(page.getByText(BUSY_TEXT)).toBeVisible();
			record("Save → DEVICE_BUSY → calm busy toast ✓");

			await expect(save).toBeEnabled();
			await expect(dialog).toBeVisible();
			record("op failed out of pending → Save re-enabled, dialog stays open ✓");
		});
	},
);
