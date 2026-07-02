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
// Rewrite every incoming `status` frame's is_streaming to `streamingFlag` so the
// mock's own broadcast cannot settle the streaming state out from under a test.
let controlStreaming = false;
let streamingFlag = false;
// Drop the backend's own `devices` / `capabilities` echoes so the INJECTED
// snapshots are authoritative — the same rationale source-overhaul uses for
// `devices` (the backend's multi-modem-wifi profile reports its own capture
// device + a default caps snapshot on connect, which would otherwise race the
// test-injected truth).
let dropServerDevices = false;
let dropServerCapabilities = false;
// Hold the next `streaming.switchAudio` RPC in-flight (captures its id) so the
// per-field `applying` window is observable and the audio switch never mutates
// the shared mock backend; the proxy owns its result.
let holdSwitchAudio = false;
let heldSwitchAudioId: string | number | null = null;

function send(payload: unknown): void {
	pageWs?.send(JSON.stringify(payload));
}

/** Fake-resolve a held switchAudio RPC as a successful gapless switch. */
function resolveHeldSwitchAudio(gapMs: number, input: string): void {
	if (heldSwitchAudioId !== null) {
		pageWs?.send(
			JSON.stringify({
				id: heldSwitchAudioId,
				result: { success: true, active_audio_input: input, gap_ms: gapMs },
			}),
		);
		heldSwitchAudioId = null;
	}
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

test.describe("Capability truthfulness (functional)", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the capability surfaces; mobile/kiosk/RTL are the @visual suite",
		);

		pageWs = null;
		controlStreaming = false;
		streamingFlag = false;
		// Injected caps + device lists are authoritative for every test here (see
		// header contract): drop the backend's own echoes so only the test-injected
		// snapshots ever populate the capability-gated surfaces.
		dropServerDevices = true;
		dropServerCapabilities = true;
		holdSwitchAudio = false;
		heldSwitchAudioId = null;

		await page.routeWebSocket(/:(3002|31\d\d|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();

			ws.onMessage((m) => {
				if (holdSwitchAudio) {
					const text = typeof m === "string" ? m : m.toString();
					try {
						const frame = JSON.parse(text) as {
							id?: string | number;
							path?: unknown;
						};
						const rpc = Array.isArray(frame.path) ? frame.path.join(".") : null;
						if (rpc === "streaming.switchAudio") {
							heldSwitchAudioId = frame.id ?? null;
							return; // hold in-flight: the proxy owns the audio-switch result
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
					if (dropServerCapabilities && "capabilities" in (frame as object))
						return;
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

	// ── (a) Audio live-switch is gated off until the engine advertises it ───────
	test("the audio live-switch flips disabled-with-reason ⇄ enabled with the engine capability", async ({
		page,
	}) => {
		controlStreaming = true;
		streamingFlag = true;
		holdSwitchAudio = true;

		serverConfig();
		// Start WITHOUT audio_live_switch → the gate is off.
		sendCapabilities();
		send({ status: { is_streaming: true } });
		sendDevices("video0", [HDMI, MIC]);

		const picker = page.getByTestId("input-picker");
		await expect(picker).toBeVisible({ timeout: 15_000 });

		const audioSwitch = picker.locator('[data-switch-input="audio:mic0"]');
		await expect(audioSwitch).toBeVisible();

		// Capability absent → the live audio Switch is disabled and MUST carry a
		// non-empty reason (the frontend gate blocks any dispatch).
		await expect(audioSwitch).toBeDisabled();
		await expect(audioSwitch).toHaveAttribute("title", /\S/);

		// Engine now advertises audio_live_switch → the SAME control becomes a real,
		// enabled live switch with no disabled-reason tooltip.
		sendCapabilities({ audio_live_switch: true });
		await expect(audioSwitch).toBeEnabled();
		await expect(audioSwitch).not.toHaveAttribute("title", /.+/);

		// And it truly dispatches: a click sends switchAudio (the proxy captures it)
		// and surfaces the per-field applying glyph — proving it is not a dead
		// control that merely LOOKS enabled.
		await audioSwitch.click();
		await expect(page.getByText(/switching audio/i)).toBeVisible();
		expect(heldSwitchAudioId).not.toBeNull();
		holdSwitchAudio = false;
		resolveHeldSwitchAudio(12, "audio:mic0");
		await expect(page.getByText(/audio switched/i).first()).toBeVisible();
	});

	// ── (a) Network-ingest rows: disabled-with-reason MUST carry a title ────────
	test("a network-ingest source row flips disabled-with-reason ⇄ selectable with its gateway", async ({
		page,
	}) => {
		serverConfig();
		send(GENERIC_PIPELINES);
		sendFullCaps();
		// RTMP gateway present but its systemd service is DOWN → the row is a real
		// source that is temporarily unavailable, so it renders disabled with a
		// reason (never hidden, never a coming-soon/data-debt treatment).
		send({
			status: {
				network_ingest: {
					rtmp: {
						service_active: false,
						url: "rtmp://192.168.1.100:1935/publish/live",
					},
					srt: null,
				},
			},
		});

		const row = page.getByTestId("network-ingest-select-rtmp");
		await expect(row).toBeVisible({ timeout: 15_000 });
		await expect(row).toBeDisabled();
		await expect(row).toHaveAttribute("title", /\S/);

		// Gateway comes up → the SAME row becomes selectable and drops its reason.
		send({
			status: {
				network_ingest: {
					rtmp: {
						service_active: true,
						url: "rtmp://192.168.1.100:1935/publish/live",
					},
					srt: null,
				},
			},
		});
		await expect(row).toBeEnabled();
		await expect(row).not.toHaveAttribute("title", /.+/);
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
		await expect(page.getByRole("main")).toBeVisible();
		await navigateTo(page, "settings");
		await expect(page.getByRole("main")).toBeVisible();
		await navigateTo(page, "live");

		expect(pageErrors, `uncaught exceptions: ${pageErrors.join(" | ")}`).toEqual(
			[],
		);
		expect(
			rpcConsoleErrors,
			`undefined-RPC console errors: ${rpcConsoleErrors.join(" | ")}`,
		).toEqual([]);
	});
});
