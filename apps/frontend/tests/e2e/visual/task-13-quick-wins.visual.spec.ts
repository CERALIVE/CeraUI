import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { evidencePath, navigateTo } from "../helpers/index.js";

/**
 * @visual evidence for Task 13 quick wins — produces two PNGs a reviewer can
 * eyeball without running the app:
 *   • task-13-bitrate.png — the unified bitrate control (slider + number share
 *     ONE board window) snapping an over-max entry to the ceiling, with the
 *     supported-range hint, the clamp notice, AND the uniform per-codec
 *     hardware/software acceleration labels.
 *   • task-13-applies-next-start.png — the "Applies on next start" badge shown
 *     against a restart-required source edited while a stream is live.
 *
 * Drives the REAL EncoderDialog against a deterministic `generic` (software)
 * capability snapshot injected over the dev broadcast, reusing the field-lock /
 * encoder-capability WebSocket harness.
 */

const TOKEN: string = (() => {
	const tokensPath = path.resolve(
		import.meta.dirname,
		"../../../../backend/auth_tokens.json",
	);
	const tokens = Object.keys(
		JSON.parse(fs.readFileSync(tokensPath, "utf8")) as Record<string, true>,
	).filter((key) => key !== "placeholder");
	if (tokens.length === 0) {
		throw new Error(`No persistent auth tokens in ${tokensPath}`);
	}
	return tokens[0] as string;
})();

const GENERIC_PIPELINES = {
	hardware: "generic",
	pipelines: {
		hdmi: {
			name: "HDMI Capture",
			description: "Deterministic capability fixture",
			supportsAudio: true,
			supportsResolutionOverride: true,
			supportsFramerateOverride: true,
			defaultResolution: "1080p",
			defaultFramerate: 30,
		},
	},
};

const GENERIC_CAPS = {
	platform: {
		supports_h265: true,
		hardware_accelerated: false,
		max_resolution: "1080p",
	},
	encoder: {
		codecs: ["H264", "H265"],
		bitrate_range: { min: 500, max: 6000, unit: "kbps" },
	},
	sources: [],
};

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

test.describe("@visual Task 13 quick wins", () => {
	test.skip(
		({ browserName }) => browserName !== "chromium",
		"single-browser evidence proof",
	);

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the encoder dialog",
		);
		await page.addInitScript(installWsHarness, TOKEN);
		await page.goto("/");
		await navigateTo(page, "live");
		await expect
			.poll(
				async () => {
					await emit(page, "config", {
						srtla_addr: "127.0.0.1",
						srtla_port: 5000,
						srt_streamid: "e2e",
						max_br: 5000,
					});
					await emit(page, "pipelines", GENERIC_PIPELINES);
					await emit(page, "capabilities", GENERIC_CAPS);
					return page
						.getByTestId("open-encoder-dialog")
						.isVisible()
						.catch(() => false);
				},
				{ timeout: 10_000, message: "encoder edit row should be present" },
			)
			.toBe(true);
	});

	test("unified bitrate clamp + uniform codec labels @visual", async ({
		page,
	}) => {
		await page.getByTestId("open-encoder-dialog").click();
		const dialog = page.getByRole("dialog", { name: "Encoder Settings" });
		await expect(dialog).toBeVisible();

		await page.locator("#encoder-source").click();
		await page.locator('[role="option"][data-value="hdmi"]').click();

		const summary = page.getByTestId("encoder-advanced-summary");
		if (await summary.isVisible()) {
			await summary.click();
		}

		// Both H.264 and H.265 carry the uniform software acceleration label.
		await expect(page.getByTestId("codec-accel-h264")).toBeVisible();
		await expect(page.getByTestId("codec-accel-h265")).toBeVisible();

		// An over-max entry snaps to the shared board ceiling (6000) and surfaces
		// the clamp notice — the number input and slider can never diverge.
		const input = page.locator("#encoder-bitrate");
		await input.fill("50000");
		await expect(input).toHaveValue("6000");
		await expect(page.getByTestId("bitrate-clamped")).toBeVisible();
		await expect(page.getByTestId("bitrate-range-hint")).toBeVisible();

		await dialog.screenshot({ path: evidencePath("task-13-bitrate.png") });
	});

	test("applies-on-next-start badge while streaming @visual", async ({
		page,
	}) => {
		await page.getByTestId("open-encoder-dialog").click();
		const dialog = page.getByRole("dialog", { name: "Encoder Settings" });
		await expect(dialog).toBeVisible();

		// Edit the restart-required video source, then mark the stream live: the
		// edit can't apply mid-stream, so the "Applies on next start" badge shows.
		await page.locator("#encoder-source").click();
		await page.locator('[role="option"][data-value="hdmi"]').click();
		await emit(page, "status", { is_streaming: true });

		const badge = page.getByTestId("source-applies-next-start");
		await expect(badge).toBeVisible();
		await expect(badge).toContainText(/next start/i);

		await dialog.screenshot({
			path: evidencePath("task-13-applies-next-start.png"),
		});
	});
});
