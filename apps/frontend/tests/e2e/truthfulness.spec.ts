import fs from "node:fs";
import path from "node:path";

import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import {
	BT_ADAPTER_PATH,
	btMicPairedStatus,
	type WireDevice,
	type WireStatus,
} from "./helpers/bluetooth-wire.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";
import { openModemAdvanced } from "./helpers/modem-advanced.js";

/**
 * Capability-truthfulness regression gate (Task 20, ceraui-trustworthy-experience).
 *
 * The whole "trustworthy experience" plan rests on ONE promise: the UI never
 * lies about what the device can do. Every capability-dependent control either
 * (a) is enabled and actionable, or (b) is disabled/coming-soon WITH a
 * non-empty, human-readable reason — never a silent dead control, never a
 * fake-interactive one, and never a control that dispatches an RPC that doesn't
 * exist. This spec is the rendered-DOM proof of that promise.
 *
 * It complements the unit suites (`capability-tier.test.ts`,
 * `pipelineAvailability.test.ts`, `receiver-experience.test.ts`,
 * `liveAudioSwitch`) and the STATIC CI gate `scripts/check-tech-debt.mjs` by
 * asserting the SAME truths against the real Svelte app + dev mock backend.
 *
 * Mechanism (identical to `source-overhaul.spec.ts` — do NOT invent a new one):
 * every capability/status snapshot is injected over the page's own
 * authenticated socket through a `routeWebSocket` proxy. There is exactly ONE
 * backend per worker (the `workerBackend` fixture, `MOCK_SCENARIO` is fixed at
 * boot — never switched per-test); the proxy makes the *injected* frames
 * authoritative by dropping the backend's own `capabilities`/`devices` echoes,
 * so all three capability snapshots (full caps / engine-starting floor /
 * engine-unavailable cached) are exercised WITHIN one run against one boot.
 *
 * Assertions, mapped to the task's acceptance criteria:
 *   (a) every capability-dependent control (H.265 codec, audio live-switch,
 *       latency slider bounds, network-ingest rows, RIST/SRT transport pills)
 *       flips enabled ⇄ disabled-with-reason as the injected caps change, and
 *       every disabled control carries a NON-EMPTY title/reason;
 *   (b) every `[data-debt-id]` in the rendered DOM maps to an `open` entry in
 *       docs/TECHNICAL_DEBT.md — parsed here with the SAME id-regex the static
 *       gate uses, so this rendered-DOM check stays consistent with CI;
 *   (c) a click-walk of primary Live/Network/Settings controls raises no
 *       console error / unhandled rejection (no enabled control dispatches an
 *       undefined RPC).
 *
 * Plus a NEGATIVE FIXTURE ("the debt-id cross-check catches an orphan") that
 * injects a controlled orphan `data-debt-id` node and proves the SAME check
 * that powers assertion (b) flags it — so (b) is not vacuous.
 *
 * The `dynamic-wifi-bt-foundation` effort extends the SAME three assertions over
 * the Network destination's radios, because a capability-driven Wi-Fi/Bluetooth
 * surface can lie in exactly the ways this file already gates against. Four
 * capability snapshots are walked — `wifi6` (the board-captured Rock RTL8852BE),
 * `wifi7` (the MT7925-shape twin), NO ADAPTER, and LEGACY/no-capabilities (a
 * backend that never computed a report) — asserting real DOM flips for the band
 * options, the generation badge, the hotspot security control, the read-only
 * channel-width line, and the Bluetooth card's own gating. Two rules from
 * DESIGN.md §1 carry it, and they are genuinely different facts: a POSITIVELY
 * UNSUPPORTED thing contributes ZERO nodes (CT-1 — a Wi-Fi 6 radio gets no 6 GHz
 * chip, a board with no controller gets no scan button), while a SUPPORTED thing
 * that is currently BLOCKED stays visible with a reason (CT-2 — a 6 GHz radio
 * under a domain that forbids it).
 *
 * PLAYBOOK.md compliance: role / testid / web-first assertions only — no
 * pixel-screenshot capture, no fixed-delay waits, no hardcoded nav-tab selectors.
 */

// ── docs/TECHNICAL_DEBT.md register location ─────────────────────────────────
// e2e -> tests -> frontend -> apps -> CeraUI (repo root), then docs/.
const REGISTER_PATH = path.resolve(
	import.meta.dirname,
	"../../../../docs/TECHNICAL_DEBT.md",
);

// Register-id regex — copied VERBATIM from scripts/check-tech-debt.mjs (`ID_RE`)
// so the rendered-DOM cross-check parses the register exactly like the static CI
// gate: numeric `TD-001` or a lowercase-slug `TD-live-audio-switch`.
const DEBT_ID_RE = /^TD-(?:\d{3,}|[a-z0-9]+(?:-[a-z0-9]+)*)$/;

/**
 * Parse the `open` debt ids out of docs/TECHNICAL_DEBT.md, mirroring the
 * ```debt-block parse in scripts/check-tech-debt.mjs (`parseDebtBlocks` +
 * `validateEntry`): a block contributes its id to the open set iff
 * `status: open` and the id matches DEBT_ID_RE. Kept intentionally close to the
 * static gate so a rendered debt-id the DOM check accepts is one the CI gate
 * accepts too.
 */
function parseOpenDebtIds(registerText: string): Set<string> {
	const lines = registerText.split("\n");
	const open = new Set<string>();
	let i = 0;
	while (i < lines.length) {
		if (lines[i]?.trim() === "```debt") {
			let j = i + 1;
			const fields: Record<string, string> = {};
			while (j < lines.length && lines[j]?.trim() !== "```") {
				const raw = lines[j] ?? "";
				const colon = raw.indexOf(":");
				if (colon !== -1) {
					fields[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
				}
				j++;
			}
			const { id, status } = fields;
			if (status === "open" && id !== undefined && DEBT_ID_RE.test(id)) {
				open.add(id);
			}
			i = j + 1;
		} else {
			i++;
		}
	}
	return open;
}

/** Every `data-debt-id` value currently in the rendered DOM (non-empty only). */
async function collectDomDebtIds(page: Page): Promise<string[]> {
	return page
		.locator("[data-debt-id]")
		.evaluateAll((els) =>
			els
				.map((el) => el.getAttribute("data-debt-id") ?? "")
				.filter((v) => v.length > 0),
		);
}

/**
 * The core cross-check that powers assertion (b): the deduped DOM debt-ids that
 * are NOT an open register entry. Empty ⇒ every rendered marker is honest. The
 * negative-fixture test asserts this returns the injected orphan, proving the
 * real `toEqual([])` assertion below would fail on an orphan.
 */
function findOrphanDebtIds(
	domIds: readonly string[],
	openIds: ReadonlySet<string>,
): string[] {
	return [...new Set(domIds)].filter((id) => !openIds.has(id));
}

// ── Test-owned proxy control state (reset per test in beforeEach) ────────────
let pageWs: WebSocketRoute | null = null;
// Drop the backend's own `devices` / `capabilities` / `sources` / `config` echoes
// so the INJECTED snapshots are authoritative — the backend's multi-modem-wifi
// profile reports its own capture device + a default caps/sources snapshot on
// connect, which would otherwise race the test-injected truth.
//
// `config` belongs to that same family, and leaving it out was the defect behind a
// CI-only failure: the frontend MERGES a `config` frame field-by-field, so a key a
// test does NOT inject — `source` above all — inherits whatever the per-worker
// backend last persisted, and both `hasEffectiveSource` (does the audio surface
// render at all) and `visibleSources` (an operator-disabled row stays visible while
// SELECTED) key off it. Each test now declares its own `config` premise instead.
// The one test asserting a REAL persisted config reads it over a direct
// `streaming.getConfig` RPC, not this broadcast, so it is unaffected.
let dropServerDevices = false;
let dropServerCapabilities = false;
let dropServerSources = false;
let dropServerConfig = false;
// `status` is NOT blanket-dropped: unlike caps/devices/sources, most tests here do
// NOT inject their own `status` and DO rely on the real backend's initial `status`
// broadcast (asrcs, audio_sources, is_streaming, active_encode, network_ingest) to
// reach the page — e.g. the test-pattern test's source-select round-trip regresses
// without it. So a test opts in via the `drop-server-status` annotation (read in
// beforeEach BEFORE page.goto — the initial status burst must be dropped too, or the
// backend's typed `audio_sources` beats a test's asrcs-only injection).
let dropServerStatus = false;
const DROP_SERVER_STATUS_ANNOTATION = "drop-server-status";
// The `bluetooth` broadcast is blanket-dropped like caps/devices/sources/config:
// the dev host has no controller, so the device's own honest
// `{enabled:false, available:false}` would race every injected roster. No test in
// this file reads the backend's own Bluetooth state, so there is nothing to lose.
// (`helpers/bluetooth-wire.ts` does the same drop-and-inject, but installs its OWN
// `routeWebSocket` over this file's pattern — only one handler wins, so its
// fixture FACTORY is reused here and its installer deliberately is not.)
let dropServerBluetooth = false;
// Fake-resolve every `streaming.setConfig` client-side with success so a config
// write is proven to succeed WITHOUT depending on the per-worker backend accepting the
// injected (backend-unknown) source ids — the injected sources are the DOM truth
// only; the real backend rejects unknown ids. Captured inputs are asserted on.
let fakeSetConfig = false;
const setConfigCalls: Record<string, unknown>[] = [];

function send(payload: unknown): void {
	pageWs?.send(JSON.stringify(payload));
}

// A configured custom server keeps LiveView out of its empty state so the source
// surface + config rows (open-encoder-dialog / open-server-dialog) render; a
// known pipeline makes the Start gate pass.
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

// Deterministic single-source board fixture (software/generic, 1080p ceiling) —
// the shape the dev `pipelines` broadcast carries.
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

/**
 * A schema-valid `capabilities` snapshot; `extra` shallow-overrides the base to
 * raise the tier/flag under test. Base = full engine profile (H.265 + hardware
 * accel, SRT transport advertised). `extra.platform` / `extra.encoder` REPLACE
 * the nested base object (shallow merge) — that is how the engine-starting floor
 * drops H.265; top-level flags (`engineStarting`, `engineUnavailable`,
 * `audio_live_switch`, `latency_range`) are set directly.
 */
function sendCapabilities(extra: Record<string, unknown> = {}): void {
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
			...extra,
		},
	});
}

// ── The three capability snapshots the truthfulness gate walks ───────────────
// FULL CAPS — everything on: H.265 encode, audio live-switch, a wide 2 s…8 s
// latency window, SRT transport advertised. Normal tier (no banner).
function sendFullCaps(): void {
	sendCapabilities({
		audio_live_switch: true,
		latency_range: { min: 2000, default: 4000, max: 8000 },
	});
}
// ENGINE-STARTING FLOOR — the minimal safe floor the engine serves while
// booting: no H.265, no hardware accel, no audio_live_switch, NO latency_range
// (→ DEFAULT 2 s…5 s window), engineStarting flag raised.
function sendEngineStartingFloor(): void {
	sendCapabilities({
		platform: {
			supports_h265: false,
			hardware_accelerated: false,
			max_resolution: "1080p",
		},
		encoder: {
			codecs: ["video/x-h264"],
			bitrate_range: { min: 2000, max: 6000, unit: "kbps" },
		},
		transports: ["srtla"],
		engineStarting: true,
	});
}
// ENGINE-UNAVAILABLE CACHED — the last-known-good snapshot the backend serves
// when the engine stops answering: full caps preserved from cache, but the
// engineUnavailable flag raised so the calm banner shows.
function sendEngineUnavailableCached(): void {
	sendCapabilities({
		audio_live_switch: true,
		latency_range: { min: 2000, default: 4000, max: 8000 },
		engineUnavailable: true,
	});
}

// ── Capability-first source / encoder / audio fixtures (Todos 9–13) ──────────
// A capable HDMI source (override-capable, 2160p/60, embeds audio) and a fixed
// UVC source (720p/30, no audio). Switching the active source flips the SOURCE
// MAX chips (Todo 11). Field names are the snake_case VideoSourceCap wire shape.
const SRC_HDMI_4K = {
	id: "hdmi",
	supports_audio: true,
	supports_resolution_override: true,
	supports_framerate_override: true,
	default_resolution: "1080p",
	default_framerate: 30,
};
const SRC_UVC_720 = {
	id: "uvc",
	supports_audio: false,
	supports_resolution_override: false,
	supports_framerate_override: false,
	default_resolution: "720p",
	default_framerate: 30,
};

// ── Unified device-first source fixtures (Wave 4 — the `sources` broadcast) ──
// SourceSection renders `getSources()` (the folded `sources` broadcast), NOT the
// legacy `devices`/`pipelines` broadcasts, so every source-list assertion injects
// a StreamSource[] and the beforeEach drops the backend's own `sources` echo.
type Mode = { width: number; height: number; framerates: number[] };

// A UVC dongle whose REAL name contains "HDMI" but whose engine-reported `kind` is
// `uvc_h264` — the exact T4 regression fixture. Its row must show the displayName
// under a USB-family kind badge, NEVER the coarse "HDMI Capture" pipeline label.
const RODE_DISPLAY_NAME = "RØDE HDMI to USB-C: RØDE HDMI";
function captureSource(
	id: string,
	kind: string,
	pipelineId: string,
	displayName: string,
	modes: Mode[] = [{ width: 1920, height: 1080, framerates: [30, 60] }],
): Record<string, unknown> {
	return {
		origin: "capture",
		id,
		pipelineId,
		kind,
		displayName,
		devicePath: `/dev/${id}`,
		modes,
		supportsAudio: kind === "hdmi",
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		defaultResolution: "1080p",
		defaultFramerate: 30,
		audioKind: kind === "hdmi" ? "selectable" : "none",
		available: true,
	};
}

const SRC_RODE = captureSource("video-usb", "uvc_h264", "libuvch264", RODE_DISPLAY_NAME);
const SRC_HDMI_CAP = captureSource("video-hdmi", "hdmi", "hdmi", "Rockchip HDMI-RX");

// A dual-codec UVC camera: the engine collapsed its `kind` to the H.265-priority
// value, but its modes advertise BOTH hardware codecs — the badge must name both.
const SRC_DUAL = captureSource(
	"video-dual",
	"uvc_h265",
	"libuvch265",
	"Elgato Dual Codec Cam",
	[
		{ width: 1920, height: 1080, framerates: [30], media_type: "video/x-h265" },
		{ width: 1920, height: 1080, framerates: [30], media_type: "video/x-h264" },
	] as Mode[],
);

// The coarse `hdmi` capability placeholder — kept by the sources model only when
// NO enumerated device bridged to that pipeline. On RK3588 the on-board HDMI-RX
// enumerates under a different pipeline, so this row is permanently "Not connected".
const SRC_COARSE_HDMI: Record<string, unknown> = {
	origin: "coarse",
	id: "hdmi",
	pipelineId: "hdmi",
	labelKey: "settings.sources.hdmi",
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	audioKind: "selectable",
	available: true,
};

const SRC_TEST: Record<string, unknown> = {
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
};

// A network rtmp/srt ingest source: `available` follows the gateway; when it is
// down the row is disabled-with-reason (never hidden, never a coming-soon pill).
function networkSource(
	proto: "rtmp" | "srt",
	active: boolean,
	embedded = true,
): Record<string, unknown> {
	return {
		origin: "network",
		id: proto,
		pipelineId: proto,
		labelKey: `settings.sources.${proto}`,
		requiresGateway: proto,
		url: active ? `${proto}://192.168.1.100/publish/live` : null,
		modes: [],
		supportsAudio: embedded,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: embedded ? "embedded" : "none",
		available: active,
		...(active ? {} : { unavailableReason: "live.education.reason.gatewayInactive" }),
	};
}

// An OPERATOR-DISABLED network source: the Settings toggle is OFF, so the backend
// reports available:false with the DISTINCT disabledInSettings reason (T6/T7). This
// is the ONLY verdict that HIDES the row (Task 9) — gateway-inactive stays visible.
function networkSourceDisabledInSettings(
	proto: "rtmp" | "srt",
): Record<string, unknown> {
	return {
		...networkSource(proto, false),
		unavailableReason: "live.education.reason.disabledInSettings",
	};
}

// Inject the folded `sources` broadcast (drops the backend's own — see beforeEach).
function sendSources(sources: Record<string, unknown>[]): void {
	send({ sources: { hardware: "rk3588", sources } });
}

// ── Cellular fixtures (modem-stack Phase B) ──────────────────────────────────
// Injected over the same proxy as everything else, through `status.modems`. The
// modem merge is field-by-field PER MODEM ID (`mergeModemList`), never a whole-map
// replace, so a re-send carrying only the field under test keeps the rest of the
// fixture — which is exactly how the state tables below flip one thing at a time.
const MM_MODEM_ID = "modem-usb-0";
const DONGLE_MODEM_ID = "modem-dongle-0";
const MM_MODEM_NAME = "Quectel RM520N";

// An MM-managed USB radio carrying everything the USB-mode card needs: a
// `stable_key` (without one the switch is not offered AT ALL — it could never be
// honestly confirmed) and an active mode that differs from the recommended one.
function mmManagedModem(
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		ifname: "wwan0",
		name: MM_MODEM_NAME,
		network_type: { supported: ["5g", "lte"], active: "lte" },
		config: {
			apn: "internet",
			username: "",
			password: "",
			roaming: false,
			network: "",
			autoconfig: true,
		},
		status: {
			connection: "connected",
			network_type: "lte",
			signal: 71,
			roaming: false,
			network: "Test Carrier",
		},
		available_networks: {},
		no_sim: false,
		device_class: "usb",
		slot_label: "SIM 1",
		stable_key: "pci-0000:00:14.0-usb-0:2",
		usb_mode: "rndis",
		recommended_usb_mode: "mbim",
		...extra,
	};
}

// A router-mode dongle. The backend deliberately OMITS its `status` block rather
// than fabricating a zeroed one, so the fixture omits it too — the row's
// "absence renders as absence" rule is only exercised by a payload that really
// carries no radio telemetry.
function routerDongle(
	availability_reason: "router_managed" | "dongle_acquiring" | "dongle_down",
): Record<string, unknown> {
	return {
		ifname: "dg0h",
		name: "Cellular dongle",
		network_type: { supported: [], active: null },
		device_class: "router-ethernet",
		availability_reason,
		slot_label: "Dongle 0",
	};
}

function sendModems(modems: Record<string, unknown>): void {
	send({ status: { modems } });
}

// The backend publishes readiness as an EXPLICIT boolean on every frame, so the
// fixture does too — a true-only flag could be raised and never lowered.
function sendCellularInitializing(initializing: boolean): void {
	send({ status: { cellular_initializing: initializing } });
}

const modemRow = (page: Page, id: string) =>
	page.locator(`[data-testid="modem-row"][data-modem-id="${id}"]`);

// ── Wi-Fi capability fixtures (dynamic-wifi-bt-foundation, todos 2 / 7 / 9) ───
// Both objects are VERBATIM todo 2's shapes — the same literals the unit gate
// (`WifiSection.capability.test.ts`), the backend parser gate
// (`wifi-capabilities.test.ts`) and the `@visual` evidence spec assert against,
// so no two gates can disagree about what a radio reported. Do NOT invent a
// fourth copy here, and do NOT "tidy" a value: `2.4`'s 40 MHz and `5`'s 80 MHz
// are what the shipped Rock 5B+ adapter actually published.

/** Rock 5B+ / RTL8852BE — a real Wi-Fi 6 radio that positively lacks Band 4. */
const ROCK_RTL8852BE = {
	phy: "phy0",
	generation: "wifi6",
	bands: ["2.4", "5"],
	maxWidthMhz: { "2.4": 40, "5": 80 },
	apModes: ["2.4", "5"],
	staApCombo: { supported: true, sameChannelOnly: true },
	wpa3Sae: "supported",
	regulatory: { country: "00", is6GhzLegal: false, self_managed: false },
};

/** MT7925-class — EHT, a real 6 GHz band, and a domain that permits it. */
const MT7925 = {
	phy: "phy0",
	generation: "wifi7",
	bands: ["2.4", "5", "6"],
	maxWidthMhz: { "2.4": 40, "5": 160, "6": 320 },
	apModes: ["2.4", "5", "6"],
	staApCombo: { supported: true, sameChannelOnly: false },
	wpa3Sae: "supported",
	regulatory: { country: "US", is6GhzLegal: true, self_managed: true },
};

/**
 * A station-mode radio. `capabilities` is OMITTED when none is passed, and that
 * absence IS the LEGACY snapshot the gate below walks — no `iw` on the image, an
 * unresolvable wiphy, a dump that failed its parser, or a backend predating the
 * field. The row must then render exactly as it did before the strip existed.
 */
function wifiRadio(capabilities?: unknown): Record<string, unknown> {
	return {
		ifname: "wlan0",
		conn: "home-uuid",
		hw: "Realtek RTL8852BE",
		saved: {},
		available: [
			{ active: true, ssid: "CERALIVE", signal: 72, security: "WPA2", freq: 5180 },
		],
		...(capabilities ? { capabilities } : {}),
	};
}

/**
 * An AP-mode radio. The device attaches a `hotspot` block ONLY in AP mode
 * (`wifi.ts`'s `isApMode` branch), so the hotspot dialog's offering is injected
 * exactly as it is really published rather than bolted onto a station row.
 */
function hotspotRadio(
	hotspot: Record<string, unknown>,
	capabilities?: unknown,
): Record<string, unknown> {
	return {
		ifname: "wlan1",
		conn: "hotspot-uuid",
		hw: "Realtek RTL8852BE",
		saved: {},
		mode: "hotspot",
		hotspot: {
			name: "CERALIVE_03f6",
			available_channels: { auto: { name: "Automatic" } },
			...hotspot,
		},
		...(capabilities ? { capabilities } : {}),
	};
}

// The frontend REPLACES `status.wifi` wholesale, so one frame is the whole
// roster — and `{}` is a board with no Wi-Fi radio at all.
function sendWifi(radios: Record<string, Record<string, unknown>>): void {
	send({ status: { wifi: radios } });
}

// The shipped fleet's offering: NetworkManager 1.42 publishes no SAE key, so the
// device derives WPA2 alone. One option is not a choice.
const WPA2_ONLY = { wpa2: { name: "WPA2 (Personal)" } };
const WPA2_AND_WPA3 = {
	wpa2: { name: "WPA2 (Personal)" },
	"wpa3-sae": { name: "WPA3 (SAE)" },
};
const HOTSPOT_WIDTHS = { "2.4": 40, "5": 80 };

function sendBluetooth(status: WireStatus): void {
	send({ bluetooth: status });
}

// The StreamSetupChain renders all four setup rows ALWAYS (no collapse, no ready
// bar), so every migrated config-row edit trigger is permanently visible — just
// wait for the trigger and click it.
async function openConfigDialog(page: Page, testId: string): Promise<void> {
	const trigger = page.getByTestId(testId);
	await expect(trigger).toBeVisible({ timeout: 15_000 });
	await trigger.click();
}

test.describe("Capability truthfulness (functional)", () => {
	test.beforeEach(async ({ page, pageRpc }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the capability surfaces; mobile/kiosk/RTL are the @visual suite",
		);

		pageWs = null;
		// Injected caps + device lists are authoritative for every test here (see
		// header contract): drop the backend's own echoes so only the test-injected
		// snapshots ever populate the capability-gated surfaces.
		dropServerDevices = true;
		dropServerCapabilities = true;
		dropServerSources = true;
		dropServerConfig = true;
		dropServerStatus = testInfo.annotations.some(
			(a) => a.type === DROP_SERVER_STATUS_ANNOTATION,
		);
		dropServerBluetooth = true;
		fakeSetConfig = false;
		setConfigCalls.length = 0;

		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();
			pageRpc.bindConnectionLifecycle(ws, server);

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
				}
				server.send(m);
			});

			server.onMessage((m) => {
				pageRpc.acceptServerMessage(m);
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as object;
					if (dropServerDevices && "devices" in frame) return;
					if (dropServerCapabilities && "capabilities" in frame) return;
					if (dropServerSources && "sources" in frame) return;
					if (dropServerConfig && "config" in frame) return;
					if (dropServerStatus && "status" in frame) return;
					if (dropServerBluetooth && "bluetooth" in frame) return;
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

	// ── (a) H.265 codec + capability-tier banner flip across the 3 snapshots ────
	test("the H.265 codec option flips enabled ⇄ disabled-with-reason across the three capability snapshots", async ({
		page,
	}) => {
		// `source` un-gates the encoder-edit trigger (Task 18/19).
		serverConfig({ source: "hdmi" });
		send(GENERIC_PIPELINES);
		sendFullCaps();

		await page.getByTestId("open-encoder-dialog").click();
		const dialog = page.getByRole("dialog", { name: "Encoder Settings" });
		await expect(dialog).toBeVisible({ timeout: 15_000 });

		const h265 = dialog.getByTestId("codec-h265");
		const banner = (id: string) => page.getByTestId(id);

		// FULL CAPS → H.265 is a real, enabled encode choice; no reason tooltip and
		// no capability-tier banner (normal tier).
		await expect(h265).toBeEnabled();
		await expect(h265).toHaveAttribute("data-supported", "true");
		await expect(h265).not.toHaveAttribute("title", /.+/);
		await expect(banner("capability-engine-starting")).toHaveCount(0);
		await expect(banner("capability-engine-unavailable")).toHaveCount(0);

		// ENGINE-STARTING FLOOR → the SAME control is disabled and MUST explain why
		// (non-empty title); the calm engine-starting banner appears.
		sendEngineStartingFloor();
		await expect(h265).toBeDisabled();
		await expect(h265).toHaveAttribute("data-supported", "false");
		await expect(h265).toHaveAttribute("aria-disabled", "true");
		await expect(h265).toHaveAttribute("title", /\S/);
		await expect(banner("capability-engine-starting")).toBeVisible();
		await expect(banner("capability-engine-starting")).toHaveAttribute(
			"role",
			"status",
		);

		// ENGINE-UNAVAILABLE CACHED → the cached snapshot still advertises H.265, so
		// the control re-enables (truth follows the cache); the unavailable banner
		// replaces the starting one (priority: unavailable › starting).
		sendEngineUnavailableCached();
		await expect(h265).toBeEnabled();
		await expect(h265).toHaveAttribute("data-supported", "true");
		await expect(banner("capability-engine-unavailable")).toBeVisible();
		await expect(banner("capability-engine-starting")).toHaveCount(0);
	});

	// ── (a) Latency slider window + RIST/SRT transport pills ────────────────────
	test("the latency slider window tracks the engine range and RIST/SRT stay honest coming-soon pills", async ({
		page,
	}) => {
		serverConfig();
		sendFullCaps();

		await page.getByTestId("open-server-dialog").click();
		const slider = page.getByTestId("latency-slider");
		await expect(slider).toBeVisible({ timeout: 15_000 });

		// FULL CAPS → the engine-advertised 2 s…8 s window drives the slider bounds.
		await expect(slider).toHaveAttribute("aria-valuemin", "2000");
		await expect(slider).toHaveAttribute("aria-valuemax", "8000");
		await expect(slider).toBeEnabled();

		// ENGINE-STARTING FLOOR (no latency_range) → the SRTLA-floored DEFAULT
		// window (2 s…5 s) — the bound genuinely flips, never a stale 8 s.
		sendEngineStartingFloor();
		await expect(slider).toHaveAttribute("aria-valuemin", "2000");
		await expect(slider).toHaveAttribute("aria-valuemax", "5000");

		// ENGINE-UNAVAILABLE CACHED → the cached 8 s window is honored again.
		sendEngineUnavailableCached();
		await expect(slider).toHaveAttribute("aria-valuemax", "8000");

		// The one working transport (SRTLA) is the only active pill; RIST + SRT are
		// calm coming-soon affordances bound to their OPEN debt ids — never
		// fake-interactive radios, never hidden.
		await expect(page.getByTestId("transport-srtla-active")).toBeVisible();
		const rist = page.locator(
			'[data-testid="transport-rist"] [data-comingsoon="TD-rist-egress"]',
		);
		const srt = page.locator(
			'[data-testid="transport-srt"] [data-comingsoon="TD-plain-srt-egress"]',
		);
		await expect(rist).toBeVisible();
		await expect(rist).toHaveAttribute("role", "note");
		await expect(srt).toBeVisible();
		await expect(srt).toHaveAttribute("role", "note");
	});

	// ── (a) Capture-row label truth — a UVC dongle is never mislabeled HDMI ─────
	// The Wave-3/4 restructure removed the streaming-only InputPicker (and with it
	// the live-audio-switch surface — the capability is now unit-tested only). The
	// truthfulness assertion this slot now carries is the T4 mislabel regression on
	// the unified device-first Source list: a UVC dongle whose real name contains
	// "HDMI" but whose engine kind is uvc_h264 must show its REAL name under a USB
	// kind badge, never the coarse "HDMI Capture" pipeline label.
	test("a capture source renders its real displayName under a USB kind badge, never the coarse HDMI Capture label", async ({
		page,
	}) => {
		serverConfig();
		sendFullCaps();
		sendSources([SRC_RODE]);

		const row = page.getByTestId("source-row-video-usb");
		await expect(row).toBeVisible({ timeout: 15_000 });
		await expect(row).toHaveAttribute("data-origin", "capture");

		// The REAL hardware name is shown verbatim…
		await expect(page.getByTestId("source-row-name-video-usb")).toHaveText(
			RODE_DISPLAY_NAME,
		);
		// …classified by its SPECIFIC engine kind (uvc_h264 → hardware "UVC H.264"
		// pipeline badge), NOT the coarse "USB" collapse and NOT hdmi. The raw kind
		// stays on the data attribute as the stable test/telemetry hook.
		const kindBadge = page.getByTestId("source-kind-video-usb");
		await expect(kindBadge).toHaveAttribute("data-source-kind", "uvc_h264");
		await expect(kindBadge).toHaveText("UVC H.264");
		// …and the coarse "HDMI Capture" pipeline label never appears on the row.
		await expect(row).not.toContainText("HDMI Capture");
	});

	test("a dual-codec capture source names BOTH codecs, not just its collapsed kind", async ({
		page,
	}) => {
		serverConfig();
		sendFullCaps();
		sendSources([SRC_DUAL]);

		const kindBadge = page.getByTestId("source-kind-video-dual");
		await expect(kindBadge).toBeVisible({ timeout: 15_000 });
		// The engine collapsed the kind to uvc_h265 (stable data hook), but the
		// visible badge must name both codecs the device's modes advertise.
		await expect(kindBadge).toHaveAttribute("data-source-kind", "uvc_h265");
		await expect(kindBadge).toHaveText("UVC H.264/H.265");
	});

	// A coarse row stays honestly "Not connected" AND stays selectable — but the
	// selected-plus-unbound combination used to render the same lime affirmation a
	// working device gets, so an operator could sit on a source that can never
	// connect while their actual camera waited one row below.
	test("a SELECTED unbound coarse row warns and points at the connected device whose real name matches", async ({
		page,
	}) => {
		serverConfig({ source: "hdmi" });
		sendFullCaps();
		sendSources([SRC_COARSE_HDMI, SRC_RODE]);

		const row = page.getByTestId("source-row-hdmi");
		await expect(row).toBeVisible({ timeout: 15_000 });
		await expect(row).toHaveAttribute("data-selected", "true");
		await expect(row).toHaveAttribute("data-unbound", "true");

		// The honest state is never hidden or faked: the "Not connected" pill and
		// its explainer stay exactly where they were.
		await expect(page.getByTestId("source-not-connected-hdmi")).toBeVisible();
		await expect(
			page.getByTestId("source-not-connected-info-hdmi"),
		).toBeVisible();

		// …and the consequence is now impossible to miss, naming the RØDE row.
		const band = page.getByTestId("source-coarse-unbound-hdmi");
		await expect(band).toBeVisible();
		await expect(page.getByTestId("source-coarse-suggestion-lead-hdmi")).toHaveText(
			`Did you mean ${RODE_DISPLAY_NAME}?`,
		);
		await expect(
			page.getByTestId("source-coarse-suggestion-video-usb"),
		).toBeVisible();
	});

	test("an unbound coarse row that is NOT selected, and a selected row with no name-matching device, get no warning band", async ({
		page,
	}) => {
		serverConfig({ source: "video-usb" });
		sendFullCaps();
		sendSources([SRC_COARSE_HDMI, SRC_RODE]);

		await expect(page.getByTestId("source-row-hdmi")).toBeVisible({
			timeout: 15_000,
		});
		// Unselected coarse row keeps its existing calm muted treatment.
		await expect(page.getByTestId("source-coarse-unbound-hdmi")).toHaveCount(0);
		await expect(page.getByTestId("source-row-hdmi")).not.toHaveAttribute(
			"data-unbound",
			"true",
		);
		// A selected CONCRETE capture row is never flagged.
		await expect(page.getByTestId("source-coarse-unbound-video-usb")).toHaveCount(
			0,
		);

		// Re-inject with the coarse row selected but only a device whose real name
		// has nothing to do with HDMI: the band warns, but offers NO false pointer.
		sendSources([
			SRC_COARSE_HDMI,
			captureSource("video-cam", "uvc_h264", "libuvch264", "Logitech BRIO Webcam"),
		]);
		serverConfig({ source: "hdmi" });
		await expect(page.getByTestId("source-coarse-unbound-hdmi")).toBeVisible();
		await expect(
			page.getByTestId("source-coarse-suggestion-lead-hdmi"),
		).toHaveCount(0);
		await expect(
			page.getByTestId("source-coarse-suggestion-video-cam"),
		).toHaveCount(0);
	});

	// ── (c) Network-ingest rows: disabled-with-reason ⇄ selectable via gateway ──
	test("an rtmp network-ingest source row flips disabled-with-reason ⇄ selectable with its gateway", async ({
		page,
	}) => {
		serverConfig();
		sendFullCaps();
		// Gateway DOWN → available:false → the row is a real source rendered disabled
		// with a non-empty reason (never hidden, never a coming-soon/debt treatment).
		sendSources([SRC_HDMI_CAP, networkSource("rtmp", false)]);

		const row = page.getByTestId("source-network-ingest-select-rtmp");
		await expect(row).toBeVisible({ timeout: 15_000 });
		await expect(row).toBeDisabled();
		await expect(row).toHaveAttribute("title", /\S/);
		await expect(
			page.getByTestId("source-network-ingest-reason-rtmp"),
		).toBeVisible();

		// Gateway UP → available:true → the SAME row becomes selectable, no reason.
		sendSources([SRC_HDMI_CAP, networkSource("rtmp", true)]);
		await expect(row).toBeEnabled();
		await expect(row).not.toHaveAttribute("title", /.+/);
		await expect(
			page.getByTestId("source-network-ingest-reason-rtmp"),
		).toHaveCount(0);
	});

	// ── (c) Operator-disabled ingest row HIDES; a config write still succeeds ────
	// Distinct from the gateway-inactive row above (which stays VISIBLE
	// disabled-with-reason): a source the operator switched OFF in Settings is HIDDEN
	// from the picker (Task 9). Hiding it must NOT wedge the rest of the config — a
	// setConfig of an unrelated field still succeeds while the ingest is disabled.
	test("an operator-disabled network row disappears from the list while a config write still succeeds", async ({
		page,
	}) => {
		fakeSetConfig = true;
		// No source pre-selected, so the capture row is genuinely selectable (a click
		// on the already-selected source is a no-op — handleSelectSource early-returns).
		serverConfig();
		sendFullCaps();
		// rtmp operator-disabled (Settings toggle OFF) alongside a selectable capture
		// source. The gateway-inactive row above proves available:false alone does NOT
		// hide — only the disabledInSettings reason does.
		sendSources([SRC_HDMI_CAP, networkSourceDisabledInSettings("rtmp")]);

		const captureRow = page.getByTestId("source-select-video-hdmi");
		await expect(captureRow).toBeVisible({ timeout: 15_000 });
		// The operator-disabled rtmp row is HIDDEN (not merely disabled) — no select
		// button, no reason line, no whole row.
		await expect(
			page.getByTestId("source-network-ingest-select-rtmp"),
		).toHaveCount(0);
		await expect(page.getByTestId("source-row-rtmp")).toHaveCount(0);

		// A config write of an unrelated field still succeeds while rtmp is disabled:
		// selecting the still-visible capture source dispatches streaming.setConfig,
		// which the proxy fake-resolves with success (the injected sources are
		// backend-unknown, so the write is proven client-side).
		await captureRow.click();
		await expect
			.poll(() => setConfigCalls.some((c) => c.source === "video-hdmi"), {
				timeout: 5_000,
			})
			.toBe(true);

		// Re-enabling rtmp (Settings toggle back ON → available:true) brings the row
		// back, selectable — the hide is purely the operator-disabled verdict.
		sendSources([SRC_HDMI_CAP, networkSource("rtmp", true)]);
		await expect(
			page.getByTestId("source-network-ingest-select-rtmp"),
		).toBeEnabled();
	});

	// ── (b) Every rendered data-debt-id maps to an OPEN register entry ──────────
	test("every rendered [data-debt-id] maps to an open docs/TECHNICAL_DEBT.md entry", async ({
		page,
	}) => {
		const openIds = parseOpenDebtIds(fs.readFileSync(REGISTER_PATH, "utf8"));
		// Sanity: the register genuinely parsed (guards against a path/format break
		// silently making the cross-check vacuous).
		expect(openIds.size).toBeGreaterThan(0);

		serverConfig();
		send(GENERIC_PIPELINES);
		sendFullCaps();

		// Live roadmap carries TD-pip + TD-mode-fallback…
		await expect(page.getByTestId("live-roadmap")).toBeVisible({
			timeout: 15_000,
		});
		// …and the Server dialog's transport row carries TD-rist-egress + TD-plain-srt-egress.
		await page.getByTestId("open-server-dialog").click();
		await expect(page.getByTestId("transport-row")).toBeVisible();

		const domIds = await collectDomDebtIds(page);

		// The surfaces really did render live debt markers (not an empty DOM that
		// would make the orphan check trivially pass).
		expect(domIds).toEqual(
			expect.arrayContaining([
				"TD-pip",
				"TD-mode-fallback",
				"TD-rist-egress",
				"TD-plain-srt-egress",
			]),
		);
		// THE assertion: no rendered debt-id is an orphan — every one is an OPEN
		// register entry (rendered-DOM complement to scripts/check-tech-debt.mjs).
		expect(findOrphanDebtIds(domIds, openIds)).toEqual([]);
	});

	// ── (b, negative fixture) The cross-check actually catches an orphan ─────────
	test("the debt-id cross-check catches an orphan data-debt-id (negative fixture)", async ({
		page,
	}) => {
		const openIds = parseOpenDebtIds(fs.readFileSync(REGISTER_PATH, "utf8"));
		serverConfig();
		await expect(page.getByTestId("live-roadmap")).toBeVisible({
			timeout: 15_000,
		});

		// Baseline: with only real markers, the cross-check is clean.
		expect(findOrphanDebtIds(await collectDomDebtIds(page), openIds)).toEqual([]);

		// Inject a CONTROLLED orphan marker into a test-only DOM node. `.spec.` is
		// excluded from the static gate's scan (TEST_FILE_RE), so this literal never
		// trips CI — it exists only to prove THIS rendered-DOM check has teeth.
		const ORPHAN = "TD-orphan-e2e-fixture";
		await page.evaluate((id) => {
			const el = document.createElement("span");
			el.setAttribute("data-debt-id", id);
			el.setAttribute("data-testid", "debt-orphan-fixture");
			document.body.appendChild(el);
		}, ORPHAN);

		const domIds = await collectDomDebtIds(page);
		expect(domIds).toContain(ORPHAN);

		// PROOF: the SAME function that powers assertion (b)'s `toEqual([])` now
		// reports the orphan — i.e. the real assertion WOULD fail on an orphan.
		const orphans = findOrphanDebtIds(domIds, openIds);
		expect(orphans).toContain(ORPHAN);

		// Cleanup: remove the fixture node so no state leaks into a later assertion.
		await page.evaluate(() =>
			document.querySelector('[data-testid="debt-orphan-fixture"]')?.remove(),
		);
		expect(await collectDomDebtIds(page)).not.toContain(ORPHAN);
	});

	// ── (c) A click-walk of primary controls dispatches no undefined RPC ────────
	test("a click-walk of primary Live/Network/Settings controls raises no console error or unhandled rejection", async ({
		page,
	}) => {
		// Collect the two signals of an undefined-RPC dispatch: uncaught exceptions
		// (pageerror) and console errors. Chromium logs an unhandled promise
		// rejection — e.g. a rejected `rpc.foo.bar()` whose method doesn't exist —
		// as a console message of type "error", so this pair covers both. We filter
		// the console stream to RPC-shaped failures so unrelated dev-server noise
		// (WS reconnect chatter, favicon/SW 404s) never flakes the gate; ANY
		// uncaught exception fails outright.
		const RPC_FAILURE_RE =
			/is not a function|is not defined|undefined is not|cannot read propert|rpc\.[a-z]/i;
		const pageErrors: string[] = [];
		const rpcConsoleErrors: string[] = [];
		page.on("pageerror", (err) => pageErrors.push(String(err)));
		page.on("console", (msg) => {
			if (msg.type() === "error" && RPC_FAILURE_RE.test(msg.text())) {
				rpcConsoleErrors.push(msg.text());
			}
		});

		// `source` un-gates the encoder-edit trigger (Task 18/19).
		serverConfig({ source: "hdmi" });
		send(GENERIC_PIPELINES);
		sendFullCaps();

		// LIVE — open each capability-gated config dialog (opening dispatches the
		// primary edit control) then close it via Escape.
		await navigateTo(page, "live");
		for (const testId of [
			"open-encoder-dialog",
			"open-audio-dialog",
			"open-server-dialog",
		]) {
			const trigger = page.getByTestId(testId);
			await expect(trigger).toBeVisible({ timeout: 15_000 });
			await trigger.click();
			await expect(page.getByRole("dialog")).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(page.getByRole("dialog")).toBeHidden();
		}

		// NETWORK + SETTINGS — navigation is itself a primary-control click-walk;
		// each asserts its own `aria-current="page"` before returning.
		await navigateTo(page, "network");
		await expect(page.getByRole("main").first()).toBeVisible();
		await navigateTo(page, "settings");
		await expect(page.getByRole("main").first()).toBeVisible();
		await navigateTo(page, "live");

		expect(pageErrors, `uncaught exceptions: ${pageErrors.join(" | ")}`).toEqual(
			[],
		);
		expect(
			rpcConsoleErrors,
			`undefined-RPC console errors: ${rpcConsoleErrors.join(" | ")}`,
		).toEqual([]);
	});

	// ── (Todo 10) Encoder resolution + framerate options flip with device_modes ──
	test("encoder resolution and framerate options flip enabled ⇄ disabled-with-reason with injected device_modes", async ({
		page,
	}) => {
		// EncoderDialog is now source-tolerant (T14): the axes come from the ACTIVE
		// StreamSource's own `.modes` (keyed by config.source), NOT a `#encoder-source`
		// picker (removed) or the coarse `capabilities.device_modes` broadcast. So the
		// device envelope is injected on the capture source and switched via `sources`.
		serverConfig({
			pipeline: "hdmi",
			source: "video-hdmi",
			resolution: "720p",
			framerate: 30,
		});
		send(GENERIC_PIPELINES);
		sendFullCaps();
		sendSources([
			captureSource("video-hdmi", "hdmi", "hdmi", "Rockchip HDMI-RX", [
				{ width: 1280, height: 720, framerates: [30] },
			]),
		]);

		await openConfigDialog(page, "open-encoder-dialog");
		const dialog = page.getByRole("dialog", { name: "Encoder Settings" });
		await expect(dialog).toBeVisible({ timeout: 15_000 });

		const res720 = page.locator(
			'[data-testid="resolution-option"][data-value="720p"]',
		);
		const res1080 = page.locator(
			'[data-testid="resolution-option"][data-value="1080p"]',
		);
		const fps60 = page.locator(
			'[data-testid="framerate-option"][data-value="60"]',
		);
		const fps30 = page.locator(
			'[data-testid="framerate-option"][data-value="30"]',
		);

		// PHASE 1 — the source reports a single 720p30 signal, so it bounds the encode
		// target from ABOVE: 1080p and 60fps are disabled-with-reason (you cannot
		// upscale a signal that isn't there), while 720p stays selectable.
		await page.locator("#encoder-resolution").click();
		await expect(res720).toBeVisible();
		await expect(res1080).toHaveAttribute("aria-disabled", "true");
		await expect(res1080).toHaveAttribute("title", /\S/);
		await expect(res720).not.toHaveAttribute("aria-disabled", "true");
		await res720.click();

		await page.locator("#encoder-framerate").click();
		await expect(fps30).toBeVisible();
		await expect(fps60).toHaveAttribute("aria-disabled", "true");
		await expect(fps60).toHaveAttribute("title", /\S/);
		await expect(fps30).not.toHaveAttribute("aria-disabled", "true");
		await page.keyboard.press("Escape");

		// PHASE 2 — the source now advertises 720p AND 1080p at 30 AND 60fps: the
		// SAME options genuinely re-enable, proving the DOM tracks the source's modes.
		sendSources([
			captureSource("video-hdmi", "hdmi", "hdmi", "Rockchip HDMI-RX", [
				{ width: 1280, height: 720, framerates: [30, 60] },
				{ width: 1920, height: 1080, framerates: [30, 60] },
			]),
		]);

		await page.locator("#encoder-resolution").click();
		await expect(res1080).not.toHaveAttribute("aria-disabled", "true");
		await page.keyboard.press("Escape");

		await page.locator("#encoder-framerate").click();
		await expect(fps60).not.toHaveAttribute("aria-disabled", "true");
		await page.keyboard.press("Escape");
	});

	// ── (Todo 11) SOURCE MAX chips reflect the ACTIVE source, not platform maxima ─
	test("the SOURCE MAX capability chips change with the active source", async ({
		page,
	}) => {
		send(GENERIC_PIPELINES);
		serverConfig({ pipeline: "hdmi", selected_video_input: "hdmi" });
		sendCapabilities({
			audio_live_switch: true,
			sources: [SRC_HDMI_4K, SRC_UVC_720],
		});

		const chips = page.getByTestId("source-capabilities");
		await expect(chips).toBeVisible({ timeout: 15_000 });
		await expect(chips).toContainText("2160p");
		await expect(chips).toContainText("60fps");
		await expect(page.getByTestId("cap-audio")).toBeVisible();

		// Switch the active source to the fixed UVC input (720p / 30 / no audio):
		// the SAME chips genuinely track the new source's real ceiling.
		serverConfig({ pipeline: "hdmi", selected_video_input: "uvc" });
		await expect(chips).toContainText("720p");
		await expect(chips).toContainText("30fps");
		await expect(chips).not.toContainText("2160p");
		await expect(page.getByTestId("cap-audio")).toHaveCount(0);
	});

	// ── (Todo 12) Network-ingest rows honest — embedded-audio chip + srt absence ──
	test("network-ingest source rows stay honest — the embedded-audio chip tracks the source and an unadvertised srt row is absent", async ({
		page,
	}) => {
		serverConfig();
		sendFullCaps();
		// rtmp advertised WITH embedded audio; srt NOT advertised at all.
		sendSources([SRC_HDMI_CAP, networkSource("rtmp", true, true)]);

		const rtmpRow = page.getByTestId("source-network-ingest-select-rtmp");
		await expect(rtmpRow).toBeVisible({ timeout: 15_000 });
		await expect(rtmpRow).toBeEnabled();
		await expect(page.getByTestId("source-network-audio-rtmp")).toBeVisible();
		// srt was never advertised → its row never appears (honest absence).
		await expect(
			page.getByTestId("source-network-ingest-select-srt"),
		).toHaveCount(0);

		// The source stops carrying audio → the chip HONESTLY disappears (it is
		// source-driven, never a decorative always-on badge).
		sendSources([SRC_HDMI_CAP, networkSource("rtmp", true, false)]);
		await expect(page.getByTestId("source-network-audio-rtmp")).toHaveCount(0);

		// Gateway goes DOWN → the SAME row renders disabled WITH a non-empty reason
		// (never hidden, never a coming-soon/debt treatment).
		sendSources([SRC_HDMI_CAP, networkSource("rtmp", false, false)]);
		await expect(rtmpRow).toBeDisabled();
		await expect(rtmpRow).toHaveAttribute("title", /\S/);
		await expect(
			page.getByTestId("source-network-ingest-reason-rtmp"),
		).toBeVisible();
	});

	// ── (Todo 13) Audio pseudo-sources localized + embedded-audio read-only state ─
	test("audio pseudo-sources render localized and an embedded network source switches to the read-only embedded state", {
		annotation: {
			type: DROP_SERVER_STATUS_ANNOTATION,
			description:
				"injects its own status.asrcs; the backend's status (incl. its typed audio_sources) must be dropped from beforeEach so the asrcs-only injection wins",
		},
	}, async ({
		page,
	}) => {
		serverConfig();
		send({ status: { asrcs: ["USB audio", "No audio", "Pipeline default"] } });
		sendFullCaps();
		sendSources([SRC_HDMI_CAP]);

		const audioSelect = page.getByTestId("audio-source-select");
		await expect(audioSelect).toBeVisible({ timeout: 15_000 });
		await audioSelect.click();
		// Pseudo-sources render via their localized labelKey (grouped last), beside
		// the untranslated hardware device name.
		await expect(page.getByRole("option", { name: "No audio" })).toBeVisible();
		await expect(
			page.getByRole("option", { name: "Source default (engine decides)" }),
		).toBeVisible();
		await expect(page.getByRole("option", { name: "USB audio" })).toBeVisible();
		await page.keyboard.press("Escape");

		// Switch the ACTIVE source to an SRT ingest whose audio is EMBEDDED in the
		// incoming stream and advertise `network_embedded_audio`: the ALSA picker
		// collapses to the read-only "Embedded audio" state (no misleading dropdown).
		serverConfig({ pipeline: "srt", source: "srt" });
		sendSources([networkSource("srt", true, true)]);
		sendCapabilities({ audio_live_switch: true, network_embedded_audio: true });

		const embedded = page.getByTestId("audio-source-embedded");
		await expect(embedded).toBeVisible();
		await expect(embedded).toContainText(/embedded/i);
		await expect(page.getByTestId("audio-source-select")).toHaveCount(0);
	});

	// ── An unavailable-but-selected audio device is shown, never re-offered ──────
	test("the selected audio device the engine no longer reports is listed disabled with a reason, not as a fresh choice", {
		annotation: {
			type: DROP_SERVER_STATUS_ANNOTATION,
			description:
				"injects its own status.asrcs so the selected device is deliberately absent from the reported list",
		},
	}, async ({
		page,
	}) => {
		serverConfig({ asrc: "Gone USB mic" });
		send({ status: { asrcs: ["No audio", "Pipeline default"] } });
		sendFullCaps();
		sendSources([SRC_HDMI_CAP]);

		// The problem stays visible: the trigger still names what is selected.
		const audioSelect = page.getByTestId("audio-source-select");
		await expect(audioSelect).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("audio-source-unavailable")).toContainText(
			"Gone USB mic",
		);

		// …but re-picking it is refused — it only buys another failed start.
		await audioSelect.click();
		const unavailable = page.getByTestId("audio-option-unavailable");
		await expect(unavailable).toBeVisible();
		await expect(unavailable).toHaveAttribute("aria-disabled", "true");
		await expect(unavailable).toHaveAttribute("data-disabled", /.*/);
		await expect(unavailable).toHaveAttribute("title", /.+/);
		await page.keyboard.press("Escape");
	});

	// ── (b) The test-pattern source appears once and resolves to pipeline 'test' ─
	test("the test-pattern source appears exactly once and selecting it persists a config whose pipeline is 'test'", async ({
		page,
		pageRpc,
	}) => {
		serverConfig();
		sendFullCaps();
		sendSources([SRC_HDMI_CAP, SRC_TEST]);

		// Exactly one virtual test-pattern row.
		await expect(page.getByTestId("source-row-test")).toHaveCount(1);
		await expect(page.getByTestId("source-row-test")).toHaveAttribute(
			"data-origin",
			"virtual",
		);
		const select = page.getByTestId("source-select-test");
		await expect(select).toBeVisible({ timeout: 15_000 });

		// Selecting it dispatches setConfig({source:'test'}); the backend (T3)
		// resolves the source id to pipeline='test' and persists it — asserted via
		// the real getConfig() echo through the page WS proxy.
		await select.click();
		await expect
			.poll(
				async () => {
					const cfg = await pageRpc.call<{ pipeline?: string }>(["streaming", "getConfig"]);
					return cfg?.pipeline;
				},
				{
					timeout: 15_000,
					message: "backend should resolve source='test' → pipeline='test'",
				},
			)
			.toBe("test");
	});

	// ── (d) StreamSetupChain gates Start honestly; every row goes ok when green ──
	test("the Stream setup chain blocks Start with a reason when a gate fails and every setup row goes ok when all gates are green", async ({
		page,
	}) => {
		send(GENERIC_PIPELINES);
		sendFullCaps();
		// Clear the seed's stale managed binding: the per-worker backend seed ships
		// `relay_server: "srv-eu"`, an id ABSENT from the mock relay catalog. Config
		// frames MERGE, so a bare serverConfig() leaves it in place and — once the
		// catalog is delivered to the page — the C7 destination gate correctly WARNS
		// on the stale server, making the Destination row `warn`, not `ok`. This test
		// asserts an all-green custom (srtla_addr) endpoint, so it must clear the
		// inherited managed binding (mirrors the `source: ""` reset the C3 test uses).
		serverConfig({ relay_server: "" });
		// BLOCKED: TWO capture sources and NO config.source → no sole-camera auto →
		// the source gate blocks; it projects onto the ENCODER row, so that row is
		// blocked and Start is disabled + reason (rows are always rendered — no collapse).
		sendSources([SRC_HDMI_CAP, SRC_RODE]);

		const chain = page.getByTestId("stream-setup-chain");
		await expect(chain).toBeVisible({ timeout: 15_000 });
		await expect(
			chain.locator('[data-testid="setup-row"][data-row="encoder"]'),
		).toHaveAttribute("data-state", "blocked");
		const start = page.getByRole("button", { name: /start stream/i });
		await expect(start).toBeDisabled();
		await expect(start).toHaveAttribute("title", /\S/);

		// ALL-GREEN: pick a source → every setup row resolves to data-state="ok" and
		// Start becomes enabled. The chain shows its THREE always-rendered rows
		// (Encoder / Destination / Network) — the audio row was folded into the
		// Source card in live-correctness-pass Todo #11, so the chain is 3 rows now,
		// never collapses.
		serverConfig({ source: "video-hdmi" });
		await expect(page.getByRole("button", { name: /start stream/i })).toBeEnabled();
		await expect(chain.locator('[data-testid="setup-row"]')).toHaveCount(3);
		await expect(
			chain.locator('[data-testid="setup-row"]:not([data-state="ok"])'),
		).toHaveCount(0);
	});

	// ── (C3) Encoder-row Edit is disabled-with-reason without an effective source ─
	test("the encoder-row Edit is disabled-with-reason with no source selected and enables once a source is picked", async ({
		page,
	}) => {
		send(GENERIC_PIPELINES);
		sendFullCaps();
		// Explicit empty source (the mock backend seeds one via legacy coercion and
		// config frames MERGE, so an empty string is how a test represents "no source
		// selected") + TWO captures → no sole-camera auto → no effective source. The
		// encoder Edit is disabled-with-reason; the Destination row is not source-gated.
		serverConfig({ source: "" });
		sendSources([SRC_HDMI_CAP, SRC_RODE]);

		const encoderEdit = page.getByTestId("open-encoder-dialog");
		await expect(encoderEdit).toBeVisible({ timeout: 15_000 });
		await expect(encoderEdit).toBeDisabled();
		await expect(encoderEdit).toHaveAttribute("title", /\S/);
		// The Destination row's Edit is never source-gated — it stays actionable.
		await expect(page.getByTestId("open-server-dialog")).toBeEnabled();

		// Select a source over the injected socket → an effective source resolves →
		// the SAME Edit re-enables and drops its reason title.
		serverConfig({ source: "video-hdmi" });
		await expect(encoderEdit).toBeEnabled();
		await expect(encoderEdit).not.toHaveAttribute("title", /.+/);
	});

	// ── (e) The migrated config-row testids still open their dialogs ────────────
	test("the migrated open-encoder / open-audio / open-server-dialog rows still open their dialogs", async ({
		page,
	}) => {
		// `source` un-gates the encoder-edit trigger (Task 18/19).
		serverConfig({ source: "hdmi" });
		send(GENERIC_PIPELINES);
		sendFullCaps();

		for (const testId of [
			"open-encoder-dialog",
			"open-audio-dialog",
			"open-server-dialog",
		]) {
			await openConfigDialog(page, testId);
			await expect(page.getByRole("dialog")).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(page.getByRole("dialog")).toBeHidden();
		}
	});

	// ── (Todo 9) The mode-preset catalog is gone — no preset-grid testids remain ──
	test("the removed mode-preset grid leaves no preset testids in the rebuilt encoder dialog", async ({
		page,
	}) => {
		// `source` un-gates the encoder-edit trigger (Task 18/19).
		serverConfig({ source: "hdmi" });
		send(GENERIC_PIPELINES);
		sendFullCaps();

		await page.getByTestId("open-encoder-dialog").click();
		const dialog = page.getByRole("dialog", { name: "Encoder Settings" });
		await expect(dialog).toBeVisible({ timeout: 15_000 });

		// The rebuilt capability-first dialog rendered (so the 0-count below is a
		// real absence, not a dialog that failed to open).
		await expect(dialog.getByTestId("encoder-codec-selector")).toBeVisible();
		await expect(dialog.getByTestId("encoder-bitrate-control")).toBeVisible();

		await expect(page.locator('[data-testid="mode-presets"]')).toHaveCount(0);
		await expect(page.locator('[data-testid="encoder-preset"]')).toHaveCount(0);
	});

	// ── (a, C5) Opus is disabled-with-reason over an MPEG-TS transport; AAC stays on ─
	// Transport × audio-codec truthfulness (coherence-contract-pass todo 21): every
	// relay transport CeraUI egresses over is an MPEG-TS carrier proven out only for
	// AAC, so the AudioDialog codec picker renders Opus DISABLED with a non-empty
	// reason (never hidden) while AAC stays selectable. Effective transport floors to
	// srtla, matching the backend streaming.start gate.
	test("the Opus audio codec is disabled-with-reason over srtla while AAC stays enabled", async ({
		page,
	}) => {
		// An active audio source + a known srtla destination: the codec select is
		// enabled (so it opens) and the gate has a transport to evaluate against.
		// `source` is REQUIRED here, not decoration: the audio surface (and with it
		// `open-audio-dialog`) renders only once an effective source resolves, and the
		// coarse row below is `origin: "coarse"` — never the implicit sole CAMERA — so
		// selecting it explicitly is the only thing that resolves one.
		serverConfig({
			source: "hdmi",
			asrc: "USB audio",
			relay_protocol: "srtla",
		});
		send(GENERIC_PIPELINES);
		// The audio gate reads the pipeline registry CeraUI projects from `sources`,
		// so the audio-capable `hdmi` pipeline has to arrive on that broadcast.
		sendSources([SRC_COARSE_HDMI]);
		sendFullCaps();

		await openConfigDialog(page, "open-audio-dialog");
		const dialog = page.getByRole("dialog", { name: "Audio Settings" });
		await expect(dialog).toBeVisible({ timeout: 15_000 });

		await dialog.locator("#audioCodec").click();

		const opus = page.getByRole("option", { name: "Opus" });
		const aac = page.getByRole("option", { name: "AAC" });
		await expect(opus).toBeVisible();
		// Opus: disabled WITH a non-empty reason (never hidden).
		await expect(opus).toHaveAttribute("data-disabled", "");
		await expect(opus).toHaveAttribute("title", /\S/);
		// AAC: the one proven codec — genuinely selectable, no disabled reason.
		await expect(aac).not.toHaveAttribute("data-disabled", "");
	});

	// ── (Phase B, todo 28) Cellular truthfulness ─────────────────────────────
	// The USB-composition switch is gated on `config.modem_provisioning`, echoed
	// READ-ONLY on the config wire as a tristate. This drives the two arms that
	// are decidable before any dispatch; ABSENT (an older backend) deliberately
	// leaves the control offered and is covered by the unit suite.
	test("the USB-mode switch is disabled-with-reason under a provisioning-disabled snapshot and flips enabled when provisioning is on", {
		annotation: {
			type: DROP_SERVER_STATUS_ANNOTATION,
			description:
				"injects its own status.modems; the backend's multi-modem-wifi roster must be dropped so the fixture modem is the only row",
		},
	}, async ({ page }) => {
		serverConfig({ modem_provisioning: false });
		sendFullCaps();
		sendModems({ [MM_MODEM_ID]: mmManagedModem() });

		await navigateTo(page, "network");
		const configure = page.getByTestId("open-modem-config-dialog");
		await expect(configure).toBeEnabled({ timeout: 15_000 });
		await configure.click();

		const dialog = page.getByRole("dialog", { name: MM_MODEM_NAME });
		await expect(dialog).toBeVisible({ timeout: 15_000 });
		// The card renders at all — so the assertions below are about the GATE,
		// not about an additive field the fixture forgot. It lives behind the
		// dialog's "Advanced" disclosure (todo 64), so open that first.
		await openModemAdvanced(dialog);
		await expect(page.getByTestId("modem-usb-mode-card")).toBeVisible();
		// The wire token identifies the composition for a MACHINE; the operator
		// reads a behaviour (DESIGN.md OL-1). Both facts are asserted, because
		// asserting only the label would let the attribute drift and asserting
		// only the attribute would let the token creep back into the copy.
		const activeMode = page.getByTestId("modem-usb-mode-active");
		await expect(activeMode).toHaveAttribute("data-usb-mode", "rndis");
		await expect(activeMode).not.toHaveText(/rndis/i);
		await expect(activeMode).toHaveText(/\S/);

		// PROVISIONING OFF → the control exists, is disabled, and the reason is on
		// SCREEN as well as in its accessible name (a kiosk cannot hover).
		const blockedSwitch = page.getByTestId("modem-usb-mode-switch");
		await expect(blockedSwitch).toBeDisabled();
		await expect(blockedSwitch).toHaveAttribute("title", /\S/);
		const blockedHint = page.getByTestId("modem-usb-mode-provisioning-blocked");
		await expect(blockedHint).toBeVisible();
		await expect(blockedHint).toHaveText(/\S/);

		// PROVISIONING ON → the SAME control genuinely flips to the real
		// confirm-guarded switch: the blocked hint is gone and an enabled trigger
		// carrying the switch label takes its place.
		serverConfig({ modem_provisioning: true });
		await expect(
			page.getByTestId("modem-usb-mode-provisioning-blocked"),
		).toHaveCount(0);
		await expect(page.getByTestId("modem-usb-mode-switch")).toHaveCount(0);
		const liveSwitch = page.getByRole("button", { name: /^Switch to/ });
		await expect(liveSwitch).toBeVisible();
		await expect(liveSwitch).toBeEnabled();

		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
	});

	// ── DESIGN.md §1: the capability-truth matrix, in a real browser ──────────
	//
	// UI pass 1 asserted FOUR claims against ONE fixture modem. Pass 4 is the
	// confirming round, so it runs the WHOLE matrix — every operation state the
	// ladder can produce, against every fleet family whose devices reach this
	// dialog at all — because a rule proven on one transport is a rule assumed
	// on the other four.
	//
	// The claim ladder decides which of FOUR renderings a gated module gets, and
	// three of the four are decidable from the claim alone. The `capable`/
	// `certified` arm additionally depends on what the device's own read answers,
	// which a dev host cannot pin, so it is asserted as the DISJUNCTION the
	// matrix actually promises: a control is offered, or a control is offered
	// DISABLED with its reason on screen. What it may never be is `unknown` or
	// absent, and that is what the assertion pins.
	//
	// The unit twin (`ModemConfigDialog.capabilityTruth.test.ts`) drives every
	// arm exactly against fixture reads; this proves the same contract survives
	// the real app, the real dialog chrome and the real disclosure.
	type ExpectedRender = "absent" | "unknown" | "offered";

	// A claim of `undefined` is a backend that never published the matrix at all.
	// It is a real operation state on the wire, and it folds to `absent`
	// fail-CLOSED — absence of a claim is not a claim.
	const OPERATION_STATES: readonly {
		readonly claim: string | undefined;
		readonly label: string;
		readonly expected: ExpectedRender;
	}[] = [
		{ claim: undefined, label: "no published matrix", expected: "absent" },
		{ claim: "unavailable", label: "unavailable", expected: "absent" },
		{ claim: "implemented", label: "implemented", expected: "unknown" },
		{ claim: "enabled", label: "enabled", expected: "unknown" },
		{ claim: "capable", label: "capable", expected: "offered" },
		{ claim: "certified", label: "certified", expected: "offered" },
	];

	// Every transport ModemManager manages (`MM_MANAGED_CLASSES` in
	// `cellular-row.ts`), plus the pre-Phase-B wire that carried no class at all —
	// which `resolveClassBand` reads as mm-managed, so it too reaches this dialog
	// and belongs in the matrix.
	const MM_FLEET_FAMILIES: readonly {
		readonly id: string;
		readonly deviceClass: string | undefined;
		readonly name: string;
	}[] = [
		{ id: "fleet-usb", deviceClass: "usb", name: "Quectel RM520N" },
		{ id: "fleet-pcie-mhi", deviceClass: "pcie-mhi", name: "Fibocom FM350" },
		{ id: "fleet-pcie-mtk", deviceClass: "pcie-mtk", name: "MediaTek T830" },
		{ id: "fleet-soc-qrtr", deviceClass: "soc-qrtr", name: "Onboard QRTR radio" },
		{ id: "fleet-legacy", deviceClass: undefined, name: "Legacy mmcli radio" },
	];

	// Both modules the dialog gates today. Their testids share one shape, so the
	// matrix asserts the CONTRACT rather than one module's markup.
	const GATED_MODULE_TESTIDS: readonly { readonly module: string; readonly testId: string }[] =
		[
			{ module: "fcc-auto-unlock", testId: "modem-fcc-unlock" },
			{ module: "gps", testId: "modem-gps" },
		];

	async function expectCapabilityRender(
		page: Page,
		testId: string,
		expected: ExpectedRender,
		where: string,
	): Promise<void> {
		const section = page.getByTestId(testId);
		const control = page.getByTestId(`${testId}-toggle`);
		const unknown = page.getByTestId(`${testId}-unknown`);

		if (expected === "absent") {
			// CT-1: not a ghost, not a disabled row, not a tooltip. Nothing.
			await expect(section, `${where}: CT-1 expects zero nodes`).toHaveCount(0);
			await expect(control, `${where}: CT-1 expects no control`).toHaveCount(0);
			await expect(unknown, `${where}: CT-1 expects no diagnostic`).toHaveCount(0);
			return;
		}

		if (expected === "unknown") {
			// CT-3 + CT-4: a distinct, announced diagnostic and NO control — below
			// `capable` nobody has shown there is a capability to withhold.
			await expect(unknown, `${where}: CT-3 expects a diagnostic`).toBeVisible({
				timeout: 15_000,
			});
			await expect(unknown).toHaveAttribute("data-state", "unknown");
			await expect(unknown).toHaveAttribute("role", "status");
			await expect(unknown).toHaveText(/\S/);
			await expect(unknown).not.toHaveText(/network\.modem/);
			await expect(control, `${where}: CT-4 forbids a fake control`).toHaveCount(0);
			await expect(section).toHaveAttribute("data-capability-state", "unknown");
			return;
		}

		await expect(section, `${where}: a proven module must render`).toBeVisible({
			timeout: 15_000,
		});
		const state = await section.getAttribute("data-capability-state");
		expect(["available", "blocked"], `${where}: resolved as "${state}"`).toContain(
			state,
		);
		await expect(control).toBeVisible();
		if (state === "blocked") {
			// CT-2: disabled, and the reason is ON SCREEN — the shipped kiosk
			// touchscreen cannot hover to reveal a tooltip.
			await expect(control).toBeDisabled();
			const reason = page.getByTestId(`${testId}-reason`);
			await expect(reason, `${where}: CT-2 expects a reason`).toBeVisible();
			await expect(reason).toHaveText(/\S/);
			await expect(reason).not.toHaveText(/network\.modem/);
		} else {
			await expect(control).toBeEnabled();
		}
	}

	for (const { claim, label, expected } of OPERATION_STATES) {
		test(`a gated capability module claiming ${label} renders as ${expected} on every mm-managed fleet family`, {
			annotation: {
				type: DROP_SERVER_STATUS_ANNOTATION,
				description:
					"injects its own status.modems so the fixture roster is the only cellular content",
			},
		}, async ({ page }) => {
			// Five dialogs, each asserting two modules — well past the default.
			test.setTimeout(180_000);

			serverConfig();
			sendFullCaps();
			// `claim: undefined` must OMIT the module keys rather than publish a
			// null, which is what a backend with no matrix actually sends.
			const claims =
				claim === undefined
					? undefined
					: { "fcc-auto-unlock": claim, gps: claim };
			sendModems(
				Object.fromEntries(
					MM_FLEET_FAMILIES.map((family, index) => [
						family.id,
						mmManagedModem({
							name: family.name,
							ifname: `wwan${index}`,
							slot_label: `SIM ${index + 1}`,
							stable_key: `pci-0000:00:14.0-usb-0:${index + 2}`,
							device_class: family.deviceClass,
							capability_modules: claims,
						}),
					]),
				),
			);

			await navigateTo(page, "network");
			await expect(page.getByTestId("modem-row")).toHaveCount(
				MM_FLEET_FAMILIES.length,
				{ timeout: 15_000 },
			);

			for (const family of MM_FLEET_FAMILIES) {
				const where = `${family.deviceClass ?? "no device_class"} claiming ${label}`;
				const row = modemRow(page, family.id);
				// Every mm-managed family reaches the dialog — a family that could
				// not would make its whole matrix column vacuously "absent".
				const configure = row.getByTestId("open-modem-config-dialog");
				await expect(configure, `${where}: expects a Configure action`).toBeEnabled({
					timeout: 15_000,
				});
				await configure.click();

				const dialog = page.getByRole("dialog", { name: family.name });
				await expect(dialog).toBeVisible({ timeout: 15_000 });
				await openModemAdvanced(dialog);

				for (const { module, testId } of GATED_MODULE_TESTIDS) {
					await expectCapabilityRender(
						page,
						testId,
						expected,
						`${module} on ${where}`,
					);
				}

				await page.keyboard.press("Escape");
				await expect(dialog).toBeHidden();
			}
		});
	}

	// The other two fleet families never reach that dialog, so CT-1 holds for
	// them at the SURFACE: a device this build cannot control contributes zero
	// capability nodes anywhere, however loudly its payload claims a module.
	test("a fleet family with no config surface renders zero capability nodes, whatever it claims", {
		annotation: {
			type: DROP_SERVER_STATUS_ANNOTATION,
			description:
				"injects its own status.modems so the fixture roster is the only cellular content",
		},
	}, async ({ page }) => {
		serverConfig();
		sendFullCaps();
		const certified = { "fcc-auto-unlock": "certified", gps: "certified" };
		sendModems({
			[DONGLE_MODEM_ID]: {
				...routerDongle("router_managed"),
				capability_modules: certified,
			},
			"fleet-unmanaged": {
				ifname: "wwx0",
				name: "Unrecognised WWAN",
				network_type: { supported: [], active: null },
				device_class: "thunderbolt-wwan",
				capability_modules: certified,
			},
		});

		await navigateTo(page, "network");
		await expect(page.getByTestId("modem-row")).toHaveCount(2, { timeout: 15_000 });

		for (const id of [DONGLE_MODEM_ID, "fleet-unmanaged"]) {
			const row = modemRow(page, id);
			await expect(row).toBeVisible();
			// Disabled-with-reason, never hidden: the row is the whole point.
			const configure = row.getByTestId("open-modem-config-dialog");
			await expect(configure, `${id}: expects a refused Configure`).toBeDisabled();
			await expect(configure).toHaveAttribute("title", /\S/);
			await expect(row.getByTestId("modem-note").first()).toHaveText(/\S/);
		}

		for (const { testId } of GATED_MODULE_TESTIDS) {
			await expect(page.getByTestId(testId)).toHaveCount(0);
			await expect(page.getByTestId(`${testId}-toggle`)).toHaveCount(0);
			await expect(page.getByTestId(`${testId}-unknown`)).toHaveCount(0);
		}
		await expect(page.getByRole("dialog")).toHaveCount(0);
	});

	// DESIGN.md §3: the two engine vocabularies this surface renders — USB
	// composition and radio band — are RELOCATED to a marked diagnostics block,
	// never printed at the operator. The unit gate scans the jsdom tree; this
	// proves it against the real dialog, where the diagnostics block is behind a
	// disclosure an operator has to open.
	test("no raw composition or band token reaches operator copy, and every one is still in diagnostics", {
		annotation: {
			type: DROP_SERVER_STATUS_ANNOTATION,
			description:
				"injects its own status.modems so the fixture modem is the only cellular row",
		},
	}, async ({ page }) => {
		serverConfig();
		sendFullCaps();
		sendModems({
			[MM_MODEM_ID]: mmManagedModem({
				cell_info: { tech: "nr", band: "ngran-78", rsrp: -92 },
			}),
		});

		await navigateTo(page, "network");
		const configure = modemRow(page, MM_MODEM_ID).getByTestId(
			"open-modem-config-dialog",
		);
		await expect(configure).toBeEnabled({ timeout: 15_000 });
		await configure.click();

		const dialog = page.getByRole("dialog", { name: MM_MODEM_NAME });
		await expect(dialog).toBeVisible({ timeout: 15_000 });
		await openModemAdvanced(dialog);

		const diagnostics = page.getByTestId("modem-raw-diagnostics");
		await expect(diagnostics).toBeVisible({ timeout: 15_000 });
		// OL-3: relocated, not deleted — a field engineer still reads the exact
		// values the labels above replaced.
		await expect(page.getByTestId("modem-raw-usb-mode")).toHaveText("rndis");
		await expect(page.getByTestId("modem-raw-serving-band")).toHaveText(
			"ngran-78",
		);

		// OL-1/OL-2: and nowhere ELSE. The diagnostics subtree is removed before
		// the scan, so this fails if a token leaks into any operator-facing string
		// on the whole dialog.
		const operatorText = await dialog.evaluate((node) => {
			const clone = node.cloneNode(true) as HTMLElement;
			for (const el of clone.querySelectorAll('[data-testid*="diagnostic"]')) {
				el.remove();
			}
			return (clone.textContent ?? "").toLowerCase();
		});
		for (const token of ["rndis", "mbim", "qmi", "ecm-ncm", "ngran-78"]) {
			expect(operatorText).not.toContain(token);
		}
		// NON-VACUITY: the scrub really removed something, so the scan above is
		// asserting on a tree that DID carry the tokens.
		const fullText = (await dialog.textContent())?.toLowerCase() ?? "";
		expect(fullText).toContain("ngran-78");

		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
	});

	// A router dongle is a device this stack cannot control, so every state must
	// be VISIBLE and disabled-with-reason — never hidden, and never a raw wire
	// token rendered at the operator.
	test("a router-dongle cellular row stays honest across up / acquiring / down", {
		annotation: {
			type: DROP_SERVER_STATUS_ANNOTATION,
			description:
				"injects its own status.modems so the dongle fixture is the only cellular row",
		},
	}, async ({ page }) => {
		serverConfig();
		sendFullCaps();
		sendModems({ [DONGLE_MODEM_ID]: routerDongle("router_managed") });

		await navigateTo(page, "network");
		const row = modemRow(page, DONGLE_MODEM_ID);
		await expect(row).toBeVisible({ timeout: 15_000 });
		await expect(row).toHaveAttribute("data-class-band", "router-ethernet");

		const states = [
			["router_managed", "router-up"],
			["dongle_acquiring", "router-acquiring"],
			["dongle_down", "router-down"],
		] as const;

		for (const [reason, expectedState] of states) {
			sendModems({ [DONGLE_MODEM_ID]: routerDongle(reason) });

			// The lifecycle word tracks the wire token…
			await expect(row).toHaveAttribute("data-modem-state", expectedState);
			await expect(
				row.locator('[data-testid="modem-state-badge"]'),
			).toHaveText(/\S/);

			// …the row is dimmed-with-a-reason rather than dropped: Configure is
			// disabled AND names why, in its accessible name and on screen.
			const configure = row.getByTestId("open-modem-config-dialog");
			await expect(configure).toBeDisabled();
			await expect(configure).toHaveAttribute("title", /\S/);
			const notes = row.locator('[data-testid="modem-note"]');
			await expect(notes.first()).toHaveText(/\S/);

			// The bond toggle is present-but-disabled in every state (its live
			// control lives on the veth's own Ethernet row), never absent.
			const bond = row.locator('[data-testid="bond-toggle-dg0h"]');
			await expect(bond).toBeVisible();
			await expect(bond).toBeDisabled();

			// ABSENCE RENDERS AS ABSENCE: a dongle reports no radio status, so the
			// row draws no signal glyph rather than an empty meter.
			await expect(row.locator('[data-testid="modem-signal"]')).toHaveCount(0);

			// A wire-stable machine token is NEVER rendered raw.
			await expect(row).not.toContainText(reason);
		}
	});

	// While the cellular composition root is still committing a backend the modem
	// list is legitimately empty and every `modems.*` RPC refuses with the typed
	// CELLULAR_STACK_INITIALIZING. That window must read as "starting up", not as
	// "no SIM cards detected" — and must not take the view down with it.
	test("an initializing cellular stack renders the calm band instead of a false empty state, and never crashes the view", {
		annotation: {
			type: DROP_SERVER_STATUS_ANNOTATION,
			description:
				"drives status.cellular_initializing + an empty modem roster, the exact boot-window frame",
		},
	}, async ({ page }) => {
		const pageErrors: string[] = [];
		page.on("pageerror", (err) => pageErrors.push(String(err)));

		serverConfig();
		sendFullCaps();
		send({ status: { cellular_initializing: true, modems: {} } });

		await navigateTo(page, "network");
		const band = page.getByTestId("cellular-initializing");
		await expect(band).toBeVisible({ timeout: 15_000 });
		await expect(band).toHaveAttribute("role", "status");
		await expect(band).toHaveText(/\S/);
		// The empty roster must NOT be reported as "no SIM cards detected" — that
		// is a claim the device cannot make while its modem service is still up.
		await expect(page.getByText("No SIM cards detected")).toHaveCount(0);
		// …and the rest of the destination is intact.
		await expect(page.getByRole("main").first()).toBeVisible();

		// Once the stack commits, the band retracts and the roster renders.
		sendCellularInitializing(false);
		sendModems({ [MM_MODEM_ID]: mmManagedModem() });
		await expect(page.getByTestId("cellular-initializing")).toHaveCount(0);
		await expect(modemRow(page, MM_MODEM_ID)).toBeVisible();

		expect(pageErrors, `uncaught exceptions: ${pageErrors.join(" | ")}`).toEqual(
			[],
		);
	});

	// ── (b) The debt cross-check extended over the modem surfaces ────────────
	test("every rendered [data-debt-id] on the Network destination and the modem dialog maps to an open register entry", {
		annotation: {
			type: DROP_SERVER_STATUS_ANNOTATION,
			description:
				"injects its own status.modems so the usage card renders from a known payload",
		},
	}, async ({ page }) => {
		const openIds = parseOpenDebtIds(fs.readFileSync(REGISTER_PATH, "utf8"));
		expect(openIds.size).toBeGreaterThan(0);

		serverConfig({ modem_provisioning: true });
		sendFullCaps();
		sendModems({
			[MM_MODEM_ID]: mmManagedModem({
				data_usage: {
					session_bytes: 1_234_567,
					cycle_bytes: 8_765_432,
					cycle_day: 1,
					threshold_bytes: 50_000_000,
				},
				esim: { sim_type: "esim", esim_status: "with-profiles" },
				firmware_revision: "RM520NGLAAR01A08M4G",
			}),
			[DONGLE_MODEM_ID]: routerDongle("dongle_acquiring"),
		});

		await navigateTo(page, "network");
		const configure = modemRow(page, MM_MODEM_ID).getByTestId(
			"open-modem-config-dialog",
		);
		await expect(configure).toBeEnabled({ timeout: 15_000 });
		await configure.click();
		await openModemAdvanced(page.getByRole("dialog", { name: MM_MODEM_NAME }));
		await expect(page.getByTestId("modem-usage-card")).toBeVisible({
			timeout: 15_000,
		});

		const domIds = await collectDomDebtIds(page);
		expect(findOrphanDebtIds(domIds, openIds)).toEqual([]);

		// THESE SURFACES CARRY NO DEBT MARKER AT ALL, and that is a POSITIVE
		// claim rather than a gap: the last one here was
		// `TD-modem-usage-policy-write`, retired when the usage-policy write
		// landed and its register entry flipped to `resolved`. Asserting the
		// emptiness is what makes a future `ComingSoon` on the modem surfaces a
		// deliberate, visible decision instead of a silent arrival.
		expect(
			domIds,
			`the modem surfaces rendered a debt marker: ${domIds.join(", ")}. If that is intentional, its register entry must be \`open\` and this expectation updated.`,
		).toEqual([]);

		// NON-VACUITY: an empty result could equally mean the collector never
		// reached these surfaces at all — the dialog is a PORTAL, so a collector
		// scoped to the destination subtree would report zero on a dialog full of
		// orphans. Plant one inside the open dialog and prove both halves see it.
		const planted = "TD-pass4-modem-probe";
		expect(openIds.has(planted)).toBe(false);
		await page
			.getByRole("dialog", { name: MM_MODEM_NAME })
			.evaluate((node, id) => {
				const probe = document.createElement("span");
				probe.setAttribute("data-debt-id", id);
				probe.dataset.pass4Probe = "true";
				node.appendChild(probe);
			}, planted);
		const withProbe = await collectDomDebtIds(page);
		expect(withProbe).toContain(planted);
		expect(findOrphanDebtIds(withProbe, openIds)).toEqual([planted]);
		await page.evaluate(() => {
			document.querySelector('[data-pass4-probe="true"]')?.remove();
		});

		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog", { name: MM_MODEM_NAME })).toBeHidden();
	});

	// ── (a) Wi-Fi: the band options and the generation badge follow the RADIO ───
	const wifiBand = (page: Page, band: string) =>
		page.locator(`[data-testid="wifi-band-option"][data-band="${band}"]`);

	const WIFI_ROSTER_ANNOTATION = {
		type: DROP_SERVER_STATUS_ANNOTATION,
		description:
			"injects its own status.wifi; the backend's multi-modem-wifi roster must be dropped so the fixture radio is the only row",
	};

	test("the Wi-Fi capability strip flips its band options and generation badge between a Wi-Fi 6 and a Wi-Fi 7 radio", {
		annotation: WIFI_ROSTER_ANNOTATION,
	}, async ({ page }) => {
		serverConfig();
		sendFullCaps();
		sendWifi({ 0: wifiRadio(ROCK_RTL8852BE) });

		await navigateTo(page, "network");

		const strip = page.getByTestId("wifi-capabilities");
		await expect(strip).toBeVisible({ timeout: 15_000 });
		await expect(strip).toHaveAttribute("data-generation", "wifi6");

		// The badge is the wire's own verdict and nothing else — the shipped
		// RTL8852BE prints all-zero EHT structures, so a UI that inferred it from
		// "does it mention EHT" would stamp Wi-Fi 7 on a Wi-Fi 6 radio.
		const badge = page.getByTestId("wifi-generation-badge");
		await expect(badge).toHaveText("Wi-Fi 6");

		const bands = page.getByTestId("wifi-band-option");
		await expect(bands).toHaveCount(2);
		await expect(wifiBand(page, "2.4")).toHaveAttribute("data-available", "true");
		await expect(wifiBand(page, "2.4")).toContainText("2.4 GHz");
		await expect(wifiBand(page, "2.4")).toContainText("40 MHz");
		await expect(wifiBand(page, "5")).toHaveAttribute("data-available", "true");
		await expect(wifiBand(page, "5")).toContainText("80 MHz");

		// THE REGRESSION LOCK. This radio positively lacks Band 4, so 6 GHz
		// contributes ZERO nodes (CT-1) — not a greyed chip, and not a reason
		// blaming the regulatory domain. Mutating the fixture above to claim
		// 6 GHz is what must turn this spec RED.
		await expect(wifiBand(page, "6")).toHaveCount(0);
		await expect(page.getByTestId("wifi-band-blocked-reason")).toHaveCount(0);
		await expect(page.getByTestId("wifi-sta-ap-combo")).toHaveAttribute(
			"data-same-channel",
			"true",
		);

		// The SAME strip genuinely flips when the radio does — a third band
		// appears, its own advertised width with it, and the combo note changes
		// because this wiphy can host an AP on a different channel.
		sendWifi({ 0: wifiRadio(MT7925) });
		await expect(strip).toHaveAttribute("data-generation", "wifi7");
		await expect(badge).toHaveText("Wi-Fi 7");
		await expect(bands).toHaveCount(3);
		await expect(wifiBand(page, "6")).toHaveAttribute("data-available", "true");
		await expect(wifiBand(page, "6")).toContainText("320 MHz");
		await expect(wifiBand(page, "5")).toContainText("160 MHz");
		await expect(page.getByTestId("wifi-band-blocked-reason")).toHaveCount(0);
		await expect(page.getByTestId("wifi-sta-ap-combo")).toHaveAttribute(
			"data-same-channel",
			"false",
		);
	});

	// ── (a, CT-2) A band the radio HAS but cannot use stays visible with a reason ─
	test("a forbidden 6 GHz band is disabled-with-reason rather than hidden, and only a domain block offers the country dialog", {
		annotation: WIFI_ROSTER_ANNOTATION,
	}, async ({ page }) => {
		serverConfig();
		sendFullCaps();
		// A domain block is ACTIONABLE: the operator picks a country and the
		// kernel re-derives what is legal.
		sendWifi({
			0: wifiRadio({
				...MT7925,
				regulatory: { country: "CO", is6GhzLegal: false, self_managed: false },
			}),
		});

		await navigateTo(page, "network");

		const six = wifiBand(page, "6");
		await expect(six).toBeVisible({ timeout: 15_000 });
		await expect(six).toHaveAttribute("data-available", "false");
		await expect(six).toHaveAttribute("aria-disabled", "true");
		await expect(six).toHaveAttribute("data-blocked-by", "regulatory-domain");

		const reason = page.getByTestId("wifi-band-blocked-reason");
		await expect(reason).toBeVisible();
		await expect(reason).toHaveAttribute("role", "status");
		await expect(reason).toContainText("CO");
		await expect(reason).not.toHaveText(/network\.wifiCapability/);
		await expect(page.getByTestId("wifi-open-country")).toBeVisible();

		// A SELF-MANAGED wiphy is the same band and a DIFFERENT fact: its own
		// firmware sets the rules, so the country dialog could not move it and
		// must NOT be offered — a control that cannot act. The band still stays
		// on screen with its own reason.
		sendWifi({
			0: wifiRadio({
				...MT7925,
				regulatory: { country: "US", is6GhzLegal: false, self_managed: true },
			}),
		});
		await expect(six).toHaveAttribute("data-blocked-by", "self-managed");
		await expect(six).toHaveAttribute("data-available", "false");
		await expect(reason).toBeVisible();
		await expect(reason).toHaveText(/\S/);
		await expect(page.getByTestId("wifi-open-country")).toHaveCount(0);
	});

	// ── (a, CT-1) No adapter, and a radio whose capabilities were never computed ─
	test("a board with no Wi-Fi radio says so, and a radio with no capability report makes no capability claim at all", {
		annotation: WIFI_ROSTER_ANNOTATION,
	}, async ({ page }) => {
		serverConfig();
		sendFullCaps();
		sendWifi({});

		await navigateTo(page, "network");

		const empty = page.getByTestId("wifi-no-adapter");
		await expect(empty).toBeVisible({ timeout: 15_000 });
		await expect(empty).toHaveAttribute("role", "status");
		await expect(empty).toHaveText(/\S/);
		await expect(page.getByTestId("wifi-capabilities")).toHaveCount(0);

		// LEGACY: a REAL radio whose `capabilities` block the device never
		// computed (no `iw` on the image, an unresolvable wiphy, a failed parse,
		// or a backend predating the field). The row must be byte-identical to
		// what it rendered before the strip existed — never a blank section,
		// never a "capabilities unavailable" placeholder, and never mistaken for
		// the no-adapter state above.
		sendWifi({ 0: wifiRadio() });
		await expect(page.getByTestId("open-wifi-selector-dialog")).toBeVisible();
		await expect(page.getByTestId("wifi-no-adapter")).toHaveCount(0);
		for (const testId of [
			"wifi-capabilities",
			"wifi-generation-badge",
			"wifi-band-option",
			"wifi-wpa3",
			"wifi-sta-ap-combo",
			"wifi-band-blocked-reason",
		]) {
			await expect(
				page.getByTestId(testId),
				`${testId} must contribute nothing without a capability report`,
			).toHaveCount(0);
		}
	});

	// ── (a) Hotspot: the security control is the DEVICE's map, the width is read-only ─
	test("the hotspot security control offers exactly what the device derived, and the channel-width line carries no control at all", {
		annotation: WIFI_ROSTER_ANNOTATION,
	}, async ({ page }) => {
		serverConfig();
		sendFullCaps();
		sendWifi({
			0: hotspotRadio(
				{ available_security: WPA2_ONLY, max_width_mhz: HOTSPOT_WIDTHS },
				ROCK_RTL8852BE,
			),
		});

		await navigateTo(page, "network");
		const setup = page.getByTestId("open-hotspot-dialog");
		await expect(setup).toBeEnabled({ timeout: 15_000 });
		await setup.click();

		const dialog = page.getByRole("dialog", { name: "Configure Hotspot" });
		await expect(dialog).toBeVisible({ timeout: 15_000 });

		// ONE offered mode is not a choice, so it is STATED — never a one-item
		// select the operator can move but not change.
		const stated = page.getByTestId("hotspot-security-stated");
		await expect(stated).toBeVisible();
		await expect(stated).toContainText("WPA2 (Personal)");
		await expect(page.getByTestId("hotspot-security-select")).toHaveCount(0);
		await expect(page.getByTestId("hotspot-security-option-wpa3-sae")).toHaveCount(
			0,
		);

		// READ-ONLY radio truth. The width is DISPLAYED and has no selector
		// anywhere in this contract — NetworkManager 1.42 exposes no hotspot
		// channel-width property, so a control could not act — and 6 GHz never
		// appears at all, because `802-11-wireless.band` has no value for it.
		const truth = page.getByTestId("hotspot-radio-truth");
		await expect(truth).toBeVisible();
		await expect(page.getByTestId("hotspot-radio-generation")).toHaveText(
			"Wi-Fi 6",
		);
		await expect(page.getByTestId("hotspot-radio-width-2.4")).toContainText(
			"40 MHz",
		);
		await expect(page.getByTestId("hotspot-radio-width-5")).toContainText("80 MHz");
		await expect(page.getByTestId("hotspot-radio-width-6")).toHaveCount(0);
		expect(
			await truth
				.locator('input, select, button, [role="switch"], [role="combobox"]')
				.count(),
			"the read-only width line must carry no interactive control",
		).toBe(0);

		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();

		// TWO offered modes → a REAL selector carrying exactly the device's map.
		sendWifi({
			0: hotspotRadio(
				{ available_security: WPA2_AND_WPA3, max_width_mhz: HOTSPOT_WIDTHS },
				ROCK_RTL8852BE,
			),
		});
		await setup.click();
		await expect(dialog).toBeVisible();
		await expect(page.getByTestId("hotspot-security-select")).toBeVisible();
		await expect(page.getByTestId("hotspot-security-stated")).toHaveCount(0);
		await dialog.locator("#hotspot-security").click();
		await expect(page.getByTestId("hotspot-security-option-wpa2")).toBeVisible();
		await expect(
			page.getByTestId("hotspot-security-option-wpa3-sae"),
		).toBeVisible();
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();

		// ABSENT IS NOT EMPTY. A device that derived no offering omits the map,
		// and the dialog must then render as it did BEFORE this existed: no
		// selector, no stated line, and no read-only radio line either.
		sendWifi({ 0: hotspotRadio({}) });
		await setup.click();
		await expect(dialog).toBeVisible();
		await expect(page.getByTestId("hotspot-security-select")).toHaveCount(0);
		await expect(page.getByTestId("hotspot-security-stated")).toHaveCount(0);
		await expect(page.getByTestId("hotspot-radio-truth")).toHaveCount(0);
		// …and the dialog itself still rendered, so those three zeros are real
		// absences rather than a dialog that failed to open.
		await expect(dialog.locator("#hotspot-channel")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
	});

	// ── (a) Bluetooth: the card gates on what the stack actually reported ───────
	test("the Bluetooth card withholds a control it has no capability for, never blames the service for an operator's switch, and gates the audio hint on CONNECTED", async ({
		page,
	}) => {
		serverConfig();
		sendFullCaps();
		const base = btMicPairedStatus();
		const mic = base.devices[0];
		expect(mic, "the shared BT fixture must carry the seeded microphone").toBeDefined();
		if (!mic) return;

		sendBluetooth(base);
		await navigateTo(page, "network");

		await expect(page.getByTestId("bluetooth-section")).toBeVisible({
			timeout: 15_000,
		});
		await expect(page.getByTestId("bluetooth-enable")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await expect(page.getByTestId("bluetooth-scan")).toBeVisible();
		await expect(page.getByTestId("bluetooth-adapter")).toHaveAttribute(
			"data-powered",
			"true",
		);
		// A CONNECTED audio-input device has a PCM behind it, so the row may point
		// at the Live source list, and it reports the level the device published.
		await expect(page.getByTestId("bluetooth-audio-source-hint")).toBeVisible();
		await expect(page.getByTestId("bluetooth-chip-battery")).toBeVisible();

		// STILL BONDED, NO LONGER CONNECTED. BlueZ retracts the whole `Battery1`
		// interface on disconnect, so the chip disappears rather than retaining a
		// level nothing measured — and the audio hint goes with it, because
		// naming a mic with no PCM as an available source is a claim the device
		// cannot honour. `undefined` here is the wire shape: JSON drops the key.
		sendBluetooth({
			...base,
			devices: [{ ...mic, connected: false, battery: undefined }],
		});
		await expect(page.getByTestId("bluetooth-chip-connected")).toHaveCount(0);
		await expect(page.getByTestId("bluetooth-chip-paired")).toBeVisible();
		await expect(page.getByTestId("bluetooth-chip-battery")).toHaveCount(0);
		await expect(page.getByTestId("bluetooth-audio-source-hint")).toHaveCount(0);

		// NO ADAPTER: there is no capability being withheld, so the scan control
		// contributes ZERO nodes (CT-1) rather than rendering disabled — and the
		// cause is stated in words, never as its own dotted path.
		sendBluetooth({
			...base,
			available: false,
			unavailable: { cause: "no_adapter" },
			adapters: [],
			devices: [],
		});
		const unavailable = page.getByTestId("bluetooth-unavailable");
		await expect(unavailable).toBeVisible();
		await expect(unavailable).toHaveAttribute("data-cause", "no_adapter");
		await expect(unavailable).toHaveAttribute("role", "status");
		await expect(unavailable).toHaveText(/\S/);
		await expect(unavailable).not.toHaveText(/network\.bluetooth/);
		await expect(page.getByTestId("bluetooth-scan")).toHaveCount(0);

		// "THE OPERATOR SWITCHED IT OFF" OUTRANKS THE STACK'S OWN CAUSE.
		// `BluetoothStack` records an operator-disabled device as
		// `bluez_unavailable` — true from its point of view (it is not observing
		// BlueZ) and the opposite fact to an operator. The card must say "off",
		// never band a healthy service as unresponsive over a setting.
		sendBluetooth({
			...base,
			enabled: false,
			available: false,
			unavailable: { cause: "bluez_unavailable" },
			adapters: [],
			devices: [],
		});
		await expect(page.getByTestId("bluetooth-off")).toBeVisible();
		await expect(page.getByTestId("bluetooth-unavailable")).toHaveCount(0);
		await expect(page.getByTestId("bluetooth-enable")).toHaveAttribute(
			"aria-checked",
			"false",
		);
		await expect(page.getByTestId("bluetooth-scan")).toHaveCount(0);

		// THE PAIRING-AGENT GAP is stated BEFORE the operator taps Pair — this
		// build exports no `org.bluez.Agent1`, so it is the state on every real
		// board — but only while an unpaired device is on screen, or it is a
		// warning about nothing. Pairing is still OFFERED: a peer needing no
		// authorization can complete one.
		const unpaired: WireDevice = {
			...mic,
			path: `${BT_ADAPTER_PATH}/dev_AA_BB_CC_DD_EE_22`,
			address: "AA:BB:CC:DD:EE:22",
			name: "Pixel 8 Pro",
			paired: false,
			trusted: false,
			connected: false,
			battery: undefined,
		};
		const agentGap = {
			registered: false,
			isDefaultAgent: false,
			reason: "exporter_unavailable",
		};
		sendBluetooth({ ...base, agent: agentGap, devices: [unpaired] });
		await expect(page.getByTestId("bluetooth-agent-gap")).toBeVisible();
		await expect(page.getByTestId("bluetooth-action-pair")).toBeVisible();

		sendBluetooth({ ...base, agent: agentGap });
		await expect(page.getByTestId("bluetooth-agent-gap")).toHaveCount(0);
	});

	// ── (b) The debt cross-check extended over the Wi-Fi + Bluetooth surfaces ───
	test("every rendered [data-debt-id] on the Wi-Fi and Bluetooth surfaces maps to an open register entry", {
		annotation: WIFI_ROSTER_ANNOTATION,
	}, async ({ page }) => {
		const openIds = parseOpenDebtIds(fs.readFileSync(REGISTER_PATH, "utf8"));
		expect(openIds.size).toBeGreaterThan(0);

		serverConfig();
		sendFullCaps();
		sendWifi({
			0: wifiRadio(MT7925),
			1: hotspotRadio(
				{ available_security: WPA2_AND_WPA3, max_width_mhz: HOTSPOT_WIDTHS },
				ROCK_RTL8852BE,
			),
		});
		sendBluetooth(btMicPairedStatus());

		await navigateTo(page, "network");
		await expect(page.getByTestId("wifi-capabilities").first()).toBeVisible({
			timeout: 15_000,
		});
		await expect(page.getByTestId("bluetooth-section")).toBeVisible();
		await page.getByTestId("open-hotspot-dialog").click();
		const dialog = page.getByRole("dialog", { name: "Configure Hotspot" });
		await expect(dialog).toBeVisible({ timeout: 15_000 });

		const domIds = await collectDomDebtIds(page);
		expect(findOrphanDebtIds(domIds, openIds)).toEqual([]);

		// THESE SURFACES CARRY NO DEBT MARKER, and that is a POSITIVE claim
		// rather than a gap: nothing the dynamic-wifi-bt-foundation effort
		// shipped is a coming-soon affordance. LE Audio is out of v1 scope and is
		// recorded in docs/TECHNICAL_DEBT.md as a MARKER-LESS entry precisely so
		// it never becomes a fake affordance here. Asserting the emptiness is
		// what makes a future `ComingSoon` on these surfaces a deliberate,
		// visible decision instead of a silent arrival.
		expect(
			domIds,
			`the Wi-Fi/Bluetooth surfaces rendered a debt marker: ${domIds.join(", ")}. If that is intentional, its register entry must be \`open\` and this expectation updated.`,
		).toEqual([]);

		// NON-VACUITY: an empty result could equally mean the collector never
		// reached the open dialog, which is a PORTAL. Plant a controlled orphan
		// inside it and prove both halves see it.
		const planted = "TD-wifi-bt-probe";
		expect(openIds.has(planted)).toBe(false);
		await dialog.evaluate((node, id) => {
			const probe = document.createElement("span");
			probe.setAttribute("data-debt-id", id);
			probe.dataset.wifiBtProbe = "true";
			node.appendChild(probe);
		}, planted);
		const withProbe = await collectDomDebtIds(page);
		expect(withProbe).toContain(planted);
		expect(findOrphanDebtIds(withProbe, openIds)).toEqual([planted]);
		await page.evaluate(() => {
			document.querySelector('[data-wifi-bt-probe="true"]')?.remove();
		});

		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
	});
});

/**
 * Responsive modem-dialog contract (`ceraui-playwright-testing-standards`, an
 * acceptance that was never closed).
 *
 * Every modem dialog must OPEN and CLOSE cleanly on BOTH viewports, because
 * `AppDialog` renders two structurally different surfaces — a centered
 * bits-ui Dialog under desktop chrome and a bottom Sheet otherwise — and only
 * one of them was ever exercised. A Sheet that traps focus, leaves a scroll
 * lock, or never unmounts is invisible to a desktop-only suite.
 *
 * Unlike the describe above this one does NOT skip a non-desktop project, and
 * unlike the `@visual` suite it captures NO screenshots: every assertion is a
 * DOM/state fact, so it fails on behaviour rather than on rendering drift.
 *
 * The modem under test is chosen from the RENDERED LIST, never from a
 * hardcoded index into the fixture — which is what makes the same spec valid
 * whatever roster the backend and the injected snapshot fold into.
 */
test.describe("Modem dialogs — responsive open/close contract", () => {
	test.beforeEach(async ({ page, pageRpc }) => {
		pageWs = null;
		dropServerDevices = true;
		dropServerCapabilities = true;
		dropServerSources = true;
		dropServerConfig = true;
		// ALWAYS drop status here (not annotation-gated like the describe above):
		// this suite's whole subject is the injected modem roster, and the
		// per-worker backend's own multi-modem profile would race it.
		dropServerStatus = true;
		fakeSetConfig = false;
		setConfigCalls.length = 0;

		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();
			pageRpc.bindConnectionLifecycle(ws, server);

			ws.onMessage((m) => {
				server.send(m);
			});

			server.onMessage((m) => {
				pageRpc.acceptServerMessage(m);
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as object;
					if (dropServerDevices && "devices" in frame) return;
					if (dropServerCapabilities && "capabilities" in frame) return;
					if (dropServerSources && "sources" in frame) return;
					if (dropServerConfig && "config" in frame) return;
					if (dropServerStatus && "status" in frame) return;
				} catch {
					/* non-JSON / binary frame */
				}
				ws.send(m);
			});
		});

		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
	});

	test("every modem dialog opens and closes cleanly on this viewport, with the first surfaced modem selected dynamically", async ({
		page,
	}) => {
		const consoleErrors: string[] = [];
		const pageErrors: string[] = [];
		page.on("pageerror", (err) => pageErrors.push(String(err)));
		page.on("console", (msg) => {
			if (msg.type() === "error") consoleErrors.push(msg.text());
		});

		serverConfig({ modem_provisioning: true });
		sendFullCaps();
		// TWO modems, so "the first one" is a real choice rather than the only
		// row — and the fully-populated one is deliberately NOT first, so a spec
		// that reached for index 0 of the fixture would pick the other device.
		// BOTH rows carry the full Phase-B detail payload, because the row this
		// spec drives is whichever one the app surfaces first — a roster where
		// only one entry is populated would make the card assertions depend on
		// the very ordering this test refuses to assume.
		const fullDetail = {
			data_usage: {
				session_bytes: 1_234_567,
				cycle_bytes: 8_765_432,
				cycle_day: 1,
				threshold_bytes: 50_000_000,
			},
			esim: { sim_type: "physical", esim_status: "unknown" },
			firmware_revision: "RM520NGLAAR01A08M4G",
			cell_info: { tech: "lte", cell_id: "0x01A2B3C4", band: "B3", rsrp: -92 },
		} as const;
		const roster: Record<string, Record<string, unknown>> = {
			"modem-secondary": mmManagedModem({
				ifname: "wwan1",
				name: "Secondary Radio",
				stable_key: "pci-0000:00:14.0-usb-0:3",
				slot_label: "SIM 2",
				...fullDetail,
			}),
			[MM_MODEM_ID]: mmManagedModem(fullDetail),
		};
		sendModems(roster);

		const rows = page.locator('[data-testid="modem-row"]');
		await expect(rows.first()).toBeVisible({ timeout: 15_000 });
		await expect(rows).toHaveCount(2);

		// DYNAMIC selection: whichever row the app actually surfaced first. The
		// dialog's title is the DEVICE name while the row's headline is the
		// CARRIER, so the expected title is looked up from the roster by the id
		// the DOM reported — never assumed to be the row's visible text, and
		// never a hardcoded index into the fixture.
		const firstRow = rows.first();
		const firstId = await firstRow.getAttribute("data-modem-id");
		expect(firstId, "the first rendered modem row must carry its id").toBeTruthy();
		const firstName = String(roster[String(firstId)]?.name ?? "");
		expect(firstName.length).toBeGreaterThan(0);

		// ── Config dialog: opens, renders its cards, closes, and can re-open ──
		const configure = firstRow.getByTestId("open-modem-config-dialog");
		await expect(configure).toBeEnabled();
		await configure.click();

		const configDialog = page.getByRole("dialog", { name: firstName });
		await expect(configDialog).toBeVisible({ timeout: 15_000 });
		// The dialog's own controls are reachable on BOTH surfaces — a Sheet that
		// renders its header and clips its body would still pass a bare
		// "is visible" check on the container alone.
		await openModemAdvanced(configDialog);
		await expect(configDialog.getByTestId("modem-usage-card")).toBeVisible();
		await expect(configDialog.getByTestId("modem-detail-card")).toBeVisible();
		await expect(configDialog.getByTestId("modem-usb-mode-card")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(configDialog).toBeHidden();
		// CLEANLY closed: the trigger underneath is interactive again, which a
		// leaked overlay / scroll lock / focus trap would prevent.
		await expect(configure).toBeEnabled();
		await configure.click();
		await expect(configDialog).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(configDialog).toBeHidden();

		// ── SIM unlock dialog: reached from the ROW, never by interception ────
		//
		// A blocking lock RENAMES the row's own control ("Unlock SIM") rather
		// than popping a modal over the whole destination. The auto-prompt this
		// leg used to assert was deliberately deleted (`0c9af22e`) and
		// `src/tests/sim-unlock-trigger-gate.test.ts` fails the build if one
		// returns — so the ABSENCE is asserted first, and only then the route
		// that replaced it.
		expect(firstId).not.toBeNull();
		sendModems({
			[String(firstId)]: {
				sim_lock: { required: "sim-pin", remainingAttempts: 3 },
			},
		});

		const unlock = firstRow.getByTestId("open-modem-unlock-dialog");
		await expect(unlock).toBeEnabled({ timeout: 15_000 });
		// The lock took over the row's action slot, so Configure is gone — the
		// config form behind it could apply nothing to an unregistered radio.
		await expect(firstRow.getByTestId("open-modem-config-dialog")).toHaveCount(0);
		// NOTHING opened on the broadcast alone.
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(page.getByTestId("sim-pin-input")).toHaveCount(0);

		await unlock.click();
		const pinInput = page.getByTestId("sim-pin-input");
		await expect(pinInput).toBeVisible({ timeout: 15_000 });
		const simDialog = page
			.getByRole("dialog")
			.filter({ has: page.getByTestId("sim-pin-input") });
		await expect(simDialog).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(pinInput).toBeHidden();
		// It stays closed: a dismissed dialog that re-opens itself would own every
		// click on the destination beneath it.
		await expect(page.getByTestId("sim-pin-input")).toHaveCount(0);

		// No dialog is left mounted, on either surface.
		await expect(page.getByRole("dialog")).toHaveCount(0);

		expect(pageErrors, `uncaught exceptions: ${pageErrors.join(" | ")}`).toEqual(
			[],
		);
		expect(
			consoleErrors,
			`console errors during the modem dialog click-walk: ${consoleErrors.join(" | ")}`,
		).toEqual([]);
	});
});
