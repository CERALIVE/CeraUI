import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "./fixtures/index.js";

import { navigateTo } from "./helpers";

/**
 * Apply-now config change — the operator-facing half (device-quality-wave3 todo 12).
 *
 * Two guarantees are proved against the REAL rendered DOM:
 *   1. a restart-requiring edit made mid-stream ASKS before restarting, and the
 *      pre-existing "apply on next start" option is the pre-selected default;
 *   2. the typed transaction phases render, and a phase from a SUPERSEDED
 *      attempt cannot strand the applying banner on screen.
 */

const TOKEN: string | null = (() => {
	try {
		const tokensPath = path.resolve(
			import.meta.dirname,
			"../../../backend/auth_tokens.json",
		);
		const tokens = Object.keys(
			JSON.parse(fs.readFileSync(tokensPath, "utf8")) as Record<string, true>,
		);
		return tokens[0] ?? null;
	} catch {
		return null;
	}
})();

function installWsHarness(token: string): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__cera) return;
	const Real = w.WebSocket;
	w.__cera = {
		socket: null,
		injectBroadcast(payload: unknown) {
			const s = w.__cera.socket;
			if (s) {
				s.dispatchEvent(
					new MessageEvent("message", { data: JSON.stringify(payload) }),
				);
			}
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
				if (Array.isArray(msg.path) && msg.path.join(".") === "auth.login") {
					msg.input = { token, persistent_token: true };
					return this.__realSend(JSON.stringify(msg));
				}
			} catch {
				/* non-RPC frame */
			}
			return this.__realSend(data);
		}
	}
	w.WebSocket = HookedWS;
	try {
		localStorage.setItem("auth", "e2e-token-marker");
	} catch {
		/* storage unavailable */
	}
}

function inject(page: Page, payload: unknown): Promise<void> {
	return page.evaluate(
		(p) =>
			(
				window as { __cera: { injectBroadcast: (p: unknown) => void } }
			).__cera.injectBroadcast(p),
		payload,
	);
}

const SERVER_CONFIG = {
	config: {
		srtla_addr: "10.0.0.1",
		srtla_port: 5000,
		pipeline: "hdmi",
		source: "hdmi",
		resolution: "1080p",
		framerate: 30,
		max_br: 6000,
	},
};

const STREAMING = { status: { is_streaming: true, stream_lifecycle: "streaming" } };

const configChange = (
	attemptId: string,
	phase: string,
	reason?: string,
): unknown => ({
	"config-change": { attemptId, phase, ...(reason ? { reason } : {}) },
});

test.describe("apply-now config change", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser behavioural proof",
	);
	test.skip(!TOKEN, "requires a backend persistent auth token");

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the encoder dialog",
		);
		await page.addInitScript(installWsHarness, TOKEN as string);
		await page.goto("/");
		await navigateTo(page, "live");
		await inject(page, SERVER_CONFIG);
	});

	test("no timing choice is offered while idle", async ({ page }) => {
		await page.getByTestId("open-encoder-dialog").click();
		await expect(
			page.getByRole("dialog", { name: "Encoder Settings" }),
		).toBeVisible();

		// Nothing is live, so a restart interrupts nothing and no choice is asked.
		await expect(page.getByTestId("encoder-apply-choice")).toHaveCount(0);
	});

	test("a restart-requiring edit mid-stream asks, and defaults to next start", async ({
		page,
	}) => {
		// The dialog is mounted above the idle/live cockpit switch, so an operator
		// holding it open when the stream goes live is a real state — and it is the
		// state this whole flow exists for.
		await page.getByTestId("open-encoder-dialog").click();
		await expect(
			page.getByRole("dialog", { name: "Encoder Settings" }),
		).toBeVisible();
		await inject(page, STREAMING);

		// An untouched dialog asks nothing.
		await expect(page.getByTestId("encoder-apply-choice")).toHaveCount(0);

		// Change the framerate — a restart-requiring axis. WHICH rate is immaterial,
		// but it MUST be one the dialog actually offers: the ladder is
		// capability-gated, and whether the mock's device modes have reached the
		// client yet is a boot-ordering race, so the enabled set is legitimately
		// either {30, 60} or every rung. Selecting POSITIONALLY picked the disabled
		// `25` in the first case and hung for the full timeout.
		await page.locator("#encoder-framerate").click();
		const option = page
			.locator('[data-testid="framerate-option"]:not([aria-disabled="true"])')
			.filter({ hasNotText: "30" })
			.first();
		await expect(
			option,
			"the fixture must offer at least one enabled framerate other than 30",
		).toBeVisible();
		await option.click();

		// The edit actually landed — otherwise the choice below could be asserted
		// against a dialog nothing changed in.
		await expect(page.locator("#encoder-framerate")).not.toHaveText(/^30 fps$/);

		// The choice appears, and "apply on next start" is pre-selected — pressing
		// Save must never restart a live broadcast by itself.
		const choice = page.getByTestId("encoder-apply-choice");
		await expect(choice).toBeVisible();
		await expect(page.getByTestId("encoder-apply-next-start")).toBeChecked();
		await expect(page.getByTestId("encoder-apply-now")).not.toBeChecked();

		// And the apply-now option is a real, selectable alternative.
		await page.getByTestId("encoder-apply-now").check();
		await expect(page.getByTestId("encoder-apply-now")).toBeChecked();
	});

	test("typed phases render and every terminal phase clears the applying banner", async ({
		page,
	}) => {
		await inject(page, STREAMING);
		const banner = page.getByTestId("config-change-applying");
		await expect(banner).toHaveCount(0);

		// `applying` shows live progress.
		await inject(page, configChange("attempt-1", "applying"));
		await expect(banner).toBeVisible();

		// Its own terminal phase clears it — never a stuck `applying` UI.
		await inject(page, configChange("attempt-1", "applied"));
		await expect(banner).toHaveCount(0);
	});

	test("a rollback_failed escalation clears the banner rather than stranding it", async ({
		page,
	}) => {
		await inject(page, STREAMING);
		const banner = page.getByTestId("config-change-applying");

		await inject(page, configChange("attempt-2", "applying"));
		await expect(banner).toBeVisible();

		await inject(
			page,
			configChange("attempt-2", "rollback_failed", "teardown_timeout"),
		);
		await expect(banner).toHaveCount(0);
	});

	test("a terminal phase from a SUPERSEDED attempt cannot clear the live banner", async ({
		page,
	}) => {
		await inject(page, STREAMING);
		const banner = page.getByTestId("config-change-applying");

		await inject(page, configChange("attempt-3", "applying"));
		await expect(banner).toBeVisible();

		// A late outcome from an older transaction must be fenced out.
		await inject(page, configChange("attempt-OLD", "applied"));
		await expect(banner).toBeVisible();

		// The current attempt's own outcome still settles it.
		await inject(page, configChange("attempt-3", "reverted", "not_negotiated"));
		await expect(banner).toHaveCount(0);
	});
});
