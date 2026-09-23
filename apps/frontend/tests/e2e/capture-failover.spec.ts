import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * Capture failover — standby and suspension bands, backup-camera modes, the
 * "Match this camera" action (capture-failover-resilience todo 21), end-to-end.
 *
 * The engine's capture block rides `status.active_encode.capture`, so every
 * state here is driven by injecting status frames over the page's own
 * authenticated socket (the `live-source-switch.spec.ts` proxy): the mock
 * backend's own status echoes are rewritten to the test-owned streaming flag
 * and `active_encode`, and `streaming.setConfig` is captured + fake-resolved so
 * the match action's payload can be asserted without mutating the shared mock.
 *
 * One walk, four states: normal → degraded (rate-adapted, retimed backup) →
 * standby (every camera lost) → normal again.
 */

let pageWs: WebSocketRoute | null = null;
let activeEncode: Record<string, unknown> | undefined;
const setConfigCalls: Record<string, unknown>[] = [];

function send(payload: unknown): void {
	pageWs?.send(JSON.stringify(payload));
}

function captureSource(
	id: string,
	displayName: string,
): Record<string, unknown> {
	return {
		origin: "capture",
		id,
		pipelineId: "libuvch264",
		kind: "uvc_h264",
		displayName,
		devicePath: `/dev/${id}`,
		modes: [{ width: 1920, height: 1080, framerates: [30, 60] }],
		supportsAudio: false,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		defaultResolution: "1080p",
		defaultFramerate: 30,
		audioKind: "none",
		available: true,
	};
}

const MAIN = captureSource("video0", "Main Camera");
const BACKUP = captureSource("video1", "Backup Camera");

const TARGETS = [
	{
		input_id: "video0",
		kind: "capture",
		source_width: 3840,
		source_height: 2160,
		source_framerate: 60,
	},
	{
		input_id: "video1",
		kind: "capture",
		source_width: 1920,
		source_height: 1080,
		source_framerate: 30,
	},
];

function encodeState(
	activeInput: string,
	capture: Record<string, unknown>,
	switchTargets: Record<string, unknown>[] = TARGETS,
): Record<string, unknown> {
	return {
		active_input: activeInput,
		resolution: "3840x2160",
		framerate: 60,
		codec: "h265",
		switch_targets: switchTargets,
		capture,
	};
}

const NORMAL = encodeState("video0", {
	state: "normal",
	live_inputs: ["video0", "video1"],
	degraded_inputs: [],
	failover_rate_policy: "retime",
});

const RATE_ADAPTED_RETIMED = encodeState("video1", {
	state: "degraded",
	live_inputs: ["video1"],
	degraded_inputs: [{ input_id: "video0", cause: "no_signal" }],
	failover_rate_policy: "retime",
	suspension: { kind: "rate_adapted", since_ms: 1, resume_attempts: 0 },
	active_source: {
		input_id: "video1",
		width: 1920,
		height: 1080,
		framerate: 30,
		retimed: true,
		rescaled: true,
	},
});

const STANDBY = encodeState(
	"standby",
	{
		state: "standby",
		live_inputs: [],
		degraded_inputs: [
			{ input_id: "video0", cause: "no_signal" },
			{ input_id: "video1", cause: "no_signal" },
		],
		failover_rate_policy: "retime",
		standby_since_ms: 1,
	},
	[],
);

function publishStatus(): void {
	send({ status: { is_streaming: true, active_encode: activeEncode } });
}

test.describe("Capture failover (functional)", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the live cockpit; mobile/kiosk/RTL are the @visual suite",
		);

		pageWs = null;
		activeEncode = NORMAL;
		setConfigCalls.length = 0;

		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();

			ws.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as {
						id?: string | number;
						path?: unknown;
						input?: Record<string, unknown>;
					};
					const rpc = Array.isArray(frame.path) ? frame.path.join(".") : null;
					if (rpc === "streaming.setConfig") {
						setConfigCalls.push(frame.input ?? {});
						if (frame.id !== undefined) {
							ws.send(
								JSON.stringify({
									id: frame.id,
									result: { success: true, applied: frame.input ?? {} },
								}),
							);
						}
						return;
					}
				} catch {
					/* non-RPC frame */
				}
				server.send(m);
			});

			server.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as { status?: Record<string, unknown> };
					if ("devices" in (frame as object)) return;
					if ("sources" in (frame as object)) return;
					if (frame?.status && typeof frame.status === "object") {
						frame.status.is_streaming = true;
						frame.status.active_encode = activeEncode;
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

		send({
			config: {
				srtla_addr: "127.0.0.1",
				srtla_port: 5000,
				srt_streamid: "e2e",
				max_br: 6000,
				pipeline: "libuvch264",
				source: "video0",
				resolution: "2160p",
				framerate: 60,
				asrc: "Auto",
			},
		});
		send({ sources: { hardware: "rk3588", sources: [MAIN, BACKUP] } });
		publishStatus();
		await expect(page.getByTestId("live-cockpit")).toBeVisible({ timeout: 15_000 });
	});

	test("normal → rate-adapted → standby → normal: bands, chips, and the match action follow the engine", async ({
		page,
	}: {
		page: Page;
	}) => {
		const card = page.getByTestId("live-source-switch");
		await expect(card).toBeVisible();

		// NORMAL: the mode chips name each camera's reported signal, the main
		// camera is affirmed active, and no capture band is on screen.
		await expect(page.getByTestId("source-mode-chip-video0")).toHaveText("2160p60");
		await expect(page.getByTestId("source-mode-chip-video1")).toHaveText("1080p30");
		await expect(page.getByTestId("source-selected-video0")).toBeVisible();
		await expect(page.getByTestId("capture-standby-banner")).toHaveCount(0);
		await expect(page.getByTestId("rate-adapted-banner")).toHaveCount(0);
		await expect(page.getByTestId("source-retimed-indicator")).toHaveCount(0);
		await expect(page.getByTestId("match-camera-action")).toHaveCount(0);

		// DEGRADED: the engine failed over to the slower backup and is repeating
		// frames to keep the operator's 2160p60 — the band names the backup's mode,
		// the active row shows the indicator, and the match action is offered.
		activeEncode = RATE_ADAPTED_RETIMED;
		publishStatus();
		const adapted = page.getByTestId("rate-adapted-banner");
		await expect(adapted).toBeVisible();
		await expect(adapted).toHaveAttribute("role", "status");
		await expect(adapted).toHaveAttribute("data-mode", "1080p30");
		await expect(adapted).toContainText("1080p30");
		await expect(page.getByTestId("source-selected-video1")).toBeVisible();
		await expect(page.getByTestId("source-retimed-indicator")).toBeVisible();
		await expect(page.getByTestId("source-retimed-indicator")).toContainText(
			"Repeating frames",
		);
		await expect(page.getByTestId("active-source-lost-banner")).toHaveCount(0);
		await expect(page.getByTestId("capture-standby-banner")).toHaveCount(0);

		// No engine token or device node reaches the operator.
		for (const token of ["rate_adapted", "/dev/video1", "retime"]) {
			await expect(adapted).not.toContainText(token);
		}

		// STANDBY: every camera is gone. The standby band replaces the source-lost
		// and signal-lost alerts, the standby leg is never a row, and every camera
		// row offers Switch (they all stay rejoinable).
		activeEncode = STANDBY;
		publishStatus();
		const standby = page.getByTestId("capture-standby-banner");
		await expect(standby).toBeVisible();
		await expect(standby).toHaveAttribute("role", "status");
		await expect(standby).toContainText("on standby");
		await expect(page.getByTestId("active-source-lost-banner")).toHaveCount(0);
		await expect(page.getByTestId("video-signal-lost-banner")).toHaveCount(0);
		await expect(page.getByTestId("rate-adapted-banner")).toHaveCount(0);
		await expect(page.getByTestId("match-camera-action")).toHaveCount(0);
		await expect(page.locator('[data-source-switch-row="standby"]')).toHaveCount(0);
		await expect(page.getByTestId("live-summary-strip")).not.toContainText("standby");

		// BACK TO NORMAL: everything clears in one frame.
		activeEncode = NORMAL;
		publishStatus();
		await expect(page.getByTestId("capture-standby-banner")).toHaveCount(0);
		await expect(page.getByTestId("rate-adapted-banner")).toHaveCount(0);
		await expect(page.getByTestId("source-selected-video0")).toBeVisible();
		await expect(page.getByTestId("source-retimed-indicator")).toHaveCount(0);
	});

	test("'Match this camera' confirms first, then saves the backup's mode as an apply-now setConfig", async ({
		page,
	}: {
		page: Page;
	}) => {
		activeEncode = RATE_ADAPTED_RETIMED;
		publishStatus();

		const action = page.getByTestId("match-camera-action");
		await expect(action).toBeVisible();
		const trigger = action.getByRole("button", { name: /Match this camera \(1080p30\)/ });
		await expect(trigger).toBeVisible();
		await trigger.click();

		// The dialog states the reconnect and that the mode becomes the settings;
		// nothing is dispatched until the operator confirms.
		const dialog = page.getByRole("alertdialog");
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText("Match this camera?");
		await expect(dialog).toContainText("reconnects briefly");
		await expect(dialog).toContainText("1080p30");
		expect(setConfigCalls).toHaveLength(0);

		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		expect(setConfigCalls).toHaveLength(0);

		await trigger.click();
		await expect(page.getByRole("alertdialog")).toBeVisible();
		await page
			.getByRole("alertdialog")
			.getByRole("button", { name: "Match camera", exact: true })
			.click();

		await expect.poll(() => setConfigCalls.length, { timeout: 5_000 }).toBe(1);
		expect(setConfigCalls[0]).toMatchObject({
			resolution: "1080p",
			framerate: 30,
			apply_now: true,
		});
		expect(setConfigCalls[0]).not.toHaveProperty("source");
		expect(setConfigCalls[0]).not.toHaveProperty("max_br");
		expect(setConfigCalls[0]).not.toHaveProperty("failover_rate_policy");
	});

	test("under the adapt policy the engine already matched — no indicator, no match action", async ({
		page,
	}: {
		page: Page;
	}) => {
		activeEncode = encodeState("video1", {
			state: "degraded",
			live_inputs: ["video1"],
			degraded_inputs: [{ input_id: "video0", cause: "no_signal" }],
			failover_rate_policy: "adapt",
			suspension: { kind: "rate_adapted", since_ms: 1, resume_attempts: 0 },
			active_source: {
				input_id: "video1",
				width: 1920,
				height: 1080,
				framerate: 30,
				retimed: false,
				rescaled: false,
			},
		});
		publishStatus();

		await expect(page.getByTestId("rate-adapted-banner")).toBeVisible();
		await expect(page.getByTestId("source-selected-video1")).toBeVisible();
		await expect(page.getByTestId("source-retimed-indicator")).toHaveCount(0);
		await expect(page.getByTestId("match-camera-action")).toHaveCount(0);
	});
});
