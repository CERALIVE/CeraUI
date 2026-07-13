import type { Locator, Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo, setLocale } from "./helpers/index.js";

/**
 * Live-destination coherence audit (live-correctness-pass Audit A1, Todo #15).
 *
 * An agent-executed checklist walk that GENUINELY exercises the Live destination
 * + its Encoder / Audio / Server dialogs across the three capability tiers
 * (full caps, engine-starting floor, engine-unavailable cache), the live-cockpit
 * (streaming) state, and two locales (es + ar RTL). It is the rendered-DOM proof
 * of the coherence contract this whole pass rests on:
 *
 *   1. Every visible control is EITHER functional (dispatches its RPC / opens its
 *      dialog / is enabled) OR disabled with a NON-EMPTY reason (title/aria-label)
 *      — never a silent dead control.
 *   2. No visible text is a raw i18n dot-path leak (regex /^[a-z]+(\.[a-z]+)+$/i —
 *      the shape a `t()` key-passthrough miss renders) and no `undefined`/`NaN`
 *      fragment ever paints.
 *   3. Opening/closing every Live dialog raises no console error / unhandled
 *      rejection (page.on('pageerror') + a filtered console-error stream).
 *   4. EncoderDialog bitrate bounds + ServerDialog latency bounds come from the
 *      ValidationAdapter caps derivation (spot-asserted per tier — they genuinely
 *      flip when the injected caps change, never a stale bound).
 *   5. es + ar render the Live view (and a dialog) with NO missing-key artifact and
 *      ar flips <html dir="rtl">.
 *
 * Mechanism — IDENTICAL to truthfulness.spec.ts / source-overhaul.spec.ts (do NOT
 * invent a new one): every capability / status / sources snapshot is injected over
 * the page's own authenticated socket through a `routeWebSocket` proxy. There is
 * exactly ONE backend per worker (`MOCK_SCENARIO` fixed at boot); the proxy makes
 * the injected frames authoritative by dropping the backend's own capabilities /
 * devices / sources echoes, and can rewrite `status.is_streaming` so the live
 * cockpit renders without a real stream. Per-tier scenario state that injection
 * cannot reach (RPC-handler state) is left to the per-worker backend — this audit
 * needs none of it, so no `backendScenario` override is used.
 *
 * PLAYBOOK.md compliance: role / testid / web-first assertions only — no
 * pixel-screenshot capture, no fixed-delay waits, no hardcoded nav-tab selectors.
 */

// ── Test-owned proxy control state (reset per test in beforeEach) ────────────
let pageWs: WebSocketRoute | null = null;
// Drop the backend's own echoes so the INJECTED snapshots are authoritative.
let dropServerDevices = false;
let dropServerCapabilities = false;
let dropServerSources = false;
// When true, every server→client `status` frame is rewritten to is_streaming=true
// so the live cockpit renders without a real stream (the mock would otherwise keep
// it idle). Mirrors source-overhaul's `controlStreaming`.
let controlStreaming = false;
// Per-test console/pageerror capture — asserted empty at the end of every test so
// EVERY scenario doubles as a "no undefined-RPC / no render crash" gate.
const RPC_FAILURE_RE =
	/is not a function|is not defined|undefined is not|cannot read propert|rpc\.[a-z]/i;
let pageErrors: string[] = [];
let rpcConsoleErrors: string[] = [];

function send(payload: unknown): void {
	pageWs?.send(JSON.stringify(payload));
}

// A configured custom+managed server keeps LiveView out of its empty state so the
// source surface + setup rows render; `source` makes the Start gate resolvable.
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

// Deterministic single-source board fixture (software/generic, 1080p ceiling).
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
 * A schema-valid `capabilities` snapshot; `extra` shallow-overrides the base full
 * engine profile (H.265 + hardware accel, SRT transport, 2000‥12000 kbps window).
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

// ── The three capability snapshots the audit walks ───────────────────────────
// FULL CAPS — H.265 on, audio live-switch, 2 s…8 s latency, SRT advertised.
function sendFullCaps(): void {
	sendCapabilities({
		audio_live_switch: true,
		latency_range: { min: 2000, default: 4000, max: 8000 },
	});
}
// ENGINE-STARTING FLOOR — minimal safe floor while the engine boots: no H.265,
// no hardware accel, 2000‥6000 kbps, NO latency_range (→ DEFAULT 2 s…5 s window).
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
// ENGINE-UNAVAILABLE CACHED — last-known-good full caps preserved, flag raised.
function sendEngineUnavailableCached(): void {
	sendCapabilities({
		audio_live_switch: true,
		latency_range: { min: 2000, default: 4000, max: 8000 },
		engineUnavailable: true,
	});
}

// ── Unified device-first source fixtures (the `sources` broadcast) ───────────
type Mode = { width: number; height: number; framerates: number[] };
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
const SRC_HDMI_CAP = captureSource("video-hdmi", "hdmi", "hdmi", "Rockchip HDMI-RX");

function networkSource(proto: "rtmp" | "srt", active: boolean): Record<string, unknown> {
	return {
		origin: "network",
		id: proto,
		pipelineId: proto,
		labelKey: `settings.sources.${proto}`,
		requiresGateway: proto,
		url: active ? `${proto}://192.168.1.100/publish/live` : null,
		modes: [],
		supportsAudio: true,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: "embedded",
		available: active,
		...(active ? {} : { unavailableReason: "live.education.reason.gatewayInactive" }),
	};
}

function sendSources(sources: Record<string, unknown>[]): void {
	send({ sources: { hardware: "rk3588", sources } });
}

// ── i18n-leak + undefined/NaN scanner ────────────────────────────────────────
// The exact shape a `t()` key-passthrough miss renders: a dotted lowercase path
// with no spaces/digits (e.g. "live.source.label"). "127.0.0.1" / "1.5 s" never
// match (digits / spaces), so this is a low-false-positive leak detector.
const DOT_PATH_RE = /^[a-z]+(\.[a-z]+)+$/i;

interface LeakScan {
	dotPaths: string[];
	badFragments: string[];
}

/** Collect visible text nodes under `scope` and flag i18n leaks + undefined/NaN. */
async function scanForLeaks(scope: Locator): Promise<LeakScan> {
	return scope.evaluate((el, dotPathSource) => {
		const dotPath = new RegExp(dotPathSource, "i");
		const dotPaths = new Set<string>();
		const badFragments = new Set<string>();
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			const parent = node.parentElement;
			const raw = (node.textContent ?? "").trim();
			node = walker.nextNode();
			if (!parent || raw.length === 0) continue;
			const tag = parent.tagName;
			if (tag === "SCRIPT" || tag === "STYLE") continue;
			const style = getComputedStyle(parent);
			if (style.display === "none" || style.visibility === "hidden") continue;
			const rect = parent.getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) continue;
			if (dotPath.test(raw)) dotPaths.add(raw);
			if (/\bundefined\b/.test(raw) || /\bNaN\b/.test(raw)) badFragments.add(raw);
		}
		return { dotPaths: [...dotPaths], badFragments: [...badFragments] };
	}, DOT_PATH_RE.source);
}

/**
 * Every visible disabled control under `scope` that carries NO reason (empty
 * title AND empty aria-label) — a "silent dead control". A disabled control must
 * always explain itself. Returns a short identity for each offender.
 */
async function silentDisabledControls(scope: Locator): Promise<string[]> {
	return scope.evaluate((root) => {
		const offenders: string[] = [];
		const controls = root.querySelectorAll(
			'button, [role="radio"], [role="option"], [role="slider"]',
		);
		for (const el of Array.from(controls)) {
			const isDisabled =
				(el as HTMLButtonElement).disabled === true ||
				el.getAttribute("aria-disabled") === "true";
			if (!isDisabled) continue;
			const rect = (el as HTMLElement).getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) continue;
			const title = (el.getAttribute("title") ?? "").trim();
			const ariaLabel = (el.getAttribute("aria-label") ?? "").trim();
			if (title.length === 0 && ariaLabel.length === 0) {
				const id = el.getAttribute("data-testid") ?? el.tagName.toLowerCase();
				offenders.push(`${id}:${(el.textContent ?? "").trim().slice(0, 24)}`);
			}
		}
		return offenders;
	});
}

async function openConfigDialog(page: Page, testId: string): Promise<void> {
	const trigger = page.getByTestId(testId);
	await expect(trigger).toBeVisible({ timeout: 15_000 });
	await trigger.click();
}

test.describe("Live destination coherence audit", { tag: "@audit" }, () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the Live capability surfaces; mobile/RTL layout is the @visual suite",
		);

		pageWs = null;
		dropServerDevices = true;
		dropServerCapabilities = true;
		dropServerSources = true;
		controlStreaming = false;
		pageErrors = [];
		rpcConsoleErrors = [];

		page.on("pageerror", (err) => pageErrors.push(String(err)));
		page.on("console", (msg) => {
			if (msg.type() === "error" && RPC_FAILURE_RE.test(msg.text())) {
				rpcConsoleErrors.push(msg.text());
			}
		});

		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as Record<string, unknown>;
					if (dropServerDevices && "devices" in frame) return;
					if (dropServerCapabilities && "capabilities" in frame) return;
					if (dropServerSources && "sources" in frame) return;
					if (controlStreaming && "status" in frame) {
						const status = frame.status as Record<string, unknown> | undefined;
						if (status && typeof status === "object") {
							status.is_streaming = true;
							ws.send(JSON.stringify(frame));
							return;
						}
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

	test.afterEach(() => {
		expect(pageErrors, `uncaught exceptions: ${pageErrors.join(" | ")}`).toEqual([]);
		expect(
			rpcConsoleErrors,
			`undefined-RPC console errors: ${rpcConsoleErrors.join(" | ")}`,
		).toEqual([]);
	});

	// ── (full caps) Idle cockpit is coherent: Start functional, no leaks, no silent controls ──
	test("full-caps idle cockpit renders coherently — Start is functional and nothing leaks or dies silently", async ({
		page,
	}) => {
		serverConfig({ source: "video-hdmi" });
		send(GENERIC_PIPELINES);
		sendFullCaps();
		sendSources([SRC_HDMI_CAP]);

		const idle = page.getByTestId("idle-cockpit");
		await expect(idle).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("stream-setup-chain")).toBeVisible();

		// Start is a REAL, enabled control when every gate is green (functional).
		const start = page.getByRole("button", { name: /start stream/i });
		await expect(start).toBeEnabled();

		// No capability-tier banner in the normal tier.
		await expect(page.getByTestId("capability-engine-starting")).toHaveCount(0);
		await expect(page.getByTestId("capability-engine-unavailable")).toHaveCount(0);

		// No i18n dot-path leak and no undefined/NaN across the whole idle cockpit
		// AND the Live header region.
		const leaks = await scanForLeaks(page.getByRole("main").first());
		expect(leaks.dotPaths, `i18n dot-path leaks: ${leaks.dotPaths.join(", ")}`).toEqual([]);
		expect(leaks.badFragments, `undefined/NaN fragments: ${leaks.badFragments.join(", ")}`).toEqual(
			[],
		);

		// No silent disabled control anywhere in the idle cockpit.
		const silent = await silentDisabledControls(idle);
		expect(silent, `silent disabled controls: ${silent.join(", ")}`).toEqual([]);
	});

	// ── (engine-starting) Banner + H.265 disabled-with-reason + tightened bounds ──
	test("engine-starting tier shows the calm banner, disables H.265 with a reason, and floors the encoder+latency bounds", async ({
		page,
	}) => {
		serverConfig({ source: "video-hdmi" });
		send(GENERIC_PIPELINES);
		sendEngineStartingFloor();
		sendSources([SRC_HDMI_CAP]);

		// The calm starting banner is a role=status surface (never an error toast).
		const banner = page.getByTestId("capability-engine-starting");
		await expect(banner).toBeVisible({ timeout: 15_000 });
		await expect(banner).toHaveAttribute("role", "status");

		// Encoder: H.265 disabled WITH a non-empty reason; bitrate floored to 2000‥6000.
		await openConfigDialog(page, "open-encoder-dialog");
		const dialog = page.getByRole("dialog", { name: "Encoder Settings" });
		await expect(dialog).toBeVisible({ timeout: 15_000 });

		const h265 = dialog.getByTestId("codec-h265");
		await expect(h265).toBeDisabled();
		await expect(h265).toHaveAttribute("title", /\S/);

		const bitrate = page.locator("#encoder-bitrate");
		await expect(bitrate).toHaveAttribute("min", "2000");
		await expect(bitrate).toHaveAttribute("max", "6000");

		// The dialog itself carries no leaks / undefined-NaN.
		const dialogLeaks = await scanForLeaks(dialog);
		expect(dialogLeaks.dotPaths, `encoder dialog leaks: ${dialogLeaks.dotPaths.join(", ")}`).toEqual(
			[],
		);
		expect(dialogLeaks.badFragments).toEqual([]);
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();

		// Server: the latency slider floors to the DEFAULT 2 s…5 s window (no
		// latency_range advertised) — a genuine flip, never a stale 8 s.
		await openConfigDialog(page, "open-server-dialog");
		const slider = page.getByTestId("latency-slider");
		await expect(slider).toBeVisible({ timeout: 15_000 });
		await expect(slider).toHaveAttribute("aria-valuemin", "2000");
		await expect(slider).toHaveAttribute("aria-valuemax", "5000");
	});

	// ── (engine-unavailable) Banner + cached full caps restore controls + bounds ──
	test("engine-unavailable tier shows the cached banner while the cached caps re-enable H.265 and restore the wide bounds", async ({
		page,
	}) => {
		serverConfig({ source: "video-hdmi" });
		send(GENERIC_PIPELINES);
		sendEngineUnavailableCached();
		sendSources([SRC_HDMI_CAP]);

		const banner = page.getByTestId("capability-engine-unavailable");
		await expect(banner).toBeVisible({ timeout: 15_000 });
		await expect(banner).toHaveAttribute("role", "status");

		// Encoder: cached snapshot still advertises H.265 → the control re-enables;
		// bitrate window restored to 2000‥12000.
		await openConfigDialog(page, "open-encoder-dialog");
		const dialog = page.getByRole("dialog", { name: "Encoder Settings" });
		await expect(dialog).toBeVisible({ timeout: 15_000 });
		await expect(dialog.getByTestId("codec-h265")).toBeEnabled();
		const bitrate = page.locator("#encoder-bitrate");
		await expect(bitrate).toHaveAttribute("min", "2000");
		await expect(bitrate).toHaveAttribute("max", "12000");
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();

		// Server: cached 2 s…8 s latency window honored again.
		await openConfigDialog(page, "open-server-dialog");
		const slider = page.getByTestId("latency-slider");
		await expect(slider).toBeVisible({ timeout: 15_000 });
		await expect(slider).toHaveAttribute("aria-valuemax", "8000");
	});

	// ── (bounds) Encoder bitrate bounds flip with the injected caps (ValidationAdapter) ──
	test("the encoder bitrate bounds track the ValidationAdapter caps derivation across all three tiers", async ({
		page,
	}) => {
		serverConfig({ source: "video-hdmi" });
		send(GENERIC_PIPELINES);
		sendFullCaps();
		sendSources([SRC_HDMI_CAP]);

		await openConfigDialog(page, "open-encoder-dialog");
		await expect(page.getByRole("dialog", { name: "Encoder Settings" })).toBeVisible({
			timeout: 15_000,
		});
		const bitrate = page.locator("#encoder-bitrate");

		// FULL CAPS → the board window is 2000‥12000.
		await expect(bitrate).toHaveAttribute("max", "12000");

		// ENGINE-STARTING FLOOR → the SAME control genuinely floors to 2000‥6000.
		sendEngineStartingFloor();
		await expect(bitrate).toHaveAttribute("max", "6000");
		await expect(bitrate).toHaveAttribute("min", "2000");

		// ENGINE-UNAVAILABLE CACHED → the cached window is honored again (2000‥12000).
		sendEngineUnavailableCached();
		await expect(bitrate).toHaveAttribute("max", "12000");
	});

	// ── (dialogs) All three Live dialogs open + close leak-free with no console error ──
	test("the Encoder / Audio / Server dialogs each open and close leak-free", async ({ page }) => {
		serverConfig({ source: "video-hdmi" });
		send(GENERIC_PIPELINES);
		sendFullCaps();
		sendSources([SRC_HDMI_CAP]);

		const dialogs: Array<[string, string]> = [
			["open-encoder-dialog", "Encoder Settings"],
			["open-audio-dialog", "Audio Settings"],
			["open-server-dialog", "Receiver Server"],
		];
		for (const [testId, name] of dialogs) {
			await openConfigDialog(page, testId);
			const dialog = page.getByRole("dialog", { name });
			await expect(dialog).toBeVisible({ timeout: 15_000 });
			if (name === "Receiver Server") {
				await expect(dialog.getByTestId("destination-ceralive")).toBeEnabled();
			}

			// Each opened dialog is leak-free and hosts no silent disabled control.
			const leaks = await scanForLeaks(dialog);
			expect(leaks.dotPaths, `${name} dot-path leaks: ${leaks.dotPaths.join(", ")}`).toEqual([]);
			expect(leaks.badFragments, `${name} undefined/NaN: ${leaks.badFragments.join(", ")}`).toEqual(
				[],
			);
			const silent = await silentDisabledControls(dialog);
			expect(silent, `${name} silent disabled controls: ${silent.join(", ")}`).toEqual([]);

			await page.keyboard.press("Escape");
			await expect(dialog).toBeHidden();
		}
	});

	// ── (gateway) A network-ingest source row is disabled WITH a reason (never silent) ──
	test("a gateway-down network source row is disabled with a non-empty reason, never a silent control", async ({
		page,
	}) => {
		serverConfig({ source: "video-hdmi" });
		send(GENERIC_PIPELINES);
		sendFullCaps();
		sendSources([SRC_HDMI_CAP, networkSource("rtmp", false)]);

		const row = page.getByTestId("source-network-ingest-select-rtmp");
		await expect(row).toBeVisible({ timeout: 15_000 });
		await expect(row).toBeDisabled();
		await expect(row).toHaveAttribute("title", /\S/);
		await expect(page.getByTestId("source-network-ingest-reason-rtmp")).toBeVisible();

		// The reason text is a rendered i18n string, never the raw dot-path key.
		const reason = await page.getByTestId("source-network-ingest-reason-rtmp").innerText();
		expect(reason.trim()).not.toMatch(DOT_PATH_RE);
	});

	// ── (live cockpit) Injecting is_streaming=true swaps to the live cockpit ──────
	test("injecting is_streaming=true renders the live cockpit with a functional Stop and no leaks", async ({
		page,
	}) => {
		controlStreaming = true;
		serverConfig({ source: "video-hdmi" });
		send(GENERIC_PIPELINES);
		sendFullCaps();
		sendSources([SRC_HDMI_CAP]);
		// Push a high-seq streaming status so the optimistic cockpit swaps promptly.
		send({ status: { is_streaming: true, seq: 9_000_001 } });

		const cockpit = page.getByTestId("live-cockpit");
		await expect(cockpit).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("idle-cockpit")).toHaveCount(0);

		// Stop is the functional live control.
		const stop = page.getByRole("button", { name: /stop stream/i });
		await expect(stop).toBeVisible();
		await expect(stop).toBeEnabled();

		// The live cockpit is leak-free and hosts no silent disabled control.
		const leaks = await scanForLeaks(cockpit);
		expect(leaks.dotPaths, `live cockpit leaks: ${leaks.dotPaths.join(", ")}`).toEqual([]);
		expect(leaks.badFragments, `live cockpit undefined/NaN: ${leaks.badFragments.join(", ")}`).toEqual(
			[],
		);
		const silent = await silentDisabledControls(cockpit);
		expect(silent, `live cockpit silent disabled controls: ${silent.join(", ")}`).toEqual([]);
	});

	// ── (locale es) The Live view renders in Spanish with no missing-key artifact ──
	test("the Live view renders in Spanish with no missing-key artifact", async ({ page }) => {
		await setLocale(page, "es");
		await page.reload();
		await ensureAuthenticated(page);
		await navigateTo(page, "live");

		serverConfig({ source: "video-hdmi" });
		send(GENERIC_PIPELINES);
		sendFullCaps();
		sendSources([SRC_HDMI_CAP]);

		await expect(page.getByTestId("idle-cockpit")).toBeVisible({ timeout: 15_000 });
		const leaks = await scanForLeaks(page.getByRole("main").first());
		expect(leaks.dotPaths, `es dot-path leaks: ${leaks.dotPaths.join(", ")}`).toEqual([]);
		expect(leaks.badFragments, `es undefined/NaN: ${leaks.badFragments.join(", ")}`).toEqual([]);

		// A dialog also renders leak-free under es.
		await openConfigDialog(page, "open-server-dialog");
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 15_000 });
		const dialogLeaks = await scanForLeaks(dialog);
		expect(dialogLeaks.dotPaths, `es dialog leaks: ${dialogLeaks.dotPaths.join(", ")}`).toEqual([]);
		expect(dialogLeaks.badFragments).toEqual([]);
	});

	// ── (locale ar RTL) The Live view renders RTL with no missing-key artifact ────
	test("the Live view renders in Arabic (RTL) with dir=rtl and no missing-key artifact", async ({
		page,
	}) => {
		await setLocale(page, "ar");
		await page.reload();
		await ensureAuthenticated(page);
		await navigateTo(page, "live");

		serverConfig({ source: "video-hdmi" });
		send(GENERIC_PIPELINES);
		sendFullCaps();
		sendSources([SRC_HDMI_CAP]);

		await expect(page.getByTestId("idle-cockpit")).toBeVisible({ timeout: 15_000 });
		// Arabic flips the document to RTL — the layout contract every RTL surface relies on.
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

		const leaks = await scanForLeaks(page.getByRole("main").first());
		expect(leaks.dotPaths, `ar dot-path leaks: ${leaks.dotPaths.join(", ")}`).toEqual([]);
		expect(leaks.badFragments, `ar undefined/NaN: ${leaks.badFragments.join(", ")}`).toEqual([]);

		// A dialog also renders leak-free under ar (RTL).
		await openConfigDialog(page, "open-encoder-dialog");
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 15_000 });
		const dialogLeaks = await scanForLeaks(dialog);
		expect(dialogLeaks.dotPaths, `ar dialog leaks: ${dialogLeaks.dotPaths.join(", ")}`).toEqual([]);
		expect(dialogLeaks.badFragments).toEqual([]);
	});
});
