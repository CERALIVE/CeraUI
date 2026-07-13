import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "./fixtures/index.js";

import { evidencePath, navigateTo } from "./helpers";

/**
 * T18 — SSH / power / update surface regressions (ceraui-os-interaction-ux),
 * @functional.
 *
 * Two guarded behaviours, proven against the REAL frontend stack with NO
 * screenshots (DOM / accessibility tree only):
 *
 *   1. SSH toggle clobber — the keyed `ssh` op stays `pending` (the pure
 *      `sshToggleConfirmed` predicate) across periodic `status` re-broadcasts;
 *      the toggle never flips its label until the live `ssh.active` matches the
 *      intended target.
 *   2. Power / update blocked-result — `system.reboot` / `system.startUpdate`
 *      returning `{ success:false }` (the backend's streaming/updating guard)
 *      must surface a CALM failure and NOT proceed: the dialog stays open, the
 *      device is never marked "rebooting", and no update progress is shown.
 *
 * ── WebSocket harness (addInitScript) ────────────────────────────────────────
 * Adapted from wifi-surface.spec.ts (field-lock.spec.ts must not be modified).
 *   1. Authenticate without the device password (rewrite `auth.login` → token).
 *   2. Inject `status` echoes via `dev.emit` at known times (ssh state, updates).
 *   3. Drop+fake a `system.*` RPC so its result is fully deterministic
 *      regardless of real streaming state: `_fake[path] = result`.
 *
 * Topology: local Vite dev on :6173 uses `__ceraSocketPort`; CI prebuilt Vite
 * preview on :6173 uses the HttpOnly cookie. Both target this worker's 31xx
 * development backend.
 */

const SSH_DIALOG = "SSH Access";
const POWER_DIALOG = "Reboot / Power";
const UPDATES_DIALOG = "Software Updates";
const FAIL_TEXT = "Couldn't complete the action";

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
		// Map<path, result>. A matched RPC is dropped + resolved locally with the
		// given result, so a blocked/{success:false} outcome is deterministic.
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

	class HookedWS extends Real {
		// biome-ignore lint/suspicious/noExplicitAny: native ctor signature.
		constructor(url: string, protocols?: any) {
			super(url, protocols);
			w.__cera.socket = this;
			this.__realSend = Real.prototype.send.bind(this);
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

				// Drop+fake an armed RPC: never reaches the backend, resolved locally
				// so the dialog classifies the faked result.
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

/** Pump N periodic `status` re-broadcasts carrying the given ssh state. */
async function pumpSshTicks(page: Page, active: boolean, count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		await emit(page, "status", { ssh: { active, user: "cera" } });
	}
}

async function openSettingsDialog(page: Page, name: RegExp): Promise<void> {
	await page.locator("header").first().waitFor({ state: "visible", timeout: 30_000 });
	await navigateTo(page, "settings");
	await page.getByRole("button", { name }).first().click();
}


test.describe(
	"ssh / power / update surface — clobber + blocked-result regressions",
	{ tag: "@functional" },
	() => {
		test.skip(
			({ browserName }) => browserName !== "chromium",
			"single-browser integration proof",
		);

		test.beforeEach(async ({ page }, testInfo) => {
			test.skip(
				testInfo.project.name !== "desktop",
				"desktop layout drives the settings dialogs",
			);
			await page.addInitScript(installWsHarness, TOKEN);
			await page.goto("/");
			await page
				.waitForFunction(() => (window as any).__ceraAppMounted === true, undefined, {
					timeout: 60_000,
				})
				.catch(() => undefined);
			await page.evaluate(() => document.getElementById("js-failed")?.remove());
		});

		test.afterAll(async () => {
			const header = [
				"T18 — SSH / power / update surface regressions: functional E2E evidence",
				"Driver: real frontend (async-operation store + os-toggle-predicates +",
				"        subscriptions status routing + PowerDialog/UpdatesDialog) vs. real",
				"        dev backend; echoes via dev.emit, blocked results pinned via drop+fake.",
				`Generated: ${new Date().toISOString()}`,
				"",
			];
			fs.writeFileSync(
				evidencePath("task-18-ssh-power-update.txt"),
				[...header, ...evidence, ""].join("\n"),
				"utf8",
			);
		});

		// ── SSH toggle clobber ────────────────────────────────────────────────────
		test("ssh toggle pending survives periodic status ticks without flipping", async ({
			page,
		}) => {
			record("── ssh start: clobber-resist + confirm ──");
			await openSettingsDialog(page, /SSH Access/);
			await expect(page.getByRole("dialog", { name: SSH_DIALOG })).toBeVisible();
			const ssh = page.getByRole("dialog", { name: SSH_DIALOG });

			// Force a known inactive baseline, then drop+fake the start RPC so the op
			// stays pending with no real confirm.
			await emit(page, "status", { ssh: { active: false, user: "cera" } });
			const start = ssh.getByRole("button", { name: "Start SSH Server" });
			await expect(start).toBeEnabled();
			await armFake(page, "system.sshStart", { success: true });
			await start.click();

			// Op pending: the toggle disables and HOLDS its "Start SSH Server" label.
			await expect(start).toBeDisabled();
			record('clicked "Start SSH Server" → op pending (disabled, label held)');

			// Periodic status re-broadcasts (still inactive) must NOT flip the label
			// or drop the pending state.
			await pumpSshTicks(page, false, 4);
			await expect(
				ssh.getByRole("button", { name: "Stop SSH Server" }),
			).toHaveCount(0);
			await expect(start).toBeVisible();
			await expect(start).toBeDisabled();
			record("injected 4 periodic status ticks (active:false) → label held, still pending ✓");

			// The authoritative ssh.active=true confirms it → label flips.
			await emit(page, "status", { ssh: { active: true, user: "cera" } });
			const stop = ssh.getByRole("button", { name: "Stop SSH Server" });
			await expect(stop).toBeVisible();
			await expect(stop).toBeEnabled();
			record('emitted status {ssh.active:true} → confirmed, label "Stop SSH Server" ✓');
		});

		// ── Power reboot blocked result ───────────────────────────────────────────
		test("power reboot {success:false} keeps the dialog open without rebooting", async ({
			page,
		}) => {
			record("── power reboot blocked ──");
			await openSettingsDialog(page, /Reboot \/ Power/);
			const power = page.getByRole("dialog", { name: POWER_DIALOG });
			await expect(power).toBeVisible();

			// The backend refuses while streaming/updating → {success:false}. Pin that
			// outcome via drop+fake so the {success:false} branch is exercised directly.
			await armFake(page, "system.reboot", { success: false });
			await power.getByRole("button", { name: "Reboot", exact: true }).click();

			// Nested confirmation is the point of no return.
			const confirm = page.getByRole("dialog", { name: "Are you sure?" });
			await expect(confirm).toBeVisible();
			await confirm.getByRole("button", { name: "Reboot", exact: true }).click();

			// Calm refusal: a single failure toast, the PowerDialog stays open, and the
			// device is NEVER marked "rebooting" (no markRebooting → no close).
			await expect(page.getByText(FAIL_TEXT)).toBeVisible();
			await expect(power).toBeVisible();
			record(`reboot returned {success:false} → "${FAIL_TEXT}" toast, dialog OPEN, not rebooting ✓`);
		});

		// ── Update install blocked result ─────────────────────────────────────────
		test("update install {success:false} keeps the dialog open without progress", async ({
			page,
		}) => {
			record("── update install blocked ──");
			await openSettingsDialog(page, /Software Updates/);
			const updates = page.getByRole("dialog", { name: UPDATES_DIALOG });
			await expect(updates).toBeVisible();

			// Advertise an available update so the install action renders.
			await emit(page, "status", {
				available_updates: { package_count: 3, download_size: "12 MB" },
			});
			const install = updates.getByRole("button", { name: "Update", exact: true });
			await expect(install).toBeVisible();

			// Pin the blocked outcome and run the install through its confirmation.
			await armFake(page, "system.startUpdate", { success: false });
			await install.click();
			const confirm = page.getByRole("dialog", { name: "Are you absolutely sure?" });
			await expect(confirm).toBeVisible();
			await confirm.getByRole("button", { name: "Update", exact: true }).click();

			// Calm refusal: a single failure toast, the dialog stays open, and NO
			// "Updating" progress is shown (the start was never confirmed).
			await expect(page.getByText(FAIL_TEXT)).toBeVisible();
			await expect(updates).toBeVisible();
			await expect(updates.getByText(/Updating, please wait/)).toHaveCount(0);
			record(`startUpdate returned {success:false} → "${FAIL_TEXT}" toast, dialog OPEN, no progress ✓`);
		});
	},
);
