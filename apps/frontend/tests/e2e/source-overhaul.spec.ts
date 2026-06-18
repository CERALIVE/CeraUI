import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * Track-1 source-experience overhaul — FUNCTIONAL e2e gate (Task 15).
 *
 * Screenshot-free behavioural proof of the overhauled Live source surface,
 * driven against the REAL frontend + dev mock backend. Every snapshot the spec
 * needs (config / pipelines / devices / capabilities / status) is injected over
 * the page's own authenticated socket through a `routeWebSocket` proxy, so each
 * scenario is deterministic without a `dev.emit` route or any sleep-race:
 *
 *   • the proxy forwards auth + RPC traffic to the real backend untouched;
 *   • it can DROP the backend's own `devices` echoes so an injected device list
 *     is authoritative;
 *   • it can REWRITE incoming `status.is_streaming` to a test-owned flag so the
 *     stream-start optimism transient is observable (the mock would otherwise
 *     settle it before the assertion runs);
 *   • it can HOLD a `streaming.setConfig` RPC in-flight so the per-field
 *     `applying` indicator is observable, then fake-resolve it + inject the echo.
 *
 * Coverage (the Track-1 mergeability gate):
 *   1. mode-preset selection seeds the Advanced fields + unsupported preset is
 *      disabled-with-reason (never hidden);
 *   2. capability gate — the audio live-switch dispatch is blocked while the flag
 *      is absent and becomes live once the mock advertises `audio_live_switch`;
 *   3. native-feel optimism — the per-field `applying` indicator holds through a
 *      delayed WS echo with no flicker;
 *   4. `is_streaming` optimism — Start shows the transient `starting` state and
 *      settles to streaming on the authoritative broadcast;
 *   5. source-priority reorder (up/down) + the sticky auto-failover toast;
 *   6. education popovers + the calm capability-tier banners.
 *
 * Assertions follow PLAYBOOK.md: role / testid / web-first only. No pixel
 * captures and no fixed sleeps — pixel evidence lives in the `*.visual.spec.ts`
 * suite (excluded from this gate) and timing is gated on DOM signals only.
 */

// ── Test-owned proxy control state (reset per test in beforeEach) ────────────
let pageWs: WebSocketRoute | null = null;
// When true, every incoming `status` frame's is_streaming is rewritten to the
// flag below — so the mock's own broadcast can't settle the optimism early.
let controlStreaming = false;
let streamingFlag = false;
// Drop the backend's `devices` echoes so an injected device list wins.
let dropServerDevices = false;
// Hold the next `streaming.setConfig` RPC in-flight (captures its id) so the
// optimistic `applying` window is observable; cleared once released.
let holdSetConfig = false;
let heldSetConfigId: string | number | null = null;
// Drop `streaming.start` client-side so the optimism transient is exercised
// WITHOUT mutating the shared mock backend (a real start would broadcast
// is_streaming=true to every parallel worker and corrupt their layout).
let dropStreamStart = false;
// Hold the next `streaming.switchAudio` RPC in-flight (captures its id) so the
// per-field `applying` window is observable; cleared once released. The audio
// switch never reaches the shared mock backend — the proxy owns its result.
let holdSwitchAudio = false;
let heldSwitchAudioId: string | number | null = null;
let heldSwitchAudioInput: string | null = null;

function send(payload: unknown): void {
	pageWs?.send(JSON.stringify(payload));
}

/** Fake-resolve a previously-held setConfig RPC ({success:true}, no clamp). */
function resolveHeldSetConfig(): void {
	if (heldSetConfigId !== null) {
		pageWs?.send(JSON.stringify({ id: heldSetConfigId, result: { success: true } }));
		heldSetConfigId = null;
	}
}

/** Fake-resolve a held switchAudio RPC as a successful gapless switch. */
function resolveHeldSwitchAudio(gapMs: number): void {
	if (heldSwitchAudioId !== null) {
		pageWs?.send(
			JSON.stringify({
				id: heldSwitchAudioId,
				result: {
					success: true,
					active_audio_input: heldSwitchAudioInput ?? "audio:mic0",
					gap_ms: gapMs,
				},
			}),
		);
		heldSwitchAudioId = null;
		heldSwitchAudioInput = null;
	}
}

// A configured server keeps LiveView out of its empty state so the source
// surface + config rows render; a known pipeline makes the Start gate pass.
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

// Deterministic single-source-with-overrides board fixture (software/generic,
// 1080p ceiling) — the same shape the dev `pipelines` broadcast carries.
const GENERIC_PIPELINES = {
	pipelines: {
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
	},
};

type Device = {
	input_id: string;
	device_path: string;
	display_name: string;
	media_class: "video" | "audio";
	kind: string;
	lost?: boolean;
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
const MIC: Device = {
	input_id: "audio:mic0",
	device_path: "hw:1,0",
	display_name: "USB Microphone",
	media_class: "audio",
	kind: "audio",
};

function sendDevices(activeInput: string, devices: Device[]): void {
	send({ devices: { engine: "cerastream", active_input: activeInput, devices } });
}

// A schema-valid capabilities snapshot; `extra` raises the tier/flag under test.
function sendCapabilities(extra: Record<string, unknown> = {}): void {
	send({
		capabilities: {
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
			...extra,
		},
	});
}

function sendStatus(isStreaming: boolean): void {
	send({ status: { is_streaming: isStreaming } });
}

test.describe("Track-1 source overhaul (functional)", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the source overhaul; mobile/kiosk/RTL are the @visual suite",
		);

		pageWs = null;
		controlStreaming = false;
		streamingFlag = false;
		dropServerDevices = false;
		holdSetConfig = false;
		heldSetConfigId = null;
		dropStreamStart = false;
		holdSwitchAudio = false;
		heldSwitchAudioId = null;
		heldSwitchAudioInput = null;

		await page.routeWebSocket(/:(3002|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();

			ws.onMessage((m) => {
				if (holdSetConfig || dropStreamStart || holdSwitchAudio) {
					const text = typeof m === "string" ? m : m.toString();
					try {
						const frame = JSON.parse(text) as {
							id?: string | number;
							path?: unknown;
							input?: { audio_input_id?: string };
						};
						const rpc = Array.isArray(frame.path) ? frame.path.join(".") : null;
						if (holdSetConfig && rpc === "streaming.setConfig") {
							heldSetConfigId = frame.id ?? null;
							return; // hold in-flight: don't forward to the backend
						}
						if (holdSwitchAudio && rpc === "streaming.switchAudio") {
							heldSwitchAudioId = frame.id ?? null;
							heldSwitchAudioInput = frame.input?.audio_input_id ?? null;
							return; // hold in-flight: the proxy owns the audio-switch result
						}
						if (dropStreamStart && rpc === "streaming.start") {
							return; // never mutate the shared backend's stream state
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

	// ── 1. Mode-preset selection seeds Advanced + unsupported is disabled ──────
	test("a mode preset seeds the Advanced fields; an unsupported preset is disabled with a reason", async ({
		page,
	}) => {
		serverConfig();
		send(GENERIC_PIPELINES);

		const trigger = page.getByTestId("open-encoder-dialog");
		await expect(trigger).toBeVisible({ timeout: 15_000 });
		await trigger.click();

		const dialog = page.getByRole("dialog", { name: "Encoder Settings" });
		await expect(dialog).toBeVisible();

		// The 4K / H.265 preset is above the generic 1080p ceiling → rendered
		// DISABLED with aria-disabled + a reason tooltip, never hidden.
		const fourK = dialog.locator(
			'[data-testid="mode-preset"][data-preset-id="4k30-h265"]',
		);
		await expect(fourK).toBeVisible();
		await expect(fourK).toBeDisabled();
		await expect(fourK).toHaveAttribute("aria-disabled", "true");
		await expect(fourK).toHaveAttribute("data-supported", "false");
		await expect(fourK).toHaveAttribute("title", /not supported/i);

		// A universal 1080p60 H.264 preset is offered — apply it.
		const preset = dialog.locator(
			'[data-testid="mode-preset"][data-preset-id="1080p60-h264"]',
		);
		await expect(preset).toBeEnabled();
		await preset.click();
		await expect(preset).toHaveAttribute("data-active", "true");

		// Selecting it seeds the granular Advanced controls — open the expander
		// and confirm the resolution/framerate/bitrate now reflect the preset.
		await dialog.getByTestId("encoder-advanced-summary").click();
		await expect(dialog.locator("#encoder-resolution")).toContainText("1080");
		await expect(dialog.locator("#encoder-framerate")).toContainText("60");
		await expect(dialog.locator("#encoder-bitrate")).toHaveValue("6000");
	});

	// ── 2. Capability gate: live-audio dispatch gated off ⇄ enabled by flag ────
	test("the audio live-switch dispatch is gated off until the engine advertises audio_live_switch", async ({
		page,
	}) => {
		controlStreaming = true;
		streamingFlag = true;
		dropServerDevices = true;
		// Capture any dispatched switchAudio so we can prove NONE escapes the
		// frontend gate while the capability is absent.
		holdSwitchAudio = true;

		serverConfig();
		sendCapabilities(); // no audio_live_switch → gate off
		sendStatus(true);
		sendDevices("video0", [HDMI, MIC]);

		const picker = page.getByTestId("input-picker");
		await expect(picker).toBeVisible({ timeout: 15_000 });

		// TD-live-audio-switch is resolved (Task 26): the coming-soon affordance is
		// gone — the audio source always renders a real Switch control while
		// streaming, never a `data-audio-switch-deferred` pill.
		const audioSwitch = picker.locator('[data-switch-input="audio:mic0"]');
		await expect(audioSwitch).toBeVisible();
		await expect(
			picker.locator('[data-audio-switch-deferred="audio:mic0"]'),
		).toHaveCount(0);

		// Capability absent → the frontend gate (canLiveSwitchInput) blocks the
		// dispatch: clicking raises NO applying indicator and the switchAudio RPC
		// is never sent (the proxy never captures it). The blocked path returns
		// synchronously before any await, so this read is race-free post-click.
		await audioSwitch.click();
		await expect(page.getByText(/switching audio/i)).toHaveCount(0);
		expect(heldSwitchAudioId).toBeNull();

		// Engine now advertises the capability → the SAME control becomes live: a
		// click dispatches switchAudio and surfaces the per-field applying glyph.
		sendCapabilities({ audio_live_switch: true });
		await audioSwitch.click();
		await expect(page.getByText(/switching audio/i)).toBeVisible();
		expect(heldSwitchAudioId).not.toBeNull();

		// Release the held RPC as a successful gapless switch → applied + gap toast.
		holdSwitchAudio = false;
		resolveHeldSwitchAudio(12);
		await expect(page.getByText(/audio switched/i).first()).toBeVisible();
	});

	// ── 3. Native-feel optimism: applying indicator holds through a delayed echo ─
	test("the per-field applying indicator holds through a delayed WS echo with no flicker", async ({
		page,
	}) => {
		dropServerDevices = true;
		serverConfig({ source_preference: ["video0", "video1"] });
		sendDevices("video0", [HDMI, USB]);

		const panel = page.getByTestId("source-preference");
		await expect(panel).toBeVisible({ timeout: 15_000 });
		await expect(panel.locator('[data-input-id="video0"]')).toHaveAttribute(
			"data-state",
			"active",
		);

		// Hold the reorder's setConfig in-flight so the `applying` phase is stable.
		holdSetConfig = true;
		await panel.locator('[data-move-down="video0"]').click();

		// The per-field sync indicator shows the in-flight `applying` state and the
		// list does NOT flicker its order while the echo is outstanding.
		await expect(page.getByText(/saving order/i)).toBeVisible();
		await expect(panel.locator('[data-input-id="video0"]')).toHaveAttribute(
			"data-state",
			"active",
		);

		// Release: fake-resolve the RPC, then inject the authoritative echo with the
		// new order. The list settles to the new order — no revert/flicker.
		holdSetConfig = false;
		resolveHeldSetConfig();
		serverConfig({ source_preference: ["video1", "video0"] });

		const rows = panel.locator("[data-input-id]");
		await expect(rows.first()).toHaveAttribute("data-input-id", "video1");
		await expect(page.getByText(/saving order/i)).toHaveCount(0);
	});

	// ── 4. is_streaming optimism: Start → starting → settles on broadcast ──────
	test("Start shows the transient starting state and settles to streaming on the broadcast", async ({
		page,
	}) => {
		controlStreaming = true;
		streamingFlag = false; // suppress the mock's own is_streaming until we flip it
		dropStreamStart = true; // hermetic: the click drives optimism, not the backend
		serverConfig();
		send(GENERIC_PIPELINES);

		const start = page.getByRole("button", { name: /start stream/i });
		await expect(start).toBeEnabled({ timeout: 15_000 });
		await start.click();

		// Optimistic transient: the control disables itself the instant intent is
		// registered (the `starting` spinner), before any authoritative broadcast.
		await expect(start).toBeDisabled();

		// Authoritative is_streaming=true → the control settles to Stop.
		streamingFlag = true;
		sendStatus(true);
		await expect(page.getByRole("button", { name: /stop stream/i })).toBeVisible();
	});

	// ── 5. Source-priority reorder + sticky auto-failover toast ────────────────
	test("source priority reorders via up/down and a sticky failover raises a non-blocking toast", async ({
		page,
	}) => {
		dropServerDevices = true;
		// Hold every reorder setConfig so the backend never persists; the injected
		// config echo is the sole authority on the displayed order.
		holdSetConfig = true;
		serverConfig({ source_preference: ["video0", "video1"] });
		sendDevices("video0", [HDMI, USB]);

		const panel = page.getByTestId("source-preference");
		await expect(panel).toBeVisible({ timeout: 15_000 });
		await expect(panel.locator("[data-input-id]")).toHaveCount(2);

		// Reorder via the keyboard/touch-safe up/down controls (no drag): moving
		// USB up persists [video1, video0]; fake-resolve + inject the echo.
		await panel.locator('[data-move-up="video1"]').click();
		resolveHeldSetConfig();
		serverConfig({ source_preference: ["video1", "video0"] });
		await expect(panel.locator("[data-input-id]").first()).toHaveAttribute(
			"data-input-id",
			"video1",
		);

		// Restore the preferred-first order, then drop the preferred source: the
		// engine sticks on the fallback → lost + failed-over states + a calm toast.
		serverConfig({ source_preference: ["video0", "video1"] });
		await expect(panel.locator("[data-input-id]").first()).toHaveAttribute(
			"data-input-id",
			"video0",
		);
		sendDevices("video1", [{ ...HDMI, lost: true }, USB]);

		await expect(panel.locator('[data-input-id="video0"]')).toHaveAttribute(
			"data-state",
			"lost",
		);
		await expect(panel.locator('[data-input-id="video1"]')).toHaveAttribute(
			"data-state",
			"failed-over",
		);
		// Non-blocking toast names the lost source — it is informational, not modal.
		await expect(page.getByText(/HDMI Camera/).first()).toBeVisible();
	});

	// ── 6. Education popovers + calm capability-tier banners ───────────────────
	test("the source info popover explains the field and the capability tiers render calmly", async ({
		page,
	}) => {
		serverConfig();

		// Per-field "?" info popover opens with the plain-language explanation.
		const info = page.getByTestId("info-source");
		await expect(info).toBeVisible({ timeout: 15_000 });
		await info.click();
		await expect(
			page.getByText("Where the encoder pulls video from", { exact: false }),
		).toBeVisible();

		// engineStarting → calm role="status" banner (not an error toast).
		sendCapabilities({ engineStarting: true });
		await expect(page.getByTestId("capability-engine-starting")).toBeVisible();

		// engineUnavailable takes priority → its calm banner replaces the starting one.
		sendCapabilities({ engineUnavailable: true });
		await expect(page.getByTestId("capability-engine-unavailable")).toBeVisible();
		await expect(page.getByTestId("capability-engine-starting")).toHaveCount(0);
	});

	// ── 7. Live audio switch (Task 25): applying → applied + gap toast ─────────
	test("a live audio source switch succeeds, shows applying then applied, and raises a gap toast", async ({
		page,
	}) => {
		controlStreaming = true;
		streamingFlag = true;
		dropServerDevices = true;
		// Hold the switchAudio RPC so the per-field `applying` glyph is observable;
		// the proxy resolves it as a successful gapless switch (no DeviceNotFound).
		holdSwitchAudio = true;

		serverConfig();
		sendCapabilities({ audio_live_switch: true });
		sendStatus(true);
		sendDevices("video0", [HDMI, MIC]);

		const picker = page.getByTestId("input-picker");
		await expect(picker).toBeVisible({ timeout: 15_000 });

		// With the capability advertised the audio source is a real, enabled live
		// Switch control — never the coming-soon affordance.
		const audioSwitch = picker.locator('[data-switch-input="audio:mic0"]');
		await expect(audioSwitch).toBeVisible();
		await expect(
			picker.locator('[data-audio-switch-deferred="audio:mic0"]'),
		).toHaveCount(0);

		await audioSwitch.click();

		// The Task-5 field-sync indicator shows the in-flight `applying` phase.
		await expect(page.getByText(/switching audio/i)).toBeVisible();

		// Release the held RPC as a successful 18 ms gapless switch.
		holdSwitchAudio = false;
		resolveHeldSwitchAudio(18);

		// applied phase glyph + the non-blocking informational gap toast.
		await expect(page.getByText(/audio switched/i).first()).toBeVisible();
		// No DeviceNotFound / failure surface appeared.
		await expect(page.getByText(/audio switch failed/i)).toHaveCount(0);
		await expect(page.getByText(/audio source unavailable/i)).toHaveCount(0);
	});

	// ── 8. Still-deferred roadmap items remain coming-soon ─────────────────────
	test("a still-deferred capability keeps its coming-soon affordance even when audio live-switch is on", async ({
		page,
	}) => {
		controlStreaming = true;
		streamingFlag = true;
		dropServerDevices = true;

		serverConfig();
		// Audio live-switch is advertised, but the mode-fallback / PiP roadmap
		// items have no capability flag → they MUST stay coming-soon (G2).
		sendCapabilities({ audio_live_switch: true });
		sendStatus(true);
		sendDevices("video0", [HDMI, MIC]);

		const roadmap = page.getByTestId("live-roadmap");
		await expect(roadmap).toBeVisible({ timeout: 15_000 });

		// The deferred roadmap affordances are still bound to their OPEN debt ids.
		await expect(roadmap.locator('[data-comingsoon="TD-pip"]')).toBeVisible();
		await expect(
			roadmap.locator('[data-comingsoon="TD-mode-fallback"]'),
		).toBeVisible();

		// And the audio source is NOT coming-soon — it is a live Switch control.
		const picker = page.getByTestId("input-picker");
		await expect(picker.locator('[data-switch-input="audio:mic0"]')).toBeVisible();
		await expect(
			picker.locator('[data-audio-switch-deferred="audio:mic0"]'),
		).toHaveCount(0);
	});
});
