import fs from "node:fs";
import path from "node:path";

import {
	expect,
	hardwareTest,
	type BackendRpc,
	type Page,
	test,
} from "./fixtures/index.js";

import { navigateTo } from "./helpers";
import {
	HARDWARE_INPUT_PICKER_PREREQUISITE,
	hardwareInputPickerEnabled,
} from "./helpers/input-picker-hardware-config.js";
import { runRock5bInputPickerGate } from "./helpers/input-picker-hardware.js";

declare global {
	interface Window {
		__cera: {
			_seq: number;
			emit: (t: string, p: unknown) => void;
			socket: (WebSocket & { __realSend(data: string): void }) | null;
			switchResult: (inputId: string) => unknown;
		};
	}
}

/**
 * Task 34 — Hotplug-aware input picker + live switch, end-to-end.
 *
 * Drives the REAL frontend live source switch against the REAL dev backend's
 * mock attach/detach seam:
 *   1. reattach the seeded USB source → it appears live (no refresh),
 *   2. live-switch to it → the real backend returns SOURCE_LOST on hosts without
 *      a matching engine/v4l2 device and the operator sees the source-unavailable toast,
 *   3. detach it → it remains visible as a disabled live-switch row.
 *
 * The WebSocket harness (addInitScript) authenticates via a persistent token and
 * observes the page's real switchInput call. Fixture-owned BackendRpc drives the
 * dev-only attach/detach seam. Nothing fakes switchInput; success and SOURCE_LOST
 * both come from the dev backend.
 * The successful switch/hotplug/latency contract is exercised separately by the
 * receive-only Rock 5B+ @hardware gate at the bottom of this file.
 */

function readMockToken(): string {
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
}

function installWsHarness(token: string): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__cera) return;
	const Real = w.WebSocket;
	w.__cera = {
		socket: null,
		_seq: 0,
		lastSources: null,
		switchById: {},
		switchResults: {},
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
		switchResult(inputId: string) {
			return w.__cera.switchResults[inputId];
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
					const frame = JSON.parse(ev.data);
					const sources = frame?.sources;
					if (sources && typeof sources === "object") {
						w.__cera.lastSources = sources;
					}
					const inputId = w.__cera.switchById[frame?.id];
					if (inputId) {
						w.__cera.switchResults[inputId] = frame?.result;
						delete w.__cera.switchById[frame.id];
					}
				} catch (err) {
					if (!(err instanceof SyntaxError)) throw err;
				}
			});
		}
		// biome-ignore lint/suspicious/noExplicitAny: WebSocket.send payload union.
		send(data: any) {
			try {
				const msg = JSON.parse(data);
				if (
					Array.isArray(msg.path) &&
					msg.path.join(".") === "streaming.switchInput" &&
					msg.id !== undefined &&
					typeof msg.input?.input_id === "string"
				) {
					w.__cera.switchById[msg.id] = msg.input.input_id;
				}
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
		([t, p]) => window.__cera.emit(t, p),
		[type, payload] as const,
	);
}

function liveSwitch(page: Page) {
	return page.locator('[data-testid="live-source-switch"]');
}

function deviceRow(page: Page, inputId: string) {
	return liveSwitch(page).locator(`[data-source-switch-row="${inputId}"]`);
}

function setDeviceAttached(
	rpc: BackendRpc,
	inputId: string,
	attached: boolean,
): Promise<{ success: boolean; error?: string }> {
	return rpc.call(["streaming", "setMockDeviceAttached"], {
		input_id: inputId,
		attached,
	});
}

function switchResult(page: Page, inputId: string): Promise<unknown> {
	return page.evaluate((id) => window.__cera.switchResult(id), inputId);
}

test.describe.configure({ mode: "serial" });

test.describe("input picker mock negative coverage (Task 34)", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser hardware integration proof",
	);

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the picker",
		);
		await page.addInitScript(installWsHarness, readMockToken());
		await page.goto("/");
		await navigateTo(page, "live");
		await expect
			.poll(
				async () => {
					await emit(page, "status", {
						is_streaming: true,
						active_encode: {
							codec: "h265",
							resolution: "1920x1080",
							framerate: 30,
							active_input: "hdmi",
						},
					});
					return page.getByTestId("live-cockpit")
						.isVisible()
						.catch(() => false);
				},
				{ timeout: 10_000, message: "live cockpit should mount while streaming" },
			)
			.toBe(true);
	});

	test.afterEach(async ({ backendRpc }) => {
		await setDeviceAttached(backendRpc, "usb", true).catch(() => {});
	});

	test("a mock-visible source switch uses the real RPC and surfaces SOURCE_LOST", async ({
		backendRpc,
		page,
	}) => {
		await setDeviceAttached(backendRpc, "usb", false);
		await setDeviceAttached(backendRpc, "usb", true);

		const row = deviceRow(page, "usb");
		await expect(row).toBeVisible({ timeout: 8000 });

		await row.locator("[data-switch-input]").click();
		await page.waitForFunction(
			(inputId) => window.__cera.switchResult(inputId) !== undefined,
			"usb",
			{ timeout: 8000 },
		);
		expect(await switchResult(page, "usb")).toEqual({
			success: false,
			error: "SOURCE_LOST",
		});
		await expect(page.getByText(/source unavailable/i)).toBeVisible({
			timeout: 8000,
		});
	});

	test("a just-unplugged device remains visible as a disabled live-switch entry", async ({
		backendRpc,
		page,
	}) => {
		await setDeviceAttached(backendRpc, "usb", true);
		const row = deviceRow(page, "usb");
		await expect(row).toBeVisible({ timeout: 8000 });
		await expect(row.locator("[data-switch-input]")).toBeEnabled();

		await setDeviceAttached(backendRpc, "usb", false);
		await expect(row.locator("[data-switch-input]")).toBeDisabled({ timeout: 8000 });
	});
});

hardwareTest.describe("Rock 5B+ input picker live-switch gate @hardware", () => {
	hardwareTest.describe.configure({ mode: "serial" });
	hardwareTest.skip(
		!hardwareInputPickerEnabled,
		HARDWARE_INPUT_PICKER_PREREQUISITE,
	);
	hardwareTest.skip(
		({ browserName }) => browserName !== "chromium",
		"Rock 5B+ hardware gate requires Chromium",
	);

	hardwareTest.beforeEach(({}, testInfo) => {
		hardwareTest.skip(
			testInfo.project.name !== "desktop",
			"Rock 5B+ hardware gate uses the desktop live cockpit",
		);
	});

	hardwareTest(
		"real attach → successful <=67ms switch → active state → real detach",
		runRock5bInputPickerGate,
	);
});
