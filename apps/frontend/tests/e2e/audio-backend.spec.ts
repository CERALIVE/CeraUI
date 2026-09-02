import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, type PageRpc, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * The engine audio-backend selector (trixie-pipewire-build-audit todo 20).
 *
 * TWO scenarios, and they are driven by DIFFERENT mechanisms on purpose:
 *
 *   1. SELECT PIPEWIRE — the capability is injected over the page's own socket
 *      (the sanctioned `source-overhaul.spec.ts` proxy pattern) and the write is
 *      answered client-side so the persistence PAYLOAD can be asserted verbatim.
 *      The reflection is then proved TWICE: from the applied echo, and again from
 *      the device's own `config` broadcast, which is the path a reload takes.
 *
 *   2. REFUSED WRITE — no faking at all. The per-worker backend really does
 *      refuse `audio_backend` with the typed `audio_backend_unsupported`, because
 *      its `capabilities.audio_backends` block is genuinely absent and todo 19's
 *      acceptance gate FAILS CLOSED on that. Injecting a capability the device
 *      does not share reproduces the exact race the error band exists for — the
 *      UI's evidence and the device's evidence disagreeing — so the operator's
 *      typed refusal is the REAL one, end to end.
 *
 * PLAYBOOK.md compliance: testid / web-first assertions only, no fixed-delay
 * waits, no pixel capture.
 */

// The audio dialog opens through the source surface, which needs a settled
// `sources` broadcast; a cold worker backend can take a moment to seed one.
test.describe.configure({ timeout: 90_000 });

let pageWs: WebSocketRoute | null = null;
// The injected capability/config/sources snapshots are authoritative here: the
// backend's own echoes would otherwise race them, and the whole point of
// scenario 1 is that the UI is offering exactly what the test stated.
let dropServerCapabilities = false;
let dropServerConfig = false;
let dropServerSources = false;
// Answer `streaming.setConfig` client-side (scenario 1 only) so the persistence
// payload is assertable without depending on the backend accepting a backend it
// has no capability evidence for.
let fakeSetConfig = false;
const setConfigCalls: Record<string, unknown>[] = [];

function send(payload: unknown): void {
	pageWs?.send(JSON.stringify(payload));
}

/** A configured destination + a selected source: the audio surface renders. */
function baseConfig(extra: Record<string, unknown> = {}): void {
	send({
		config: {
			srtla_addr: "127.0.0.1",
			srtla_port: 5000,
			srt_streamid: "e2e",
			max_br: 6000,
			pipeline: "hdmi",
			source: "hdmi",
			asrc: "USB audio",
			...extra,
		},
	});
}

/** The audio gate reads the pipeline registry CeraUI projects from `sources`. */
function sendSources(): void {
	send({
		sources: {
			hardware: "rk3588",
			sources: [
				{
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
				},
			],
		},
	});
}

/**
 * A schema-valid `capabilities` snapshot. `audio_backends` is the ONLY thing a
 * selector may be offered on — absent, it renders zero nodes.
 */
function sendCapabilities(audioBackends?: Record<string, unknown>): void {
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
			transports: ["srtla"],
			...(audioBackends ? { audio_backends: audioBackends } : {}),
		},
	});
}

async function openAudioDialog(page: Page) {
	const trigger = page.getByTestId("open-audio-dialog");
	await expect(trigger).toBeVisible({ timeout: 30_000 });
	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "Audio Settings" });
	await expect(dialog).toBeVisible({ timeout: 15_000 });
	return dialog;
}

test.describe("Engine audio backend selector (functional)", () => {
	test.beforeEach(async ({ page, pageRpc }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"the selector is a desktop-layout dialog surface; other projects add no coverage",
		);

		pageWs = null;
		dropServerCapabilities = true;
		dropServerConfig = true;
		dropServerSources = true;
		fakeSetConfig = false;
		setConfigCalls.length = 0;

		await installProxy(page, pageRpc);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
	});

	// ── (1) select pipewire ⇒ persisted + reflected ───────────────────────────
	test("selecting PipeWire persists exactly that field and the selection reflects it", async ({
		page,
	}) => {
		fakeSetConfig = true;
		baseConfig();
		sendSources();
		// The engine advertises BOTH arms and is RUNNING alsa. Nothing is stated in
		// config, so the resting selection must be the engine's own active arm.
		sendCapabilities({ supported: ["alsa", "pipewire"], active: "alsa" });

		const dialog = await openAudioDialog(page);
		const section = dialog.getByTestId("audio-backend");
		await expect(section).toBeVisible();

		const alsa = dialog.getByTestId("audio-backend-alsa");
		const pipewire = dialog.getByTestId("audio-backend-pipewire");
		await expect(alsa).toHaveAttribute("aria-checked", "true");
		await expect(pipewire).toHaveAttribute("aria-checked", "false");
		await expect(dialog.getByTestId("audio-backend-active")).toContainText("ALSA");

		await pipewire.click();

		// PERSISTED: the write carries the backend field and nothing else.
		await expect
			.poll(() => setConfigCalls.length, { timeout: 15_000 })
			.toBeGreaterThan(0);
		expect(setConfigCalls.at(-1)).toEqual({ audio_backend: "pipewire" });

		// REFLECTED (applied echo): the selection moved, and the dialog says the
		// change lands at the next start rather than pretending it is live.
		await expect(pipewire).toHaveAttribute("aria-checked", "true");
		await expect(alsa).toHaveAttribute("aria-checked", "false");
		await expect(dialog.getByTestId("audio-backend-next-start")).toBeVisible();
		await expect(dialog.getByTestId("audio-backend-error")).toHaveCount(0);

		// REFLECTED (device broadcast): the same value arriving on the device's own
		// `config` echo — the path a page reload takes — renders identically.
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toBeHidden();
		baseConfig({ audio_backend: "pipewire" });

		const reopened = await openAudioDialog(page);
		await expect(reopened.getByTestId("audio-backend-pipewire")).toHaveAttribute(
			"aria-checked",
			"true",
		);
	});

	// ── (2) mock AudioBackendUnavailable ⇒ error band ─────────────────────────
	test("a refused backend renders an explicit error band and leaves the selection put", async ({
		page,
	}) => {
		// NOT faked: the real backend's own capability block is absent, and todo
		// 19's gate fails CLOSED on that, so the write below is refused by the
		// device with the typed `audio_backend_unsupported`.
		baseConfig();
		sendSources();
		sendCapabilities({ supported: ["alsa", "pipewire"], active: "alsa" });

		const dialog = await openAudioDialog(page);
		const alsa = dialog.getByTestId("audio-backend-alsa");
		const pipewire = dialog.getByTestId("audio-backend-pipewire");
		await expect(alsa).toHaveAttribute("aria-checked", "true");

		await pipewire.click();

		const band = dialog.getByTestId("audio-backend-error");
		await expect(band).toBeVisible({ timeout: 15_000 });
		await expect(band).toHaveAttribute("role", "alert");
		// A refusal names its cause; it is never an empty band and never a raw token.
		await expect(band).toHaveText(/\S/);
		await expect(band).not.toHaveText(/audio_backend_unsupported/);

		// PESSIMISTIC: a refused write cannot move the control…
		await expect(alsa).toHaveAttribute("aria-checked", "true");
		await expect(pipewire).toHaveAttribute("aria-checked", "false");
		// …and nothing is left spinning — the band IS the end of the attempt.
		await expect(dialog.getByTestId("audio-backend-applying")).toHaveCount(0);
	});

	// ── The offer gate: absent capability ⇒ ZERO nodes ────────────────────────
	test("no selector is offered when the engine stated no audio-backend capability", async ({
		page,
	}) => {
		baseConfig();
		sendSources();
		sendCapabilities();

		const dialog = await openAudioDialog(page);
		// The dialog itself rendered, so the counts below are a real absence.
		await expect(dialog.locator("#audioCodec")).toBeVisible();
		await expect(dialog.getByTestId("audio-backend")).toHaveCount(0);
		await expect(dialog.getByTestId("audio-backend-alsa")).toHaveCount(0);
		await expect(dialog.getByTestId("audio-backend-pipewire")).toHaveCount(0);
	});
});

async function installProxy(page: Page, pageRpc: PageRpc): Promise<void> {
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
				if (dropServerCapabilities && "capabilities" in frame) return;
				if (dropServerConfig && "config" in frame) return;
				if (dropServerSources && "sources" in frame) return;
			} catch {
				/* non-JSON / binary frame */
			}
			ws.send(m);
		});
	});
}
