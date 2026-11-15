import fs from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "../fixtures/index.js";

import { evidencePath, navigateTo } from "../helpers/index.js";

/**
 * @visual evidence for Task 13 quick wins — produces two PNGs a reviewer can
 * eyeball without running the app:
 *   • task-13-bitrate.png — the unified bitrate control (slider + number share
 *     ONE board window) snapping an over-max entry to the ceiling, with the
 *     supported-range hint, the clamp notice, AND the uniform per-codec
 *     hardware/software acceleration labels.
 *   • task-13-applies-next-start.png — the "Applies on next start" badge shown
 *     against a restart-required resolution edited while a stream is live.
 *
 * Drives the REAL EncoderDialog against a deterministic `generic` (software)
 * capability snapshot injected over the dev broadcast, reusing the field-lock /
 * encoder-capability WebSocket harness.
 */

const TOKEN: string = (() => {
	const tokenPath = path.resolve(
		import.meta.dirname,
		"../../../../backend/.e2e-auth-token",
	);
	let token: string;
	try {
		token = fs.readFileSync(tokenPath, "utf8").trim();
	} catch {
		throw new Error(`No persistent auth token at ${tokenPath}`);
	}
	if (token.length === 0) {
		throw new Error(`Empty persistent auth token at ${tokenPath}`);
	}
	return token;
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

// The dialog's capability axes key off the board in the `sources` snapshot and the
// source `config.source` names; this HDMI input is that source.
const GENERIC_SOURCES = {
	hardware: "generic",
	sources: [
		{
			origin: "capture",
			id: "hdmi",
			pipelineId: "hdmi",
			kind: "hdmi",
			displayName: "HDMI Capture",
			devicePath: "/dev/video0",
			modes: [
				{ width: 3840, height: 2160, framerates: [30, 60] },
				{ width: 1920, height: 1080, framerates: [30, 60] },
				{ width: 1280, height: 720, framerates: [30, 60] },
			],
			supportsAudio: true,
			supportsResolutionOverride: true,
			supportsFramerateOverride: true,
			defaultResolution: "1080p",
			defaultFramerate: 30,
			audioKind: "selectable",
			available: true,
		},
	],
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
						// Edit stays disabled-with-reason until a source resolves.
						pipeline: "hdmi",
						source: "hdmi",
					});
					await emit(page, "pipelines", GENERIC_PIPELINES);
					await emit(page, "sources", GENERIC_SOURCES);
					await emit(page, "capabilities", GENERIC_CAPS);
					const edit = page.getByTestId("open-encoder-dialog");
					return (await edit.isVisible()) && (await edit.isEnabled());
				},
				{
					timeout: 10_000,
					message: "encoder edit row should be present and enabled",
				},
			)
			.toBe(true);
	});

	test("unified bitrate clamp + codec selector @visual", async ({
		page,
	}) => {
		await page.getByTestId("open-encoder-dialog").click();
		const dialog = page.getByRole("dialog", { name: "Encoder Settings" });
		await expect(dialog).toBeVisible();

		// The Source section picks the input (no picker here since #137); the
		// dialog reflects the active source read-only.
		await expect(dialog.getByTestId("encoder-active-source")).toHaveAttribute(
			"data-source-id",
			"hdmi",
		);

		// The codec choices appear once the operator opts into choosing the format.
		// Verify both H.264 and H.265 choices are present and visible.
		await dialog.getByTestId("encoder-format-manual").click();
		await expect(page.getByTestId("encoder-format-h264")).toBeVisible();
		await expect(page.getByTestId("encoder-format-h265")).toBeVisible();

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

		// Edit the restart-required resolution, then mark the stream live: the edit
		// can't apply mid-stream, so the "Applies on next start" badge shows. The
		// source is no longer edited here (the Source section owns it since #137).
		await page.locator("#encoder-resolution").click();
		await page
			.locator('[data-testid="resolution-option"][data-value="720p"]')
			.click();
		await emit(page, "status", { is_streaming: true });

		const badge = page.getByTestId("resolution-applies-next-start");
		await expect(badge).toBeVisible();
		await expect(badge).toContainText(/next start/i);

		await dialog.screenshot({
			path: evidencePath("task-13-applies-next-start.png"),
		});
	});
});
