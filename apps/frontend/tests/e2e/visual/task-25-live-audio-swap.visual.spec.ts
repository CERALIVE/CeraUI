import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { evidencePath } from "../helpers/index.js";

/**
 * Task 25 — live audio switch is ENABLED once the engine advertises
 * `audio_live_switch`, while still-deferred roadmap items stay coming-soon.
 *
 * Captures two repo-local evidence PNGs against the REAL frontend + mock
 * backend, driving capabilities/devices/status over the WebSocket dev `emit`
 * passthrough (same harness as task-10-audio-comingsoon.visual.spec) so the
 * proof needs no audio hardware:
 *   • task-25-live-audio-swap.png    — the audio source rendered as a real,
 *     enabled live Switch control (capability on).
 *   • task-25-deferred-remain.png    — the PiP / mode-fallback roadmap items
 *     still showing their calm coming-soon pills (no capability flag → G2).
 */

const TOKEN: string = (() => {
	const tokensPath = path.resolve(
		import.meta.dirname,
		"../../../../backend/auth_tokens.json",
	);
	const tokens = Object.keys(
		JSON.parse(fs.readFileSync(tokensPath, "utf8")) as Record<string, true>,
	);
	if (tokens.length === 0) {
		throw new Error(`No persistent auth tokens in ${tokensPath}`);
	}
	return tokens[0] as string;
})();

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
		([t, p]) =>
			(
				window as { __cera: { emit: (t: string, p: unknown) => void } }
			).__cera.emit(t, p),
		[type, payload] as const,
	);
}

const DEVICES = {
	engine: "cerastream",
	active_input: "video0",
	devices: [
		{
			input_id: "video0",
			device_path: "/dev/video0",
			display_name: "HDMI Capture",
			media_class: "video",
			kind: "hdmi",
		},
		{
			input_id: "audio:usbaudio",
			device_path: "alsa:usbaudio",
			display_name: "USB Audio CODEC",
			media_class: "audio",
			kind: "audio",
		},
	],
} as const;

const CAPS_AUDIO_ON = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "1080p",
	},
	encoder: {
		codecs: ["video/x-h264"],
		bitrate_range: { min: 2000, max: 12000, unit: "kbps" },
	},
	sources: [],
	audio_live_switch: true,
} as const;

test.describe("@visual Task 25 — live audio switch enabled + deferred remain", () => {
	test(
		"@visual audio source is an enabled live Switch; deferred roadmap stays coming-soon",
		{ tag: "@visual" },
		async ({ page }, testInfo) => {
			test.skip(
				testInfo.project.name !== "desktop",
				"single-layout visual proof",
			);

			await page.addInitScript(installWsHarness, TOKEN);
			await page.goto("/");

			const audioSwitch = page.locator(
				'[data-switch-input="audio:usbaudio"]',
			);
			await expect
				.poll(
					async () => {
						await emit(page, "capabilities", CAPS_AUDIO_ON);
						await emit(page, "status", { is_streaming: true });
						await emit(page, "devices", DEVICES);
						return audioSwitch.isVisible().catch(() => false);
					},
					{
						timeout: 20_000,
						message:
							"audio source should be an enabled live Switch once the capability is advertised",
					},
				)
				.toBe(true);

			await expect(
				page.locator('[data-audio-switch-deferred="audio:usbaudio"]'),
			).toHaveCount(0);

			const picker = page.getByTestId("input-picker");
			await picker.scrollIntoViewIfNeeded();
			await picker.screenshot({
				path: evidencePath("task-25-live-audio-swap.png"),
			});

			// Still-deferred roadmap items keep their calm coming-soon pills even
			// with audio live-switch on — they have no capability flag (G2).
			const roadmap = page.getByTestId("live-roadmap");
			await expect(roadmap.locator('[data-comingsoon="TD-pip"]')).toBeVisible();
			await expect(
				roadmap.locator('[data-comingsoon="TD-mode-fallback"]'),
			).toBeVisible();
			await roadmap.scrollIntoViewIfNeeded();
			await roadmap.screenshot({
				path: evidencePath("task-25-deferred-remain.png"),
			});
		},
	);
});
