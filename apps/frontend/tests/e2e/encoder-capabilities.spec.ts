import fs from "node:fs";
import path from "node:path";

import {
	type CaptureStreamSource,
	type SourcesMessage,
	sourcesMessageSchema,
} from "@ceraui/rpc/schemas";
import { expect, type Page, PageRpc, test } from "./fixtures/index.js";
import { isBackendSocket } from "./helpers/backend-socket.js";

import { navigateTo } from "./helpers";

/**
 * Encoder capability wiring — per-board bitrate clamp, UVC H.265 surfacing, and
 * the generic H.265 software-encode warning, end-to-end against the real dev
 * backend. The fixtures feed the same broadcasts the authenticated app consumes.
 */

const TOKEN: string | null = (() => {
	try {
		const tokenPath = path.resolve(
			import.meta.dirname,
			"../../../backend/.e2e-auth-token",
		);
		const token = fs.readFileSync(tokenPath, "utf8").trim();
		return token.length > 0 ? token : null;
	} catch {
		return null;
	}
})();

declare global {
	interface Window {
		__ceraEncoder?: {
			socket: WebSocket | null;
			setConfigInputs: unknown[];
			injectBroadcast(payload: unknown): void;
		};
	}
}

function installWsHarness(token: string): void {
	if (window.__ceraEncoder) return;
	const Real = window.WebSocket;
	const harness: NonNullable<Window["__ceraEncoder"]> = {
		socket: null,
		setConfigInputs: [],
		injectBroadcast(payload: unknown) {
			const s = harness.socket;
			if (s) {
				s.dispatchEvent(
					new MessageEvent("message", { data: JSON.stringify(payload) }),
				);
			}
		},
	};
	window.__ceraEncoder = harness;
	class HookedWS extends Real {
		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols);
			harness.socket = this;
		}
		send(data: Parameters<WebSocket["send"]>[0]) {
			if (typeof data === "string") {
				try {
					const msg = JSON.parse(data);
					if (Array.isArray(msg.path) && msg.path.join(".") === "auth.login") {
						msg.input = { token, persistent_token: true };
						return super.send(JSON.stringify(msg));
					}
					if (Array.isArray(msg.path) && msg.path.join(".") === "streaming.setConfig") {
						harness.setConfigInputs.push(msg.input);
					}
				} catch (error) {
					if (!(error instanceof SyntaxError)) throw error;
				}
			}
			return super.send(data);
		}
	}
	window.WebSocket = HookedWS;
	try {
		localStorage.setItem("auth", "e2e-token-marker");
	} catch {
		/* storage unavailable */
	}
}

function inject(page: Page, payload: unknown): Promise<void> {
	return page.evaluate((p) => {
		if (!window.__ceraEncoder) throw new Error("Encoder socket harness missing");
		window.__ceraEncoder.injectBroadcast(p);
	}, payload);
}

// A server target makes LiveView render its config rows (not the empty state),
// and an effective source (Task 18/19) un-gates the encoder-edit trigger, so the
// dialog is reachable regardless of saved device state.
const SERVER_CONFIG = {
	config: {
		srtla_addr: "10.0.0.1",
		srtla_port: 5000,
		pipeline: "hdmi",
		source: "hdmi",
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

const H265_CAMERA = {
	origin: "capture",
	id: "usb-h265-0",
	pipelineId: "libuvch265",
	kind: "uvc_h265",
	displayName: "QA H.265 Cam",
	devicePath: "/dev/video9",
	modes: [
		{
			width: 1920,
			height: 1080,
			media_type: "video/x-h265",
			framerates: [30],
		},
	],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	audioKind: "selectable",
	available: true,
} satisfies CaptureStreamSource;

const LATE_CAMERA = {
	...H265_CAMERA,
	id: "usb-late-h264",
	pipelineId: "libuvch264",
	kind: "uvc_h264",
	displayName: "Late H.264 Cam",
	devicePath: "/dev/video10",
	modes: [{ width: 1920, height: 1080, media_type: "video/x-h264", framerates: [30] }],
} satisfies CaptureStreamSource;

function withH265Camera(roster: SourcesMessage): SourcesMessage {
	return {
		...roster,
		sources: [
			...roster.sources.filter((source) => source.id !== H265_CAMERA.id),
			H265_CAMERA,
		],
	};
}

function isSourcesMessage(payload: unknown): payload is SourcesMessage {
	return sourcesMessageSchema.safeParse(payload).success;
}

function setConfigInputs(page: Page): Promise<unknown[]> {
	return page.evaluate(() => {
		if (!window.__ceraEncoder) throw new Error("Encoder socket harness missing");
		return window.__ceraEncoder.setConfigInputs;
	});
}

async function openEncoder(page: Page): Promise<void> {
	await page.goto("/");
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

		// Bitrate control is now always visible (no Advanced expander after todo 9 flattening).
		const input = page.locator("#encoder-bitrate");
		await input.fill("50000");
		await expect(input).toHaveValue("15000");
	});

	test("surfaces a UVC H.265 source when a device advertises video/x-h265", async ({
		page,
	}) => {
		const rpc = new PageRpc();
		const roster: { latest?: SourcesMessage } = {};
		let includeCamera = false;
		try {
			await page.routeWebSocket(
				(url) => isBackendSocket(url) && url.pathname === "/ws",
				(socket) => {
					const server = socket.connectToServer();
					rpc.bindConnectionLifecycle(socket, server);
					server.onMessage((message) => {
						if (typeof message === "string") {
							let frame: unknown;
							try {
								frame = JSON.parse(message);
							} catch (error) {
								if (!(error instanceof SyntaxError)) throw error;
							}
							if (
								frame &&
								typeof frame === "object" &&
								!("id" in frame) &&
								"sources" in frame &&
								isSourcesMessage(frame.sources)
							) {
								roster.latest = frame.sources;
								if (includeCamera) {
									// Keep the synthetic device, not a stale copy of the roster.
									socket.send(
										JSON.stringify({
											...frame,
											sources: withH265Camera(frame.sources),
										}),
									);
									rpc.acceptServerMessage(message);
									return;
								}
							}
						}
						socket.send(message);
						rpc.acceptServerMessage(message);
					});
				},
			);
			await openEncoder(page);
			await rpc.waitForPushedEvent("sources");
			const initialRoster = roster.latest;
			if (!initialRoster)
				throw new Error("Backend did not send a valid source roster");
			includeCamera = true;
			await inject(page, { sources: withH265Camera(initialRoster) });

			const badge = page.getByTestId("source-uvc_h265").first();
			await expect(badge).toBeVisible();
			const lateCamera = page
				.getByTestId("probed-caps")
				.getByText("Late H.264 Cam", { exact: true });
			await expect(lateCamera).toHaveCount(0);
			expect(
				await rpc.call(["dev", "emit"], {
					type: "sources",
					payload: {
						...initialRoster,
						sources: [...initialRoster.sources, LATE_CAMERA],
					},
				}),
			).toEqual({ success: true });
			await expect(lateCamera).toBeVisible();

			await expect(badge).toBeVisible();
			await expect(badge).toHaveAttribute("data-input-id", "usb-h265-0");
			await expect(badge).toContainText("QA H.265 Cam");
		} finally {
			rpc.close();
		}
	});

	test("Save writes only the settings the operator changed", async ({ page }) => {
		await openEncoder(page);
		const dialog = page.getByRole("dialog", { name: "Encoder Settings" });

		// An untouched Save must not write; the next Save's request proves it, because
		// requests leave in order and only one may be recorded.
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(dialog).toBeHidden();

		await page.getByTestId("open-encoder-dialog").click();
		await expect(dialog).toBeVisible();
		await dialog.getByTestId("encoder-adaptive").click();
		await dialog.getByRole("button", { name: "Save" }).click();

		await expect.poll(() => setConfigInputs(page)).toEqual([{ balancer: "fixed" }]);
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

		// The codec choices appear once the operator opts into choosing the format.
		// The software-encode caveat surfaces once H.265 (offered but hw-unaccelerated)
		// is the selected codec.
		await page.getByTestId("encoder-format-manual").click();
		await page.getByTestId("encoder-format-h265").click();
		const badge = page.getByTestId("codec-h265-software").first();
		await expect(badge).toBeVisible();
		await expect(badge).toContainText(/software/i);
	});
});
