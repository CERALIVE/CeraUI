import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { evidencePath, navigateTo } from "./helpers";

/**
 * Task 25 (DC-2) — On-Device Display settings surface, end-to-end.
 *
 * Proves the kiosk settings surface (`src/main/settings/OnDeviceDisplaySection.svelte`
 * + the `kiosk` broadcast handler in `subscriptions.svelte.ts`) against the REAL
 * rendered app: the live DC-2 state is read from the backend `kiosk` broadcast,
 * not just the on/off toggle. All five states are driven deterministically by
 * injecting `kiosk` broadcasts via the dev-only `dev.emit` channel (same harness
 * pattern as field-lock.spec.ts), so the proof needs no real cage/Chromium.
 *
 * Two contract guarantees are asserted explicitly:
 *   - all five states (`disabled` / `enabled-stopped` / `enabled-running` /
 *     `enabled-failed` / `failed-no-display`) surface with the right label;
 *   - a failed unit NEVER reads as "running" (the indicator reflects the live
 *     `state`, and after crash-loop auto-disable the toggle snaps Off).
 *
 * The dialog is opened, never auto-enabled — the surface only reads
 * kioskStatus() on open and reacts to broadcasts, so a headless unit stays
 * `disabled` by default (DC-2).
 */

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

/** Minimal browser-side WS harness: token auth + a dev.emit bridge. */
function installWsHarness(token: string): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__cera) return;
	const Real = w.WebSocket;

	w.__cera = {
		socket: null,
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

function emit(page: Page, type: string, payload: unknown): Promise<void> {
	return page.evaluate(
		([t, p]) => (window as any).__cera.emit(t, p),
		[type, payload] as const,
	);
}

type KioskState =
	| "disabled"
	| "enabled-stopped"
	| "enabled-running"
	| "enabled-failed"
	| "failed-no-display";

/** Build a full kiosk broadcast payload for a given state. */
function kioskStatus(state: KioskState, enabled: boolean) {
	return {
		enabled,
		state,
		display: "lcd",
		touch: true,
		motion: true,
		performance: "balanced",
	};
}

// Expected labels, mirroring packages/i18n/src/en/index.ts settings.onDeviceDisplay.states.
const STATE_LABELS: Record<KioskState, string> = {
	disabled: "Disabled",
	"enabled-stopped": "Starting\u2026",
	"enabled-running": "Running",
	"enabled-failed": "Crashed, auto-disabled",
	"failed-no-display": "No display detected",
};

async function openDisplayDialog(page: Page): Promise<void> {
	await navigateTo(page, "settings");
	await page.getByRole("button", { name: "On-Device Display" }).click();
	await expect(
		page.getByRole("dialog", { name: "On-Device Display" }),
	).toBeVisible();
}

// Serial: `dev.emit('kiosk', …)` broadcasts to ALL connected clients, so two
// pages running in parallel would cross-contaminate each other's injected
// state. Serial mode opens/closes one page at a time against a clean backend.
test.describe.configure({ mode: "serial" });

test.describe("On-Device Display settings surface (DC-2)", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-engine contract proof (cage/Chromium parity)",
	);

	test.beforeEach(async ({ page }) => {
		await page.addInitScript(installWsHarness, TOKEN);
		await page.goto("/");
	});

	test("all five DC-2 states surface with correct labels", async ({
		page,
	}, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "run once, on desktop");

		await openDisplayDialog(page);

		const indicator = page.getByTestId("kiosk-state");
		const label = page.getByTestId("kiosk-state-label");
		const toggle = page.getByTestId("kiosk-enable-switch");

		// The surface never auto-enables: the default headless state is disabled.
		await expect(indicator).toHaveAttribute("data-kiosk-state", "disabled");
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		const observed: string[] = [];
		const order: Array<{ state: KioskState; enabled: boolean }> = [
			{ state: "disabled", enabled: false },
			{ state: "enabled-stopped", enabled: true },
			{ state: "enabled-running", enabled: true },
			{ state: "failed-no-display", enabled: true },
			// Crash-loop auto-disable (T5): toggle snaps Off even though state is failed.
			{ state: "enabled-failed", enabled: false },
		];

		for (const { state, enabled } of order) {
			await emit(page, "kiosk", kioskStatus(state, enabled));
			await expect(indicator).toHaveAttribute("data-kiosk-state", state);
			await expect(label).toHaveText(STATE_LABELS[state]);
			observed.push(`${state} → "${STATE_LABELS[state]}" (toggle=${enabled})`);
		}

		fs.writeFileSync(
			evidencePath("task-25-settings.txt"),
			[
				"Task 25 (DC-2) — On-Device Display settings surface",
				"",
				"Driver: real frontend (OnDeviceDisplaySection + kiosk broadcast handler)",
				"        vs. real dev backend, kiosk states injected via dev.emit.",
				`viewport: ${JSON.stringify(testInfo.project.use.viewport)}`,
				"",
				"Live DC-2 state indicator — all five states observed:",
				...observed.map((line) => `  ${line}`),
				"",
				"Default on open: disabled (no auto-enable — headless stays default).",
				"",
				"RESULT: PASS",
				`generated: ${new Date().toISOString()}`,
				"",
			].join("\n"),
			"utf8",
		);
	});

	test("failed states never read as running; auto-disable snaps toggle Off", async ({
		page,
	}, testInfo) => {
		test.skip(testInfo.project.name !== "desktop", "run once, on desktop");

		await openDisplayDialog(page);

		const indicator = page.getByTestId("kiosk-state");
		const label = page.getByTestId("kiosk-state-label");
		const toggle = page.getByTestId("kiosk-enable-switch");

		// failed-no-display: toggle stays On, indicator amber, NOT running.
		await emit(page, "kiosk", kioskStatus("failed-no-display", true));
		await expect(indicator).toHaveAttribute(
			"data-kiosk-state",
			"failed-no-display",
		);
		await expect(label).toHaveText(STATE_LABELS["failed-no-display"]);
		await expect(label).not.toHaveText(STATE_LABELS["enabled-running"]);
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		// enabled-failed (crash-loop auto-disable T5): toggle Off, NOT running.
		await emit(page, "kiosk", kioskStatus("enabled-failed", false));
		await expect(indicator).toHaveAttribute(
			"data-kiosk-state",
			"enabled-failed",
		);
		await expect(label).toHaveText(STATE_LABELS["enabled-failed"]);
		await expect(label).not.toHaveText(STATE_LABELS["enabled-running"]);
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		fs.writeFileSync(
			evidencePath("task-25-failed.txt"),
			[
				"Task 25 (DC-2) — failure-state surfacing",
				"",
				"Proves the indicator reflects the live `state`, never painting a",
				"failed unit as Running, and that crash-loop auto-disable (T5) snaps",
				"the persisted toggle Off.",
				`viewport: ${JSON.stringify(testInfo.project.use.viewport)}`,
				"",
				"failed-no-display:",
				`  indicator label = "${STATE_LABELS["failed-no-display"]}"`,
				"  toggle = On (kiosk_enabled true; plug in a display and retry)",
				`  NOT "${STATE_LABELS["enabled-running"]}" ✓`,
				"",
				"enabled-failed (crash-loop auto-disable T5):",
				`  indicator label = "${STATE_LABELS["enabled-failed"]}"`,
				"  toggle = Off (auto-disabled — keeps the LAN browser reachable)",
				`  NOT "${STATE_LABELS["enabled-running"]}" ✓`,
				"",
				"RESULT: PASS",
				`generated: ${new Date().toISOString()}`,
				"",
			].join("\n"),
			"utf8",
		);
	});
});
