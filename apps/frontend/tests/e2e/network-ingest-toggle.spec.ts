import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * Network-ingest operator-disable → Live source-list render filter (Task 9).
 *
 * When the operator switches a LAN ingest protocol OFF in Settings, the backend
 * reports that source as available:false with the DISTINCT disabledInSettings
 * reason (T6/T7). Task 9 makes the Live source list HIDE such a row entirely — an
 * off-in-Settings source is not an option — EXCEPT when it IS the selected
 * config.source, where it stays VISIBLE disabled-with-reason so the operator sees
 * why Start is blocked and how to fix it. This spec is the rendered-DOM proof.
 *
 * Mechanism (identical to truthfulness.spec.ts / source-overhaul.spec.ts): the
 * default e2e backend (MOCK_SCENARIO=multi-modem-wifi) does NOT advertise LAN
 * ingest source caps, so the network rows are INJECTED over the page socket via a
 * routeWebSocket proxy that drops the backend's own sources/capabilities echoes.
 * The Settings toggle's broadcast effect (operator_disabled) is modeled by
 * injecting the operator-disabled `sources` frame the real toggle would produce;
 * the Settings dialog is still opened as a real interaction to prove the toggle
 * control that drives this state exists.
 *
 * PLAYBOOK.md compliance: role / testid / web-first assertions only.
 */

let pageWs: WebSocketRoute | null = null;
let dropServerCapabilities = false;
let dropServerSources = false;
// Fake-resolve every streaming.setConfig client-side so a config write is proven
// to succeed without the per-worker backend accepting the injected (backend-unknown)
// source ids.
let fakeSetConfig = false;

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
			...extra,
		},
	});
}

// Full engine caps so the source list renders and the engine/destination gates are
// green — leaving the SOURCE gate the sole thing a disabled ingest can block.
function sendFullCaps(): void {
	send({
		capabilities: {
			platform: {
				supports_h265: true,
				hardware_accelerated: true,
				max_resolution: "2160p",
			},
			encoder: {
				codecs: ["video/x-h264", "video/x-h265"],
				bitrate_range: { min: 2000, max: 12000, unit: "kbps" },
			},
			sources: [],
			transports: ["srtla", "srt"],
			audio_live_switch: true,
			latency_range: { min: 2000, default: 4000, max: 8000 },
		},
	});
}

const SRC_HDMI_CAP: Record<string, unknown> = {
	origin: "capture",
	id: "video-hdmi",
	pipelineId: "hdmi",
	kind: "hdmi",
	displayName: "Rockchip HDMI-RX",
	devicePath: "/dev/video-hdmi",
	modes: [{ width: 1920, height: 1080, framerates: [30, 60] }],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	defaultResolution: "1080p",
	defaultFramerate: 30,
	audioKind: "selectable",
	available: true,
};

function networkSource(active: boolean): Record<string, unknown> {
	return {
		origin: "network",
		id: "rtmp",
		pipelineId: "rtmp",
		labelKey: "settings.sources.rtmp",
		requiresGateway: "rtmp",
		url: active ? "rtmp://192.168.1.100/publish/live" : null,
		modes: [],
		supportsAudio: true,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: "embedded",
		available: active,
		...(active
			? {}
			: { unavailableReason: "live.education.reason.gatewayInactive" }),
	};
}

// The operator-disabled variant: available:false with the DISTINCT disabledInSettings
// reason — the ONLY verdict that HIDES the row.
function networkSourceDisabledInSettings(): Record<string, unknown> {
	return {
		...networkSource(false),
		unavailableReason: "live.education.reason.disabledInSettings",
	};
}

function sendSources(sources: Record<string, unknown>[]): void {
	send({ sources: { hardware: "rk3588", sources } });
}

test.describe("Network-ingest operator-disable hides the Live source row (Task 9)", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the source surface; mobile/kiosk are the @visual suite",
		);

		pageWs = null;
		dropServerCapabilities = true;
		dropServerSources = true;
		fakeSetConfig = false;

		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();

			ws.onMessage((m) => {
				if (fakeSetConfig) {
					const text = typeof m === "string" ? m : m.toString();
					try {
						const frame = JSON.parse(text) as {
							id?: string | number;
							path?: unknown;
							input?: Record<string, unknown>;
						};
						const rpc = Array.isArray(frame.path) ? frame.path.join(".") : null;
						if (rpc === "streaming.setConfig" && frame.id !== undefined) {
							ws.send(
								JSON.stringify({
									id: frame.id,
									result: { success: true, applied: frame.input ?? {} },
								}),
							);
							return;
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
					const frame = JSON.parse(text) as object;
					if (dropServerCapabilities && "capabilities" in frame) return;
					if (dropServerSources && "sources" in frame) return;
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

	async function openNetworkIngestDialog(page: Page): Promise<void> {
		await navigateTo(page, "settings");
		await page
			.getByRole("button", { name: /^Sources/i })
			.first()
			.click();
		await expect(
			page.getByRole("dialog", { name: "Sources" }),
		).toBeVisible();
	}

	test("toggling RTMP off hides its Live source row; toggling on restores it", async ({
		page,
	}) => {
		serverConfig();
		sendFullCaps();
		// Enabled rtmp ingest → a selectable network row alongside a capture source.
		sendSources([SRC_HDMI_CAP, networkSource(true)]);

		const rtmpRow = page.getByTestId("source-network-ingest-select-rtmp");
		await expect(rtmpRow).toBeVisible({ timeout: 15_000 });
		await expect(rtmpRow).toBeEnabled();

		// The Settings toggle that produces the disabled state is a real control.
		await openNetworkIngestDialog(page);
		await expect(page.getByTestId("network-ingest-toggle-rtmp")).toBeVisible();
		await page.keyboard.press("Escape");

		// Operator disables rtmp (Settings toggle OFF) → the backend reports it
		// operator_disabled; the Live row DISAPPEARS from the picker entirely.
		await navigateTo(page, "live");
		sendSources([SRC_HDMI_CAP, networkSourceDisabledInSettings()]);
		await expect(
			page.getByTestId("source-network-ingest-select-rtmp"),
		).toHaveCount(0);
		await expect(page.getByTestId("source-row-rtmp")).toHaveCount(0);
		// The capture source is unaffected — the filter is scoped to the disabled row.
		await expect(page.getByTestId("source-select-video-hdmi")).toBeVisible();

		// Operator re-enables rtmp → the row RETURNS, selectable.
		sendSources([SRC_HDMI_CAP, networkSource(true)]);
		await expect(
			page.getByTestId("source-network-ingest-select-rtmp"),
		).toBeEnabled();
	});

	test("a SELECTED rtmp source that is disabled stays visible disabled-with-reason and blocks Start", async ({
		page,
	}) => {
		fakeSetConfig = true;
		// rtmp is the selected source AND it is operator-disabled: the row must NOT
		// vanish (that would strand the operator on an unknown source) — it stays
		// visible disabled-with-reason plus a Settings hint.
		serverConfig({ source: "rtmp" });
		sendFullCaps();
		sendSources([SRC_HDMI_CAP, networkSourceDisabledInSettings()]);

		const rtmpRow = page.getByTestId("source-network-ingest-select-rtmp");
		await expect(rtmpRow).toBeVisible({ timeout: 15_000 });
		await expect(rtmpRow).toBeDisabled();
		await expect(rtmpRow).toHaveAttribute("title", /\S/);
		await expect(
			page.getByTestId("source-network-ingest-reason-rtmp"),
		).toBeVisible();
		await expect(
			page.getByTestId("source-network-ingest-settings-hint-rtmp"),
		).toBeVisible();

		// The setup-chain source gate surfaces the SAME disabledInSettings reason and
		// Start is blocked — never a dead-end unknown-source.
		await expect(
			page.getByTestId("setup-row-reason").filter({ hasText: /disabled in settings/i }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /start stream/i }),
		).toBeDisabled();
	});
});
