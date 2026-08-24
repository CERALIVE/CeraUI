import type { WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";

import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * THE CREDENTIAL UNLOCK, END TO END IN A REAL BROWSER — @functional.
 *
 * `locked → type the password here → unlocked → the withheld control appears`,
 * driven through the real Cellular row, the real `RouterDongleDialog` and the
 * real `ModemLockSection`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE ROSTER IS INJECTED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A locked dongle cannot be produced by any mock scenario: `lock_state` is
 * resolved by the device from a real HiLink `/api/user/state-login` read, and
 * every dialect on the bench answers unauthenticated — `open` is the ONLY state
 * hardware has ever exercised (todo 10's own honest-status note). So the page
 * socket is proxied and an authoritative roster is pushed instead, exactly as
 * `modem-ux.visual.spec.ts` pushes its own: the backend's `status`/`modems`/
 * `netif`/`config` echoes are DROPPED so the per-worker backend's three real
 * modems cannot race the assertions, and the three credential RPCs are answered
 * client-side because no dev host can produce a device that refuses a login.
 *
 * This proves the FRONTEND half end to end. The device half is pinned by
 * `apps/backend/src/tests/modem-credential-unlock.test.ts`, and the hardware
 * half is owed against a real MF79U (todo 36).
 */

const SECRET = "e2e-dongle-secret";
const DONGLE_ID = "dongle-locked";
const DONGLE_IFNAME = "enx0c5b8f279a64";

let pageWs: WebSocketRoute | null = null;
/** What the next `modems.verifyCredentials` answers. Armed per test. */
let verifyReply: Record<string, unknown> = { success: true };

function send(payload: unknown): void {
	pageWs?.send(JSON.stringify(payload));
}

/** A configured server keeps the shell out of its empty state. */
function serverConfig(): void {
	send({
		config: {
			srtla_addr: "127.0.0.1",
			srtla_port: 5000,
			srt_streamid: "e2e",
			max_br: 6000,
			pipeline: "hdmi",
		},
	});
}

/**
 * The bench HiLink, as the wire reports it in a given lock state.
 *
 * `controls` is present ONLY when the device would really serve it: the backend's
 * `gateRouterAdminByLock` withholds the capability and control blocks below
 * `open`/`unlocked`, and the whole expansion this spec proves is that they
 * arrive when the lock clears.
 */
type WireLockState = "open" | "locked" | "unlocked" | "auth-failed" | "locked-out";

function dongle(
	lock: WireLockState,
	options: { controls?: boolean; lockoutUntil?: number } = {},
): Record<string, unknown> {
	return {
		ifname: DONGLE_IFNAME,
		name: "Huawei E3372",
		network_type: { supported: [], active: null },
		device_class: "router-ethernet",
		availability_reason: "router_direct",
		slot_label: "Dongle 1",
		lock_state: lock,
		lock_detail: {
			credential_configured: lock !== "locked" && lock !== "open",
			...(options.lockoutUntil === undefined
				? {}
				: { lockout_until: options.lockoutUntil }),
		},
		router_admin: {
			admin_url: "http://192.168.8.1",
			reachable: true,
			model: "E3372",
			...(options.controls === true
				? { controls: { mobile_data: false, roaming_autoconnect: false } }
				: {}),
		},
	};
}

function sendRoster(entry: Record<string, unknown>): void {
	send({ status: { cellular_initializing: false, modems: { [DONGLE_ID]: entry } } });
}

test.describe(
	"router-dongle credential unlock — locked, entered here, expanded",
	{ tag: "@functional" },
	() => {
		test.skip(
			({ browserName }) => browserName !== "chromium",
			"single-browser integration proof",
		);

		test.beforeEach(async ({ page }, testInfo) => {
			test.skip(
				testInfo.project.name !== "desktop",
				"desktop layout drives the dongle dialog",
			);
			pageWs = null;
			verifyReply = { success: true };

			await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
				pageWs = ws;
				const server = ws.connectToServer();

				ws.onMessage((message) => {
					const text =
						typeof message === "string" ? message : message.toString();
					try {
						const frame = JSON.parse(text) as {
							id?: string | number;
							path?: unknown;
						};
						const rpc = Array.isArray(frame.path)
							? frame.path.join(".")
							: null;
						if (frame.id !== undefined && rpc !== null) {
							if (
								rpc === "modems.setCredentials" ||
								rpc === "modems.clearCredentials"
							) {
								ws.send(
									JSON.stringify({ id: frame.id, result: { success: true } }),
								);
								return;
							}
							if (rpc === "modems.verifyCredentials") {
								ws.send(JSON.stringify({ id: frame.id, result: verifyReply }));
								return;
							}
						}
					} catch {
						/* non-RPC frame */
					}
					server.send(message);
				});

				server.onMessage((message) => {
					const text =
						typeof message === "string" ? message : message.toString();
					try {
						const frame = JSON.parse(text) as object;
						// The injected roster is the only truth on screen.
						if ("status" in frame) return;
						if ("config" in frame) return;
						if ("netif" in frame) return;
						if ("modems" in frame) return;
					} catch {
						/* non-JSON / binary frame */
					}
					ws.send(message);
				});
			});

			await page.goto("/");
			await ensureAuthenticated(page);
			await navigateTo(page, "network");
			serverConfig();
		});

		test("a locked dongle is reachable, prompts here, and expands on unlock", async ({
			page,
		}) => {
			sendRoster(dongle("locked"));

			const row = page.locator(
				`[data-modem-id=${JSON.stringify(DONGLE_ID)}]`,
			);
			await expect(row).toBeVisible({ timeout: 15_000 });

			// REACHABILITY. A withheld control set is byte-identical on the wire to
			// "no write was ever proven", and reading it that way disabled the one
			// control that opens the surface carrying the login.
			const configure = row.getByTestId("open-modem-config-dialog");
			await expect(configure).toBeEnabled();
			await configure.click();

			const dialog = page.getByRole("dialog").first();
			await expect(dialog).toBeVisible();

			await expect(page.getByTestId("dongle-lock-body")).toHaveAttribute(
				"data-lock-state",
				"locked",
			);

			// Signed out, the dongle's own control block is absent — and the band
			// says WHY, rather than blaming the hardware.
			await expect(page.getByTestId("dongle-controls")).toHaveCount(0);
			await expect(page.getByTestId("dongle-no-controls")).toHaveAttribute(
				"data-locked",
				"true",
			);

			// The password is typed HERE, not on the vendor's page — which stays
			// available beside it as the secondary affordance.
			await expect(page.getByTestId("dongle-open-admin")).toBeVisible();
			const field = page.getByTestId("dongle-lock-password");
			await expect(field).toHaveAttribute("type", "password");
			await expect(page.getByTestId("dongle-lock-submit")).toBeDisabled();

			await field.fill(SECRET);
			await expect(page.getByTestId("dongle-lock-submit")).toBeEnabled();
			await page.getByTestId("dongle-lock-submit").click();

			await expect(page.getByTestId("dongle-lock-outcome")).toHaveAttribute(
				"data-outcome",
				"applied",
			);
			// Cleared the instant it was dispatched.
			await expect(field).toHaveValue("");

			// The device re-broadcasts the roster after a successful verify, and the
			// withheld control arrives through the SAME uniform section.
			sendRoster(dongle("unlocked", { controls: true }));

			await expect(page.getByTestId("dongle-lock-body")).toHaveAttribute(
				"data-lock-state",
				"unlocked",
			);
			await expect(page.getByTestId("dongle-controls")).toBeVisible();
			await expect(
				page.getByTestId("dongle-control-mobile_data"),
			).toBeVisible();
			await expect(page.getByTestId("dongle-no-controls")).toHaveCount(0);

			// The entry is gone once there is nothing left to ask for.
			await expect(page.getByTestId("dongle-lock-password")).toHaveCount(0);

			// THE CREDENTIAL REACHED THE BACKEND AND NOTHING ELSE.
			const leaks = await page.evaluate((secret) => {
				const bag = (storage: Storage): string => {
					const out: string[] = [];
					for (let i = 0; i < storage.length; i++) {
						const key = storage.key(i);
						if (key === null) continue;
						out.push(key, storage.getItem(key) ?? "");
					}
					return out.join("\u0000");
				};
				return {
					html: document.documentElement.outerHTML.includes(secret),
					local: bag(window.localStorage).includes(secret),
					session: bag(window.sessionStorage).includes(secret),
					url: window.location.href.includes(secret),
				};
			}, SECRET);
			expect(leaks).toEqual({
				html: false,
				local: false,
				session: false,
				url: false,
			});
		});

		test("a rejected password reads as `auth-failed`, and a retry is still offered", async ({
			page,
		}) => {
			verifyReply = { success: false, error: "auth_failed" };
			sendRoster(dongle("locked"));

			const row = page.locator(
				`[data-modem-id=${JSON.stringify(DONGLE_ID)}]`,
			);
			await expect(row).toBeVisible({ timeout: 15_000 });
			await row.getByTestId("open-modem-config-dialog").click();
			await expect(page.getByRole("dialog").first()).toBeVisible();

			await page.getByTestId("dongle-lock-password").fill("wrong-password");
			await page.getByTestId("dongle-lock-submit").click();

			await expect(page.getByTestId("dongle-lock-outcome")).toHaveAttribute(
				"data-outcome",
				"refused",
			);

			// The device now reports the rejection, and a retry is exactly what the
			// operator wants — the field stays.
			sendRoster(dongle("auth-failed"));
			await expect(page.getByTestId("dongle-lock-body")).toHaveAttribute(
				"data-lock-state",
				"auth-failed",
			);
			await expect(page.getByTestId("dongle-lock-password")).toBeVisible();
			await expect(page.getByTestId("dongle-lock-submit")).toBeVisible();
		});

		test("a lockout renders the wait and offers NO retry", async ({ page }) => {
			sendRoster(
				dongle("locked-out", { lockoutUntil: Date.now() + 300_000 }),
			);

			const row = page.locator(
				`[data-modem-id=${JSON.stringify(DONGLE_ID)}]`,
			);
			await expect(row).toBeVisible({ timeout: 15_000 });
			await row.getByTestId("open-modem-config-dialog").click();
			await expect(page.getByRole("dialog").first()).toBeVisible();

			await expect(page.getByTestId("dongle-lock-body")).toHaveAttribute(
				"data-lock-state",
				"locked-out",
			);
			await expect(page.getByTestId("dongle-lock-wait")).toBeVisible();

			// Every dialect counts a failed login toward a window the operator cannot
			// clear, so nothing here may spend an attempt.
			await expect(page.getByTestId("dongle-lock-password")).toHaveCount(0);
			await expect(page.getByTestId("dongle-lock-submit")).toHaveCount(0);
			await expect(page.getByTestId("dongle-lock-form")).toHaveCount(0);
			await expect(
				page.getByRole("dialog").first().locator('input[type="password"]'),
			).toHaveCount(0);
		});

		test("an `open` dongle is never prompted for a password", async ({ page }) => {
			// The COMMON case on this fleet. A prompt here is the dishonesty the
			// whole surface exists to remove.
			sendRoster(dongle("open", { controls: true }));

			const row = page.locator(
				`[data-modem-id=${JSON.stringify(DONGLE_ID)}]`,
			);
			await expect(row).toBeVisible({ timeout: 15_000 });
			await row.getByTestId("open-modem-config-dialog").click();
			const dialog = page.getByRole("dialog").first();
			await expect(dialog).toBeVisible();

			await expect(page.getByTestId("dongle-lock-body")).toHaveAttribute(
				"data-lock-state",
				"open",
			);
			await expect(page.getByTestId("dongle-lock-message")).toBeVisible();
			await expect(page.getByTestId("dongle-lock-form")).toHaveCount(0);
			await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
			// …and its own settings are served, unwithheld.
			await expect(page.getByTestId("dongle-controls")).toBeVisible();
		});
	},
);
