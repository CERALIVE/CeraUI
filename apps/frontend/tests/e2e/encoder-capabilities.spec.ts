import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "./fixtures/index.js";

import { navigateTo } from "./helpers";

/**
 * Encoder capability wiring — per-board bitrate clamp, UVC H.265 surfacing, and
 * the generic H.265 software-encode warning, end-to-end against the real dev
 * backend. The capability contract + capture devices are injected as synthetic
 * broadcast frames through the app's own authenticated socket (no `dev.emit`,
 * no new backend route), exactly the shape `subscriptions.handleMessage` parses.
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
			(window as { __cera: { injectBroadcast: (p: unknown) => void } }).__cera.injectBroadcast(p),
		payload,
	);
}

// A server target makes LiveView render its config rows (not the empty state),
// so the encoder dialog trigger is reachable regardless of saved device state.
const SERVER_CONFIG = {
	config: {
		srtla_addr: "10.0.0.1",
		srtla_port: 5000,
		pipeline: "hdmi",
		max_br: 6000,
	},
};

function caps(
	platform: {
		supports_h265: boolean;
		hardware_accelerated: boolean;
		max_resolution: string;
	},
	bitrate: { min: number; max: number },
) {
	return {
		capabilities: {
			platform,
			encoder: {
				codecs: platform.supports_h265 ? ["H264", "H265"] : ["H264"],
				bitrate_range: { ...bitrate, unit: "kbps" },
			},
			sources: [],
		},
	};
}

const UVC_H265_DEVICES = {
	devices: {
		engine: "cerastream",
		devices: [
			{
				input_id: "usb-h265-0",
				device_path: "/dev/video9",
				display_name: "QA H.265 Cam",
				media_class: "video",
				kind: "usb",
				caps: [{ width: 1920, height: 1080, media_type: "video/x-h265" }],
			},
		],
	},
};

async function openEncoder(page: Page): Promise<void> {
	await navigateTo(page, "live");
	await inject(page, SERVER_CONFIG);
	await page.getByTestId("open-encoder-dialog").click();
	await expect(
		page.getByRole("dialog", { name: "Encoder Settings" }),
	).toBeVisible();
}

test.describe("encoder capability wiring", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser capability proof",
	);
	test.skip(!TOKEN, "requires a backend persistent auth token");

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the encoder dialog",
		);
		await page.addInitScript(installWsHarness, TOKEN as string);
		await page.goto("/");
	});

	test("clamps the bitrate input to the per-board ceiling", async ({ page }) => {
		await openEncoder(page);
		await inject(
			page,
			caps(
				{ supports_h265: true, hardware_accelerated: true, max_resolution: "2160p" },
				{ min: 2000, max: 15000 },
			),
		);

		// Bitrate lives under the Advanced / Custom expander (Task 7) — open it.
		await page.getByTestId("encoder-advanced-summary").click();

		const input = page.locator("#encoder-bitrate");
		await input.fill("50000");
		await expect(input).toHaveValue("15000");
	});

	test("surfaces a UVC H.265 source when a device advertises video/x-h265", async ({
		page,
	}) => {
		await openEncoder(page);
		await inject(page, UVC_H265_DEVICES);

		await expect(page.getByTestId("source-uvc_h265").first()).toBeVisible();
	});

	test("offers generic H.265 with a software-encode warning badge", async ({
		page,
	}) => {
		await openEncoder(page);
		await inject(
			page,
			caps(
				{ supports_h265: true, hardware_accelerated: false, max_resolution: "1080p" },
				{ min: 500, max: 6000 },
			),
		);

		// Codec selector lives under the Advanced / Custom expander (Task 7) — open it.
		await page.getByTestId("encoder-advanced-summary").click();

		// The software-encode caveat surfaces once H.265 (offered but hw-unaccelerated)
		// is the selected codec.
		await page.getByTestId("codec-h265").click();
		const badge = page.getByTestId("codec-h265-software").first();
		await expect(badge).toBeVisible();
		await expect(badge).toContainText(/software/i);
	});
});
