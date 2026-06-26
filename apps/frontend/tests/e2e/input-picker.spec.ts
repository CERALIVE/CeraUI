import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "./fixtures/index.js";

import { navigateTo } from "./helpers";

/**
 * Task 34 — Hotplug-aware input picker + live switch, end-to-end.
 *
 * Drives the REAL frontend picker (cerastream mode via the localStorage engine
 * override) against the REAL dev backend's v4l2 device discovery, using a REAL
 * `modprobe v4l2loopback` to plug/unplug a capture device mid-session:
 *   1. plug QA-Cam → it appears in the picker live (no refresh),
 *   2. live-switch to it → a "Switched in <gap>ms" toast with gap ≤ 67ms,
 *   3. unplug a source then switch to it → a typed SOURCE_LOST toast.
 *
 * The WebSocket harness (addInitScript) authenticates via a persistent token and
 * forces cerastream mode for the picker conditional, mirroring field-lock.spec.
 * v4l2loopback needs privilege; without passwordless sudo the suite self-skips.
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
		throw new Error(`No persistent auth tokens in ${tokensPath}`);
	}
	return tokens[0] as string;
})();

function hasLoopback(): boolean {
	try {
		execSync("modinfo v4l2loopback", { stdio: "pipe" });
		execSync("sudo -n true", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function modprobe(args: string): void {
	execSync(`sudo -n modprobe v4l2loopback ${args}`, { stdio: "pipe" });
}

function rmmod(): void {
	try {
		execSync("sudo -n rmmod v4l2loopback", { stdio: "pipe" });
	} catch {
		/* not loaded */
	}
}

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
		localStorage.setItem("engine", "cerastream");
	} catch {
		/* storage unavailable */
	}
}

function emit(page: Page, type: string, payload: unknown): Promise<void> {
	return page.evaluate(
		([t, p]) => (window as { __cera: { emit: (t: string, p: unknown) => void } }).__cera.emit(t, p),
		[type, payload] as const,
	);
}

function picker(page: Page) {
	return page.locator('[data-testid="input-picker"]');
}

function deviceRow(page: Page, name: string) {
	return picker(page).locator("[data-input-id]", { hasText: name });
}

test.describe.configure({ mode: "serial" });

test.describe("hotplug input picker + live switch (Task 34)", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser hardware integration proof",
	);
	test.skip(!hasLoopback(), "v4l2loopback + passwordless sudo required");

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the picker",
		);
		rmmod();
		await page.addInitScript(installWsHarness, TOKEN);
		await page.goto("/");
		await navigateTo(page, "live");
		// Force the streaming UI so the picker exposes its live "Switch" controls
		// (the mock scenario never re-broadcasts is_streaming, so this sticks).
		await expect
			.poll(
				async () => {
					await emit(page, "status", { is_streaming: true });
					return picker(page)
						.isVisible()
						.catch(() => false);
				},
				{ timeout: 10_000, message: "input picker should mount while streaming" },
			)
			.toBe(true);
	});

	test.afterEach(() => {
		rmmod();
	});

	test("a plugged device appears live and live-switches within ≤67ms", async ({
		page,
	}) => {
		modprobe("video_nr=63 card_label=QA-Cam exclusive_caps=1");

		const row = deviceRow(page, "QA-Cam");
		await expect(row).toBeVisible({ timeout: 8000 });

		await row.locator("[data-switch-input]").click();

		const toast = page.getByText(/switched in \d+\s*ms/i);
		await expect(toast).toBeVisible({ timeout: 8000 });
		const text = (await toast.textContent()) ?? "";
		const gap = Number(text.match(/(\d+)\s*ms/i)?.[1]);
		expect(Number.isFinite(gap)).toBe(true);
		expect(gap).toBeLessThanOrEqual(67);

		// The picker keeps moving — switched device is now marked Active.
		await expect(deviceRow(page, "QA-Cam")).toHaveAttribute(
			"data-active",
			"true",
		);
	});

	test("switching to a just-unplugged device shows a disabled entry + SOURCE_LOST toast", async ({
		page,
	}) => {
		modprobe("video_nr=62 card_label=QA-Lost exclusive_caps=1");
		const row = deviceRow(page, "QA-Lost");
		await expect(row).toBeVisible({ timeout: 8000 });

		// Unplug it mid-session → the entry is retained but marked lost/disabled.
		rmmod();
		await expect(deviceRow(page, "QA-Lost")).toHaveAttribute(
			"data-lost",
			"true",
			{ timeout: 8000 },
		);

		await deviceRow(page, "QA-Lost").locator("[data-switch-input]").click();
		await expect(page.getByText(/source unavailable/i)).toBeVisible({
			timeout: 8000,
		});
	});
});
