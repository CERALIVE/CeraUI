import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { evidencePath } from "../helpers/index.js";

/**
 * Task 10 — live audio-switch is gated, audio sources show "coming soon".
 *
 * Proves, against the REAL frontend + mock backend, that while streaming an
 * audio capture source in the input picker renders a DISABLED "coming soon"
 * affordance (never an actionable Switch) when the engine has not advertised
 * `audio_live_switch`. Captures the section as repo-local evidence.
 *
 * Devices + streaming state are injected over the WebSocket via the dev `emit`
 * passthrough (same harness as input-picker.spec) so the proof needs no audio
 * hardware.
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

test.describe("@visual Task 10 — gated live audio switch", () => {
	test(
		"@visual audio source shows a disabled coming-soon affordance while streaming",
		{ tag: "@visual" },
		async ({ page }, testInfo) => {
			test.skip(
				testInfo.project.name !== "desktop",
				"single-layout visual proof",
			);

			await page.addInitScript(installWsHarness, TOKEN);
			await page.goto("/");

			const deferred = page.locator(
				'[data-audio-switch-deferred="audio:usbaudio"]',
			);

			await expect
				.poll(
					async () => {
						await emit(page, "status", { is_streaming: true });
						await emit(page, "devices", DEVICES);
						return deferred.isVisible().catch(() => false);
					},
					{
						timeout: 20_000,
						message: "audio coming-soon affordance should render while streaming",
					},
				)
				.toBe(true);

			await expect(deferred).toHaveAttribute(
				"data-debt-id",
				"TD-live-audio-switch",
			);
			await expect(
				page.locator('[data-switch-input="audio:usbaudio"]'),
			).toHaveCount(0);

			const section = page.getByTestId("source-section");
			await section.scrollIntoViewIfNeeded();
			await section.screenshot({
				path: evidencePath("task-10-audio-comingsoon.png"),
			});
		},
	);
});
