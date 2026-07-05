import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * LiveSourceSwitch — live capture-source switch surface, end-to-end (Task T12).
 *
 * While streaming, LiveView mounts LiveCockpit (not IdleCockpit), so SourceSection's
 * streaming-branch switch buttons never render — the live input switch was
 * unreachable from any mounted UI. LiveSourceSwitch is that surface, and T7's
 * deferred audio-follow toast rides on it. These specs prove the loop end-to-end:
 *
 *   1. streaming a CAPTURE source with ≥2 captures → the switch card renders; a live
 *      HDMI→USB switch through it dispatches switchInput with the USB source id (the
 *      source the backend persists as config.source) and, on audio_follow_pending,
 *      shows T7's "audio will follow" toast — the first user-reachable proof of T7;
 *   2. streaming a NETWORK source → the card is ABSENT (a leg-less rtmp/srt session
 *      can't switch inputs), so zero `data-switch-input` buttons render.
 *
 * Everything is injected over the page's own authenticated socket via a
 * `routeWebSocket` proxy (the source-overhaul.spec pattern): the switchInput RPC is
 * held + fake-resolved so the flow is hermetic and never mutates the shared mock
 * backend's stream state.
 */

let pageWs: WebSocketRoute | null = null;
// Rewrite every server `status.is_streaming` to the test-owned flag so the mock's
// own idle broadcast can't unmount the streaming cockpit mid-assertion.
let controlStreaming = false;
let streamingFlag = false;
// Drop the backend's own devices/sources echoes so the injected lists are authoritative.
let dropServerDevices = false;
let dropServerSources = false;
// Intercept the next streaming.switchInput RPC: capture its input + fake-resolve it
// with audio_follow_pending so the T7 toast fires without touching the real backend.
let interceptSwitchInput = false;
let switchInputInput: Record<string, unknown> | null = null;

function send(payload: unknown): void {
	pageWs?.send(JSON.stringify(payload));
}

function serverConfig(extra: Record<string, unknown> = {}): void {
	send({
		config: {
			srtla_addr: "127.0.0.1",
			srtla_port: 5000,
			srt_streamid: "e2e",
			max_br: 6000,
			pipeline: "hdmi",
			asrc: "Auto",
			...extra,
		},
	});
}

type Device = {
	input_id: string;
	device_path: string;
	display_name: string;
	media_class: "video" | "audio";
	kind: string;
};

const HDMI: Device = {
	input_id: "video0",
	device_path: "/dev/video0",
	display_name: "HDMI Camera",
	media_class: "video",
	kind: "hdmi",
};
const USB: Device = {
	input_id: "video1",
	device_path: "/dev/video1",
	display_name: "USB Capture",
	media_class: "video",
	kind: "usb",
};

function sendDevices(activeInput: string, devices: Device[]): void {
	send({ devices: { engine: "cerastream", active_input: activeInput, devices } });
}

function captureSource(
	id: string,
	kind: string,
	pipelineId: string,
	displayName: string,
): Record<string, unknown> {
	return {
		origin: "capture",
		id,
		pipelineId,
		kind,
		displayName,
		devicePath: `/dev/${id}`,
		modes: [{ width: 1920, height: 1080, framerates: [30, 60] }],
		supportsAudio: kind === "hdmi",
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		defaultResolution: "1080p",
		defaultFramerate: 30,
		audioKind: kind === "hdmi" ? "selectable" : "none",
		available: true,
	};
}

const CAP_HDMI = captureSource("video0", "hdmi", "hdmi", "HDMI Camera");
const CAP_USB = captureSource("video1", "usb", "libuvch264", "USB Capture");
const NETWORK_SRC = {
	origin: "network",
	id: "rtmp",
	pipelineId: "rtmp",
	labelKey: "settings.sources.rtmp",
	requiresGateway: "rtmp",
	url: "rtmp://192.168.1.100/publish/live",
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: false,
	supportsFramerateOverride: false,
	audioKind: "embedded",
	available: true,
};

function sendSources(sources: Record<string, unknown>[]): void {
	send({ sources: { hardware: "rk3588", sources } });
}

// A streaming status carrying the engine's active_encode — its active_input is the
// running leg that decides whether a live source switch is even valid.
function sendStreamingStatus(activeInput: string): void {
	send({
		status: {
			is_streaming: true,
			active_encode: { active_input: activeInput, resolution: "1920x1080", framerate: 60, codec: "h265" },
		},
	});
}

test.describe("LiveSourceSwitch (functional)", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the live cockpit; mobile/kiosk/RTL are the @visual suite",
		);

		pageWs = null;
		controlStreaming = true;
		streamingFlag = true;
		dropServerDevices = true;
		dropServerSources = true;
		interceptSwitchInput = false;
		switchInputInput = null;

		await page.routeWebSocket(/:(3002|31\d\d|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();

			ws.onMessage((m) => {
				if (interceptSwitchInput) {
					const text = typeof m === "string" ? m : m.toString();
					try {
						const frame = JSON.parse(text) as {
							id?: string | number;
							path?: unknown;
							input?: Record<string, unknown>;
						};
						const rpc = Array.isArray(frame.path) ? frame.path.join(".") : null;
						if (rpc === "streaming.switchInput") {
							switchInputInput = frame.input ?? null;
							if (frame.id !== undefined) {
								ws.send(
									JSON.stringify({
										id: frame.id,
										result: { success: true, gap_ms: 12, audio_follow_pending: true },
									}),
								);
							}
							return; // hermetic: never forward to the shared backend
						}
					} catch {
						/* non-RPC frame */
					}
				}
				server.send(m);
			});

			server.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as { status?: Record<string, unknown> };
					if (dropServerDevices && "devices" in (frame as object)) return;
					if (dropServerSources && "sources" in (frame as object)) return;
					if (controlStreaming && frame?.status && typeof frame.status === "object") {
						frame.status.is_streaming = streamingFlag;
						ws.send(JSON.stringify(frame));
						return;
					}
				} catch {
					/* non-JSON / binary frame */
				}
				ws.send(m);
			});
		});

		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
	});

	test("a live HDMI→USB switch through the card dispatches the USB source and shows the audio-follow toast", async ({
		page,
	}: {
		page: Page;
	}) => {
		serverConfig({ source: "video0" });
		sendDevices("video0", [HDMI, USB]);
		sendSources([CAP_HDMI, CAP_USB]);
		sendStreamingStatus("video0");

		// The live cockpit is mounted (streaming) and the switch card renders because
		// the running source is capture AND two capture sources exist.
		await expect(page.getByTestId("live-cockpit")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("live-source-switch")).toBeVisible();

		// The running (HDMI) row is the disabled "Active" one; the USB row is switchable.
		const usbSwitch = page.locator('[data-switch-input="video1"]');
		await expect(usbSwitch).toBeEnabled();
		await expect(page.locator('[data-switch-input="video0"]')).toBeDisabled();

		// Perform the live switch through the card. The RPC is intercepted so the
		// audio_follow_pending path is deterministic.
		interceptSwitchInput = true;
		await usbSwitch.click();

		// The dispatched switchInput carries the USB source id — the source the backend
		// persists as config.source (closing the T7 loop from a reachable surface).
		await expect.poll(() => switchInputInput?.input_id, { timeout: 5_000 }).toBe("video1");

		// T7's deferred audio-follow toast is now reachable end-to-end.
		await expect(page.getByText(/audio will follow/i)).toBeVisible({ timeout: 8_000 });

		// The authoritative config echo carries the persisted USB source; the app stays
		// truthfully live (no crash, cockpit still mounted). The now-streaming summary
		// strip is mounted alongside the switch card.
		serverConfig({ source: "video1" });
		await expect(page.getByTestId("live-cockpit")).toBeVisible();
		await expect(page.getByTestId("live-summary-strip")).toBeVisible();
	});

	test("streaming a network source renders no switch buttons (leg-less session)", async ({
		page,
	}: {
		page: Page;
	}) => {
		serverConfig({ source: "rtmp" });
		sendDevices("video0", [HDMI, USB]);
		sendSources([NETWORK_SRC, CAP_HDMI, CAP_USB]);
		sendStreamingStatus("rtmp");

		await expect(page.getByTestId("live-cockpit")).toBeVisible({ timeout: 15_000 });
		// Even with two capture sources present, a network-origin running source cannot
		// switch inputs — the card is absent and no switch button exists.
		await expect(page.getByTestId("live-source-switch")).toHaveCount(0);
		await expect(page.locator("[data-switch-input]")).toHaveCount(0);
	});
});
