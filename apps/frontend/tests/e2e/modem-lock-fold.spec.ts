import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";
import {
	expectContained,
	expectReachableWithoutScrolling,
	KIOSK_VIEWPORT,
	probeContainment,
	probeFold,
	settleDestination,
} from "./helpers/modem-containment.js";

/**
 * A LOCKED DONGLE OPENS ON ITS LOGIN — @functional, at the shipped kiosk size.
 *
 * Todo 35's F4. At all three mandatory widths the credential section sat at or
 * past the fold, and on the 1024x600 kiosk the "Dongle login" heading itself was
 * clipped: an operator arrived at a Connection card reading "its network
 * settings live in its own web interface, not here" and had to scroll past two
 * more blocks to find the password field. `locked-out` was worse, because the
 * wait IS that state's entire payload and was fully off-screen.
 *
 * NO EXISTING GATE COULD SEE IT, and that is the reason this spec exists rather
 * than an assertion bolted onto one of the others. `probeContainment` measures
 * the horizontal §4/§5 contract and `probeDialogOverflow` asks whether content
 * escapes the dialog BOX; neither asks whether a surface's primary action is on
 * screen when the operator arrives. `probeFold` is that missing measurement, and
 * it lives in the SAME shared helper for the reason pass 3 gave: a containment
 * rule that exists twice can disagree with itself.
 *
 * The kiosk is the width that matters. Todo 36 drives this exact surface against
 * a real ZTE MF79U on the shipped panel, and a password field below the fold
 * makes that drill unusable rather than merely awkward.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE ROSTER IS INJECTED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * No bench dongle and no mock scenario can produce a locked device — every
 * dialect answers unauthenticated, so `open` is the only state hardware has ever
 * exercised. The page socket is proxied and an authoritative roster pushed
 * instead, in the same shape `modem-credential-unlock.spec.ts` and
 * `modem-pass4.visual.spec.ts` push theirs.
 */

const DONGLE_ID = "dongle-fold";

let pageWs: WebSocketRoute | null = null;

function send(payload: unknown): void {
	pageWs?.send(JSON.stringify(payload));
}

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

type WireLockState = "locked" | "auth-failed" | "locked-out";

/**
 * The bench HiLink in a state that withholds its own capability and control
 * blocks — which is what makes the login the only thing on this surface an
 * operator can act on.
 */
function dongle(
	lock: WireLockState,
	options: { lockoutUntil?: number } = {},
): Record<string, unknown> {
	return {
		ifname: "enx0c5b8f279a64",
		name: "Huawei E3372",
		network_type: { supported: [], active: null },
		device_class: "router-ethernet",
		availability_reason: "router_direct",
		slot_label: "Dongle 1",
		lock_state: lock,
		lock_detail: {
			credential_configured: lock !== "locked",
			...(options.lockoutUntil === undefined
				? {}
				: { lockout_until: options.lockoutUntil }),
		},
		router_admin: {
			admin_url: "http://192.168.8.1",
			reachable: true,
			model: "E3372",
		},
	};
}

function sendRoster(entry: Record<string, unknown>): void {
	send({
		status: { cellular_initializing: false, modems: { [DONGLE_ID]: entry } },
	});
}

async function openDongleDialog(page: Page): Promise<void> {
	const row = page.locator(`[data-modem-id=${JSON.stringify(DONGLE_ID)}]`);
	await expect(row).toBeVisible({ timeout: 15_000 });
	await row.getByTestId("open-modem-config-dialog").click();
	await expect(page.getByRole("dialog").first()).toBeVisible();
}

/**
 * What the operator must be able to see and act on, per state.
 *
 * `dongle-lock` is the whole card, so requiring it in full is what encodes "the
 * heading is not clipped mid-glyph" — the F4 symptom a visibility check walks
 * straight through.
 */
const PAYLOAD: Record<WireLockState, readonly string[]> = {
	locked: [
		"dongle-lock",
		"dongle-lock-message",
		"dongle-lock-password",
		"dongle-lock-submit",
	],
	"auth-failed": [
		"dongle-lock",
		"dongle-lock-message",
		"dongle-lock-password",
		"dongle-lock-submit",
	],
	// The wait is this state's ENTIRE payload; there is deliberately no entry and
	// no retry, so nothing else on screen would tell the operator what to do.
	"locked-out": ["dongle-lock", "dongle-lock-message", "dongle-lock-wait"],
};

test.describe(
	"a locked dongle opens on its login at the 1024x600 kiosk",
	{ tag: "@functional" },
	() => {
		test.skip(
			({ browserName }) => browserName !== "chromium",
			"single-browser layout proof",
		);

		test.beforeEach(async ({ page }, testInfo) => {
			test.skip(
				testInfo.project.name !== "desktop",
				"the leg drives its own kiosk viewport; run once",
			);
			pageWs = null;

			await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
				pageWs = ws;
				const server = ws.connectToServer();

				ws.onMessage((message) => {
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

			// `data-layout-mode` must be set BEFORE first paint: applying it after
			// load measures the pre-lift geometry, and the 44px touch targets are
			// part of what has to fit.
			await page.setViewportSize(KIOSK_VIEWPORT);
			await page.goto("/?mode=touch");
			await ensureAuthenticated(page);
			await expect(page.locator("html")).toHaveAttribute(
				"data-layout-mode",
				"touch",
			);
			await navigateTo(page, "network");
			serverConfig();
		});

		for (const state of ["locked", "auth-failed", "locked-out"] as const) {
			test(`\`${state}\` is reachable without scrolling`, async ({ page }) => {
				sendRoster(
					dongle(
						state,
						state === "locked-out"
							? { lockoutUntil: Date.now() + 300_000 }
							: {},
					),
				);
				await openDongleDialog(page);
				await expect(page.getByTestId("dongle-lock-body")).toHaveAttribute(
					"data-lock-state",
					state,
				);

				const label = `${state} @ ${KIOSK_VIEWPORT.width}x${KIOSK_VIEWPORT.height}`;

				// The horizontal contract still holds — this leg strengthens the
				// measurement, it does not trade one axis for the other.
				expectContained(await probeContainment(page), label);

				expectReachableWithoutScrolling(
					await probeFold(page, PAYLOAD[state]),
					label,
				);
			});
		}

		test("NON-VACUITY — the probe really does report content below the fold", async ({
			page,
		}) => {
			// Without this, an empty `offscreen` above could equally mean the probe
			// measures nothing at all. The prohibition list is the LAST block in the
			// dialog and cannot fit a 600px-tall screen alongside everything above
			// it, so it must be reported — and the login above it must not.
			sendRoster(dongle("locked"));
			await openDongleDialog(page);
			await settleDestination(page);

			const report = await probeFold(page, [
				"dongle-lock-password",
				"dongle-unavailable-operations",
			]);
			expect(report.missing).toEqual([]);
			expect(report.preScrolled).toEqual([]);
			expect(report.offscreen.join(" ")).toContain(
				"dongle-unavailable-operations",
			);
			expect(report.offscreen.join(" ")).not.toContain("dongle-lock-password");
		});

		test("NON-VACUITY — a scrolled surface is refused, not silently measured", async ({
			page,
		}) => {
			// Rule 1 of the probe: "reachable without scrolling" is only measured if
			// nothing scrolled first. A guard nobody can prove fires is a guard
			// nobody should trust.
			sendRoster(dongle("locked"));
			await openDongleDialog(page);
			await settleDestination(page);

			const scrolled = await page.evaluate(() => {
				const el = document.querySelector<HTMLElement>(
					'[data-testid="dongle-lock"]',
				);
				for (
					let node: HTMLElement | null = el?.parentElement ?? null;
					node !== null;
					node = node.parentElement
				) {
					const style = getComputedStyle(node);
					if (!/auto|scroll/.test(`${style.overflowY} ${style.overflow}`)) {
						continue;
					}
					if (node.scrollHeight <= node.clientHeight + 1) continue;
					node.scrollTop = 120;
					return node.scrollTop > 1;
				}
				return false;
			});
			// A dialog with more content than screen and NO scroll container would
			// put that content permanently out of reach, which is a worse finding
			// than the one this spec was written for.
			expect(
				scrolled,
				"the dongle dialog exposed no scrollable ancestor to scroll",
			).toBe(true);

			const report = await probeFold(page, ["dongle-lock-password"]);
			expect(report.preScrolled.length).toBeGreaterThan(0);
		});
	},
);
