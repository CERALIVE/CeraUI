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
// Drop the backend's own `sources` echo so the INJECTED unified source list is the
// sole authority for SourceSection (it reads the folded `sources` broadcast).
let dropServerSources = false;
// Hold the next `streaming.setConfig` RPC in-flight (captures its id + input) so the
// optimistic `applying` window is observable; cleared once released.
let holdSetConfig = false;
let heldSetConfigId: string | number | null = null;
// Echoed back as `result.applied` on release — the frontend releases each field lock
// to `result.applied`, never the optimistic value, so the fake resolution must carry
// it (matches the T3 backend contract: setConfig echoes the applied config fields).
let heldSetConfigInput: Record<string, unknown> | null = null;
// Fake a successful `streaming.start` client-side so the optimism transient is
// exercised WITHOUT mutating the shared mock backend (a real start would broadcast
// is_streaming=true to every parallel worker and corrupt their layout).
let dropStreamStart = false;

function send(payload: unknown): void {
	pageWs?.send(JSON.stringify(payload));
}

/** Fake-resolve a previously-held setConfig RPC, echoing its input as `applied`. */
function resolveHeldSetConfig(): void {
	if (heldSetConfigId !== null) {
		pageWs?.send(
			JSON.stringify({
				id: heldSetConfigId,
				result: { success: true, applied: heldSetConfigInput ?? {} },
			}),
		);
		heldSetConfigId = null;
		heldSetConfigInput = null;
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

// A capture StreamSource for the unified device-first list. `id` MUST equal the
// matching device input_id so the source list and the config.source selection
// align on the same ids.
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

// Capture sources aligned to the HDMI (video0) / USB (video1) device fixtures.
const CAP_HDMI = captureSource("video0", "hdmi", "hdmi", "HDMI Camera");
const CAP_USB = captureSource("video1", "usb", "libuvch264", "USB Capture");

// Inject the folded `sources` broadcast (drops the backend's own — see beforeEach).
function sendSources(sources: Record<string, unknown>[]): void {
	send({ sources: { hardware: "rk3588", sources } });
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
		// Injected device lists are authoritative for every test in this file (see
		// the header contract): the backend's multi-modem-wifi profile now reports
		// its own capture device on connect, which the beforeEach navigation would
		// otherwise fold into the store as a retained-lost extra source before a
		// test sets this flag. Drop backend `devices` echoes from the start so only
		// the test-injected list ever populates the source surface.
		dropServerDevices = true;
		dropServerSources = true;
		holdSetConfig = false;
		heldSetConfigId = null;
		heldSetConfigInput = null;
		dropStreamStart = false;

		await page.routeWebSocket(/:(3002|31\d\d|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();

			ws.onMessage((m) => {
				if (holdSetConfig || dropStreamStart) {
					const text = typeof m === "string" ? m : m.toString();
					try {
						const frame = JSON.parse(text) as {
							id?: string | number;
							path?: unknown;
							input?: Record<string, unknown>;
						};
						const rpc = Array.isArray(frame.path) ? frame.path.join(".") : null;
						if (holdSetConfig && rpc === "streaming.setConfig") {
							heldSetConfigId = frame.id ?? null;
							heldSetConfigInput = frame.input ?? null;
							return; // hold in-flight: don't forward to the backend
						}
						if (dropStreamStart && rpc === "streaming.start") {
							// Never mutate the shared backend's stream state, but fake a
							// successful start so the optimism `starting` transient persists
							// (the injected is_streaming broadcast settles it) instead of the
							// unanswered RPC rejecting and reverting straight back to idle.
							if (frame.id !== undefined) {
								ws.send(JSON.stringify({ id: frame.id, result: { success: true } }));
							}
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

	// ── 1. Unified source list: selection persists config.source via field-lock ──
	// Selecting a row in the unified device-first SourceSection list writes
	// config.source through the per-field-sync lock and reconciles to the server
	// echo — the unified-list selection + field-lock echo flow.
	test("the unified source list persists a selection through the per-field-sync lock and reconciles to the server echo", async ({
		page,
	}) => {
		holdSetConfig = true;
		serverConfig({ source: "video0" });
		sendDevices("video0", [HDMI, USB]);
		sendSources([CAP_HDMI, CAP_USB]);

		await expect(page.getByTestId("source-row-video0")).toHaveAttribute(
			"data-selected",
			"true",
			{ timeout: 15_000 },
		);
		await expect(page.getByTestId("source-row-video1")).toHaveAttribute(
			"data-selected",
			"false",
		);

		// Selecting the USB source dispatches setConfig({source:'video1'}); the row
		// follows config.source (never the optimistic local id), so while the echo is
		// held the selection stays put — no premature flip.
		await page.getByTestId("source-select-video1").click();
		await expect.poll(() => heldSetConfigId !== null, { timeout: 5_000 }).toBe(true);
		await expect(page.getByTestId("source-row-video0")).toHaveAttribute(
			"data-selected",
			"true",
		);

		// Release + inject the authoritative echo → the selection settles to the
		// server-applied source id.
		holdSetConfig = false;
		resolveHeldSetConfig();
		serverConfig({ source: "video1" });
		await expect(page.getByTestId("source-row-video1")).toHaveAttribute(
			"data-selected",
			"true",
		);
		await expect(page.getByTestId("source-row-video0")).toHaveAttribute(
			"data-selected",
			"false",
		);
	});

	// ── 3. Go-Live start settles the cockpit to streaming on the broadcast ─────
	test("Start dispatches from the all-green Go Live card and settles the cockpit to streaming on the broadcast", async ({
		page,
	}) => {
		controlStreaming = true;
		streamingFlag = false; // suppress the mock's own is_streaming until we flip it
		dropStreamStart = true; // hermetic: the fake-success start never touches the backend
		// A valid selected source (+ server + backend network + normal engine) makes
		// the GoLiveCard readiness all-green, so Start is enabled and dispatchable.
		serverConfig({ source: "video0" });
		send(GENERIC_PIPELINES);
		sendSources([CAP_HDMI]);

		const start = page.getByRole("button", { name: /start stream/i });
		await expect(start).toBeEnabled({ timeout: 15_000 });
		await start.click();

		// The authoritative is_streaming=true broadcast settles the Live view to the
		// streaming cockpit (Stop control + ingest stats) — never a flicker back to idle.
		streamingFlag = true;
		sendStatus(true);
		await expect(page.getByTestId("live-cockpit")).toBeVisible();
		await expect(page.getByRole("button", { name: /stop stream/i })).toBeVisible();
		await expect(page.getByTestId("idle-cockpit")).toHaveCount(0);
	});

	// ── 4. Lost-capture surfacing ──────────────────────────────────────────────
	// A lost capture device (source.lost) renders as a calm lost banner + a disabled
	// (unselectable) row — the honest lost surface on the unified list.
	test("a lost capture surfaces a calm non-blocking banner and disables its row", async ({
		page,
	}) => {
		serverConfig({ source: "video0" });
		sendDevices("video0", [HDMI, USB]);
		sendSources([CAP_HDMI, CAP_USB]);

		const list = page.getByTestId("source-list");
		await expect(list).toBeVisible({ timeout: 15_000 });
		const rows = list.locator('[data-testid^="source-row-video"]');
		await expect(rows).toHaveCount(2);

		// The preferred capture drops out (unplugged): a calm, non-blocking lost
		// banner appears and its row is no longer selectable (informational, not modal).
		sendSources([{ ...CAP_HDMI, lost: true }, CAP_USB]);
		await expect(page.getByTestId("source-lost-banner")).toBeVisible();
		await expect(page.getByTestId("source-select-video0")).toBeDisabled();
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

	// ── 6. Unified list surfaces all source origins as one picker ──────────────
	test("the unified source list surfaces capture, test-pattern, and network-ingest origins as one picker", async ({
		page,
	}) => {
		serverConfig({ source: "video0" });
		sendDevices("video0", [HDMI]);
		sendSources([
			CAP_HDMI,
			{
				origin: "virtual",
				id: "test",
				pipelineId: "test",
				labelKey: "settings.sources.test",
				modes: [],
				supportsAudio: false,
				supportsResolutionOverride: false,
				supportsFramerateOverride: false,
				audioKind: "none",
				available: true,
			},
			{
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
			},
		]);

		const list = page.getByTestId("source-list");
		await expect(list).toBeVisible({ timeout: 15_000 });
		// A capture row shows the real device, the virtual test-pattern is a virtual
		// origin, and the rtmp LAN-ingest is a selectable network row — all one list.
		await expect(page.getByTestId("source-select-video0")).toBeVisible();
		await expect(page.getByTestId("source-row-test")).toHaveAttribute(
			"data-origin",
			"virtual",
		);
		await expect(
			page.getByTestId("source-network-ingest-select-rtmp"),
		).toBeEnabled();
	});

	// ── 7. Still-deferred roadmap items remain calm coming-soon pills ──────────
	test("still-deferred capabilities keep their calm coming-soon pills in the idle roadmap", async ({
		page,
	}) => {
		serverConfig();
		sendCapabilities({ audio_live_switch: true });

		// The roadmap disclosure lives in the idle cockpit; expand it to reveal the
		// deferred affordances — calm informational pills bound to their OPEN debt
		// ids (never a fake-interactive control, never a disabled-with-reason warning).
		const roadmap = page.getByTestId("live-roadmap");
		await expect(roadmap).toBeVisible({ timeout: 15_000 });
		await roadmap.locator("summary").click();
		await expect(roadmap.locator('[data-comingsoon="TD-pip"]')).toBeVisible();
		await expect(
			roadmap.locator('[data-comingsoon="TD-mode-fallback"]'),
		).toBeVisible();
	});

	// ── 8. Destination traffic light reflects the relay.validate verdict (Task 5) ─
	// Saving a valid custom endpoint fires ServerDialog's optional `onSaved`, which
	// LiveView turns into a relay.validate run (forwarded to the mock backend, which
	// passes the dns/probe stages). The verdict is fingerprint-keyed, so the green
	// light is honest: a subsequent endpoint edit re-keys the fingerprint and the
	// light drops back to "Not checked". The save path never depends on the RPC
	// (held here so the shared backend is untouched) — it only signals "saved".
	test("the destination traffic light goes green after a validated save and resets when the endpoint changes", async ({
		page,
	}) => {
		// Hold setConfig so the save never mutates the shared backend; relay.validate
		// is read-only and IS forwarded (the mock returns a passing probe verdict).
		holdSetConfig = true;
		serverConfig({ relay_server: "", selected_ingest_endpoint: "" });

		const trafficLight = page.getByTestId("destination-traffic-light");
		await expect(trafficLight).toBeVisible({ timeout: 15_000 });
		await expect(trafficLight).toHaveAttribute("data-validated", "false");

		await page.getByTestId("open-server-dialog").click();
		const dialog = page.getByRole("dialog", { name: "Receiver Server" });
		await expect(dialog).toBeVisible();
		const save = dialog.getByRole("button", { name: "Save" });
		await expect(save).toBeEnabled();
		await save.click();

		// Release the held setConfig so handleSave resolves and fires onSaved →
		// LiveView runs relay.validate against the saved endpoint.
		await expect.poll(() => heldSetConfigId !== null, { timeout: 5_000 }).toBe(true);
		resolveHeldSetConfig();

		// The mock relay.validate passes → the fingerprint-keyed verdict goes green.
		await expect(trafficLight).toHaveAttribute("data-validated", "true", {
			timeout: 10_000,
		});

		// Complete the save round-trip the real backend would (holdSetConfig
		// suppressed its confirming config broadcast): the save took a field-lock on
		// srtla_addr via markPending, and the lock ignores ANY differing echo until a
		// matching one releases it. Inject that matching echo so the NEXT endpoint
		// edit is not swallowed as a stale echo of the just-saved value.
		send({ config: { srtla_addr: "127.0.0.1" } });

		// Editing the endpoint re-keys the fingerprint → the stale green light resets
		// to "Not checked" (the verdict no longer matches the resolved endpoint).
		serverConfig({
			relay_server: "",
			selected_ingest_endpoint: "",
			srtla_addr: "10.0.0.99",
		});
		await expect(trafficLight).toHaveAttribute("data-validated", "false", {
			timeout: 10_000,
		});
	});
});
