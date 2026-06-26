import fs from "node:fs";

import { expect, type Page, test } from "./fixtures/index.js";

import { ensureAuthenticated, evidencePath, navigateTo } from "./helpers";

/**
 * Task 19 — modem network scan in ModemConfigDialog, end-to-end.
 *
 * Drives the REAL ModemConfigDialog against the dev backend
 * (MOCK_SCENARIO=multi-modem-wifi). The dialog's "Scan for networks" action
 * calls `modems.scan`; the backend answers the RPC immediately and streams the
 * operator list back over the `modems`/`status` broadcast (not the RPC body),
 * so the in-flight state is released when the available-network list lands.
 *
 *   • Success: scan → operators surface via the broadcast → pick one → Save
 *     sends `modems.configure` carrying the chosen operator code (proves the
 *     selection flows into the existing configure path).
 *   • Failure: `modems.scan` is dropped and answered with an error frame after a
 *     short delay so the in-flight spinner is observable; the dialog surfaces an
 *     inline error, re-enables the scan button, and stays interactive.
 *
 * The operator selector only renders while roaming is on. Roaming is enabled by
 * injecting `config.roaming = true` onto the live modems via `dev.emit` (the
 * same WebSocket-harness pattern as sim-pin-unlock.spec.ts) rather than toggling
 * the LabeledSwitch — its tooltip-wrapped control is not reliably actuated by
 * Playwright synthetic events, which is orthogonal to the scan behaviour here.
 *
 * The harness also captures the modems snapshot + the last `modems.configure`
 * input, and optionally drops `modems.scan`. No fixed-delay waits: every step
 * asserts on a stable DOM/state signal.
 */

function installWsHarness(): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__cera) return;
	const Real = w.WebSocket;

	w.__cera = {
		socket: null,
		lastModems: null as null | Record<string, unknown>,
		lastConfigure: null as null | Record<string, unknown>,
		failScan: false,
		scanFailDelay: 0,
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

				if (p === "modems.configure") {
					w.__cera.lastConfigure = msg.input;
				}

				// Drop the scan RPC + answer with an error frame so the failure
				// branch is deterministic without scan-failing hardware.
				if (p === "modems.scan" && w.__cera.failScan) {
					const id = msg.id;
					setTimeout(
						() =>
							this.dispatchEvent(
								new MessageEvent("message", {
									data: JSON.stringify({
										id,
										error: { code: "SCAN_FAILED", message: "scan failed" },
									}),
								}),
							),
						w.__cera.scanFailDelay ?? 0,
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

/**
 * Re-broadcast every live modem with `config.roaming = true` so the dialog's
 * operator selector (gated on roaming) is shown without toggling the switch.
 */
function enableRoamingOnModems(page: Page): Promise<void> {
	return page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: harness state.
		const w = window as any;
		const modems = w.__cera.lastModems;
		if (!modems) throw new Error("no modem snapshot to patch");
		const patched: Record<string, unknown> = {};
		for (const k of Object.keys(modems)) {
			const clone = JSON.parse(JSON.stringify(modems[k]));
			clone.config = clone.config ?? {};
			clone.config.roaming = true;
			patched[k] = clone;
		}
		w.__cera.emit("modems", patched);
	});
}

/** Count available operators across the latest modems broadcast. */
function availableOperatorCount(page: Page): Promise<number> {
	return page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: harness state.
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


test.describe("Modem network scan (Task 19)", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser integration proof",
	);

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the modem config dialog",
		);
		await page.addInitScript(installWsHarness);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
		// Wait until the first modem snapshot is captured by the harness.
		await expect
			.poll(
				() =>
					page.evaluate(() => {
						// biome-ignore lint/suspicious/noExplicitAny: harness state.
						const m = (window as any).__cera.lastModems;
						return m ? Object.keys(m).length : 0;
					}),
				{ timeout: 15000, message: "modem snapshot should arrive" },
			)
			.toBeGreaterThan(0);
	});

	test("scan surfaces operators, selection flows into configure", async ({
		page,
	}) => {
		await enableRoamingOnModems(page);

		await page.getByTestId("open-modem-config-dialog").first().click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();

		// Roaming is on (injected) → the scan action + operator selector show.
		const scan = dialog.getByTestId("modem-scan-button");
		await expect(scan).toBeEnabled();
		await scan.click();

		// Results land via the modems broadcast (not the RPC body).
		await expect
			.poll(() => availableOperatorCount(page), {
				timeout: 15000,
				message: "scan should surface operators via broadcast",
			})
			.toBeGreaterThan(0);

		// Open the operator selector and pick the first scanned operator.
		await dialog.getByTestId("modem-network-trigger").click();
		const option = page.getByTestId("modem-network-option").first();
		await expect(option).toBeVisible({ timeout: 15000 });
		await option.click();

		// Save → the chosen operator code flows into modems.configure.
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(dialog).toBeHidden();

		await expect
			.poll(
				() =>
					// biome-ignore lint/suspicious/noExplicitAny: harness state.
					page.evaluate(() => (window as any).__cera.lastConfigure),
				{ timeout: 10000, message: "configure RPC should fire" },
			)
			.not.toBeNull();

		const cfg = await page.evaluate(
			// biome-ignore lint/suspicious/noExplicitAny: harness state.
			() => (window as any).__cera.lastConfigure,
		);
		expect(cfg.roaming).toBe(true);
		expect(typeof cfg.network).toBe("string");
		expect(cfg.network).not.toBe("");
		expect(cfg.network).not.toBe("-1");

		fs.writeFileSync(
			evidencePath("task-19-scan.txt"),
			[
				"Task 19 — modem network scan in ModemConfigDialog: success path",
				`Generated: ${new Date().toISOString()}`,
				"",
				"Opened ModemConfigDialog for the first modem (roaming on → scan UI shown).",
				"Clicked 'Scan for networks' (data-testid=modem-scan-button) → modems.scan.",
				"Operators surfaced via the modems broadcast (available_networks) ✓",
				"Opened the operator selector and picked the first scanned operator.",
				"Clicked Save → modems.configure fired; captured input:",
				`  roaming=${cfg.roaming}, network="${cfg.network}" (operator code, not '' / '-1') ✓`,
				"Chosen network flows into the existing configure path ✓",
				"Result: PASS",
				"",
			].join("\n"),
			"utf8",
		);
	});

	test("scan failure surfaces an inline error and the dialog stays usable", async ({
		page,
	}) => {
		// Drop modems.scan and answer with an error after a short, observable delay
		// so the in-flight spinner is asserted before the failure lands.
		await page.evaluate(() => {
			// biome-ignore lint/suspicious/noExplicitAny: harness state.
			const c = (window as any).__cera;
			c.failScan = true;
			c.scanFailDelay = 600;
		});

		await enableRoamingOnModems(page);

		await page.getByTestId("open-modem-config-dialog").first().click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();

		const scan = dialog.getByTestId("modem-scan-button");
		await expect(scan).toBeEnabled();
		await scan.click();

		// In-flight: the scan button is disabled while the RPC is pending.
		await expect(scan).toBeDisabled();

		// Failure surfaces inline; the scan button becomes usable again.
		const error = dialog.getByTestId("modem-scan-error");
		await expect(error).toBeVisible();
		await expect(scan).toBeEnabled();

		// Dialog stays usable: the operator selector still opens and responds.
		await dialog.getByTestId("modem-network-trigger").click();
		await expect(page.getByRole("option").first()).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(dialog).toBeVisible();

		const errorText = (await error.textContent())?.trim() ?? "";
		fs.writeFileSync(
			evidencePath("task-19-scan-fail.txt"),
			[
				"Task 19 — modem network scan in ModemConfigDialog: failure path",
				`Generated: ${new Date().toISOString()}`,
				"",
				"Opened ModemConfigDialog (roaming on), clicked 'Scan for networks'.",
				"modems.scan dropped + answered with an error frame (600ms delay).",
				"In-flight: scan button disabled while the RPC was pending ✓",
				`Inline error surfaced: "${errorText}" (data-testid=modem-scan-error) ✓`,
				"Scan button re-enabled after failure ✓",
				"Dialog stayed usable: operator selector still opened and responded ✓",
				"Result: PASS",
				"",
			].join("\n"),
			"utf8",
		);
	});
});
