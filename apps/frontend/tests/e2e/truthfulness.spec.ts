import fs from "node:fs";
import path from "node:path";

import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

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
// Drop the backend's own `devices` / `capabilities` / `sources` echoes so the
// INJECTED snapshots are authoritative — the backend's multi-modem-wifi profile
// reports its own capture device + a default caps/sources snapshot on connect,
// which would otherwise race the test-injected truth.
let dropServerDevices = false;
let dropServerCapabilities = false;
let dropServerSources = false;
// `status` is NOT blanket-dropped: unlike caps/devices/sources, most tests here do
// NOT inject their own `status` and DO rely on the real backend's initial `status`
// broadcast (asrcs, audio_sources, is_streaming, active_encode, network_ingest) to
// reach the page — e.g. the test-pattern test's source-select round-trip regresses
// without it. So a test opts in via the `drop-server-status` annotation (read in
// beforeEach BEFORE page.goto — the initial status burst must be dropped too, or the
// backend's typed `audio_sources` beats a test's asrcs-only injection).
let dropServerStatus = false;
const DROP_SERVER_STATUS_ANNOTATION = "drop-server-status";
// Fake-resolve every `streaming.setConfig` client-side with success so a config
// write is proven to succeed WITHOUT depending on the shared backend accepting the
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

// The StreamSetupChain renders all four setup rows ALWAYS (no collapse, no ready
// bar), so every migrated config-row edit trigger is permanently visible — just
// wait for the trigger and click it.
async function openConfigDialog(page: Page, testId: string): Promise<void> {
	const trigger = page.getByTestId(testId);
	await expect(trigger).toBeVisible({ timeout: 15_000 });
	await trigger.click();
}

test.describe("Capability truthfulness (functional)", () => {
	test.beforeEach(async ({ page }, testInfo) => {
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
		dropServerStatus = testInfo.annotations.some(
			(a) => a.type === DROP_SERVER_STATUS_ANNOTATION,
		);
		fakeSetConfig = false;
		setConfigCalls.length = 0;

		await page.routeWebSocket(/:(3002|31\d\d|8090|8091)\//, (ws) => {
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
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as object;
					if (dropServerDevices && "devices" in frame) return;
					if (dropServerCapabilities && "capabilities" in frame) return;
					if (dropServerSources && "sources" in frame) return;
					if (dropServerStatus && "status" in frame) return;
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
		serverConfig();
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
		// …classified by its engine kind (uvc_h264 → USB family), NOT hdmi…
		const kindBadge = page.getByTestId("source-kind-video-usb");
		await expect(kindBadge).toHaveAttribute("data-source-kind", "uvc_h264");
		await expect(kindBadge).toHaveText("USB");
		// …and the coarse "HDMI Capture" pipeline label never appears on the row.
		await expect(row).not.toContainText("HDMI Capture");
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

		serverConfig();
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
			resolution: "1080p",
			framerate: 30,
		});
		send(GENERIC_PIPELINES);
		sendFullCaps();
		sendSources([
			captureSource("video-hdmi", "hdmi", "hdmi", "Rockchip HDMI-RX", [
				{ width: 1920, height: 1080, framerates: [30] },
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

		// PHASE 1 — the device advertises only 1080p@30: 720p is disabled-with-reason
		// and 60fps at 1080p is disabled-with-reason (never hidden).
		await page.locator("#encoder-resolution").click();
		await expect(res1080).toBeVisible();
		await expect(res720).toHaveAttribute("aria-disabled", "true");
		await expect(res720).toHaveAttribute("title", /\S/);
		await expect(res1080).not.toHaveAttribute("aria-disabled", "true");
		await res1080.click();

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
		await expect(res720).not.toHaveAttribute("aria-disabled", "true");
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
			page.getByRole("option", { name: "Pipeline default" }),
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

	// ── (b) The test-pattern source appears once and resolves to pipeline 'test' ─
	test("the test-pattern source appears exactly once and selecting it persists a config whose pipeline is 'test'", async ({
		page,
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
				async () =>
					page.evaluate(async () => {
						const clientPath = "/src/lib/rpc/client.ts";
						const mod = await import(clientPath);
						const cfg = await mod.rpc.streaming.getConfig();
						return (cfg as { pipeline?: string } | undefined)?.pipeline;
					}),
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
		serverConfig();
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

	// ── (e) The migrated config-row testids still open their dialogs ────────────
	test("the migrated open-encoder / open-audio / open-server-dialog rows still open their dialogs", async ({
		page,
	}) => {
		serverConfig();
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
		serverConfig();
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
});
