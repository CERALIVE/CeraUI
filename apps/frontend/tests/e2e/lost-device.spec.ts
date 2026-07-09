import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * Lost-device lifecycle — the CAPSTONE e2e for the C7 chain (coherence-contract-
 * pass todo 24). It proves, end-to-end through the REAL Svelte app + dev mock
 * backend, that unplugging the configured capture device is a calm, honest,
 * fully-recoverable state — never a data-loss trap and never a lie about what the
 * device can do.
 *
 * DRIVEN BY THE REAL SEAM (per the plan): the detach/reattach transitions are the
 * REAL `streaming.setMockDeviceAttached` RPC (todo 16), forwarded to the per-worker
 * backend so its own `buildSources` synthesizes the lost row and rebroadcasts the
 * `sources`/`devices` snapshots — exactly the on-device path. The direct
 * `streaming.start` refusal is likewise the REAL backend gate
 * (`resolveSourceRouting` → `source_lost`), so the asserted `{success,error}`
 * shape is a genuine wire code, not a client-side fake.
 *
 * The proxy from `source-overhaul.spec.ts` / `truthfulness.spec.ts` is reused as
 * the transport (do NOT invent a new mechanism). For the real-seam lifecycle it is
 * a pure pass-through (no drops, no fakes). The ONE place the seam cannot reach is
 * the start-failure TOAST copy: a lost source disables the Start button (the source
 * readiness gate blocks it), so the button path can only be exercised against a
 * GREEN source whose start the proxy refuses with `source_lost` — the sanctioned
 * "fall back to the inject pattern only where the seam is not reachable".
 *
 * PLAYBOOK.md compliance: role / testid / web-first assertions only — no pixel
 * capture, no fixed-delay waits, no hardcoded nav-tab selectors.
 *
 * Default backend scenario `multi-modem-wifi` (fullProfile) advertises TWO capture
 * sources: `hdmi` (kind hdmi) and `usb` (kind uvc_h264, real name
 * "RØDE HDMI to USB-C: RØDE HDMI", bridged to the coarse `libuvch264` pipeline).
 * Detaching `usb` is the canonical single-device unplug.
 */

// The RØDE dongle's real display name — the row must show it verbatim (never the
// coarse "HDMI Capture" / `libuvch264` pipeline label) both live and when lost.
const RODE_DISPLAY_NAME = "RØDE HDMI to USB-C: RØDE HDMI";

// ── Test-owned proxy control state (reset per test in each describe's beforeEach) ─
let pageWs: WebSocketRoute | null = null;
// When set, the proxy REFUSES the next `streaming.start` client-side with this
// reason (never touching the shared backend) so the button-path toast is testable
// against a GREEN source. Null → the real backend answers every start.
let fakeStartReason: string | null = null;
// Drop the backend's own `devices` / `sources` echoes so an INJECTED green source
// list is authoritative (used only by the inject describe).
let dropServerDevices = false;
let dropServerSources = false;

function send(payload: unknown): void {
	pageWs?.send(JSON.stringify(payload));
}

/**
 * Install the shared WS proxy on the page. It forwards auth + RPC traffic to the
 * per-worker backend untouched, EXCEPT: it can refuse `streaming.start` with a
 * fake reason (button-path toast test) and can drop the backend's `devices` /
 * `sources` echoes (so an injected green source list wins).
 */
async function installWsProxy(page: Page): Promise<void> {
	await page.routeWebSocket(/:(3002|31\d\d|8090|8091)\//, (ws) => {
		pageWs = ws;
		const server = ws.connectToServer();

		ws.onMessage((m) => {
			if (fakeStartReason) {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as {
						id?: string | number;
						path?: unknown;
					};
					const rpc = Array.isArray(frame.path) ? frame.path.join(".") : null;
					if (rpc === "streaming.start" && frame.id !== undefined) {
						// Refuse client-side — NEVER mutate the shared backend's stream
						// state — with the exact structured shape the source_lost gate emits.
						ws.send(
							JSON.stringify({
								id: frame.id,
								result: {
									success: false,
									is_streaming: false,
									error: fakeStartReason,
									reason: fakeStartReason,
								},
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
				if (dropServerDevices && "devices" in frame) return;
				if (dropServerSources && "sources" in frame) return;
			} catch {
				/* non-JSON / binary frame */
			}
			ws.send(m);
		});
	});
}

// ── Page-context RPC helpers — the REAL seam, dialled over the page's own socket ─
// Mirrors truthfulness.spec.ts's `import(clientPath)` pattern (a const specifier so
// the dynamic import is a browser-resolved module, not a build-graph dependency).

type AttachResult = { success: boolean; error?: string };
type StartResult = {
	success: boolean;
	is_streaming?: boolean;
	error?: string;
	reason?: string;
};

/** Drive the REAL `streaming.setMockDeviceAttached` (todo 16) from the page. */
async function setDeviceAttached(
	page: Page,
	inputId: string,
	attached: boolean,
): Promise<AttachResult> {
	return page.evaluate(
		async ({ inputId, attached }) => {
			const clientPath = "/src/lib/rpc/client.ts";
			const mod = await import(clientPath);
			return (await mod.rpc.streaming.setMockDeviceAttached({
				input_id: inputId,
				attached,
			})) as { success: boolean; error?: string };
		},
		{ inputId, attached },
	);
}

/** Dispatch the REAL `streaming.start` from the page — its wire codes are asserted. */
async function directStartStream(page: Page, source: string): Promise<StartResult> {
	return page.evaluate(
		async ({ source }) => {
			const clientPath = "/src/lib/rpc/client.ts";
			const mod = await import(clientPath);
			return (await mod.rpc.streaming.start({ source })) as {
				success: boolean;
				is_streaming?: boolean;
				error?: string;
				reason?: string;
			};
		},
		{ source },
	);
}

/** Persist config fields over the REAL `streaming.setConfig` from the page. */
async function setConfig(
	page: Page,
	fields: Record<string, unknown>,
): Promise<void> {
	await page.evaluate(async (fields) => {
		const clientPath = "/src/lib/rpc/client.ts";
		const mod = await import(clientPath);
		await mod.rpc.streaming.setConfig(fields);
	}, fields);
}

test.describe("lost-device lifecycle (real seam)", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the source surface; mobile/kiosk/RTL are the @visual suite",
		);

		pageWs = null;
		// Pure pass-through: the real backend's source truth flows unaltered so the
		// REAL buildSources lost-row synthesis (todo 16) is what the UI renders.
		fakeStartReason = null;
		dropServerDevices = false;
		dropServerSources = false;

		await installWsProxy(page);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
	});

	// Best-effort cleanup: reattach `usb` so a test that leaves it detached (the
	// reload case) never bleeds into a later test's initial state (same per-worker
	// backend across the file). Swallow errors — a torn-down page is not a failure.
	test.afterEach(async ({ page }) => {
		await setDeviceAttached(page, "usb", true).catch(() => {});
	});

	test("select → detach (grayed row, no coarse duplicate, blocked start) → source_lost wire codes → reattach recovery", async ({
		page,
	}) => {
		// Guarantee a destination target so the reattach Start-enabled gate is
		// deterministic regardless of the seeded config.json (real setConfig).
		await setConfig(page, {
			srtla_addr: "127.0.0.1",
			srtla_port: 5000,
			srt_streamid: "e2e",
		});

		// ── 1. Select the RØDE USB capture — config.source persists. ──────────────
		const usbRow = page.getByTestId("source-row-usb");
		await expect(usbRow).toBeVisible({ timeout: 15_000 });
		// Even while ATTACHED there is NO coarse `libuvch264` row: the capture device
		// REPLACES its coarse base entry in place (the Metis-9 no-duplicate invariant
		// holds at every phase, not only when lost).
		await expect(page.getByTestId("source-row-libuvch264")).toHaveCount(0);
		await expect(usbRow).toHaveAttribute("data-origin", "capture");
		// The real hardware name, never the coarse pipeline label.
		await expect(page.getByTestId("source-row-name-usb")).toHaveText(
			RODE_DISPLAY_NAME,
		);

		await page.getByTestId("source-select-usb").click();
		await expect(usbRow).toHaveAttribute("data-selected", "true", {
			timeout: 15_000,
		});

		// Audio block (todo 18) is visible once an effective source exists.
		await expect(page.getByTestId("source-audio")).toBeVisible();

		// ── 2. DETACH via the REAL seam → the backend synthesizes the lost row. ───
		const detach = await setDeviceAttached(page, "usb", false);
		expect(detach.success).toBe(true);

		// The lost banner appearing is the transition signal that the real
		// `sources` rebroadcast has landed.
		await expect(page.getByTestId("source-lost-banner")).toBeVisible({
			timeout: 15_000,
		});

		// EXACTLY ONE row for the input — the Metis-9 no-duplicate lock: the lost
		// capture row, and NO coarse-base `libuvch264` duplicate beside it.
		await expect(usbRow).toHaveCount(1);
		await expect(page.getByTestId("source-row-libuvch264")).toHaveCount(0);

		// Still the selected source (no operator action), disabled select button,
		// lost badge + reason visible.
		await expect(usbRow).toHaveAttribute("data-selected", "true");
		const usbSelect = page.getByTestId("source-select-usb");
		await expect(usbSelect).toBeDisabled();
		await expect(usbSelect).toHaveAttribute("title", /\S/); // reason (lostBody)
		await expect(usbRow).toContainText("Lost"); // in-row lost badge

		// Start is disabled WITH a reason — the source readiness gate blocks on the
		// lost device and projects onto the (always-rendered) encoder setup row.
		const chain = page.getByTestId("stream-setup-chain");
		await expect(
			chain.locator('[data-testid="setup-row"][data-row="encoder"]'),
		).toHaveAttribute("data-state", "blocked");
		const start = page.getByRole("button", { name: /start stream/i });
		await expect(start).toBeDisabled();
		await expect(start).toHaveAttribute("title", /\S/);

		// Audio block still follows — a lost capture is still an effective source.
		await expect(page.getByTestId("source-audio")).toBeVisible();

		// ── 3a. Direct streaming.start → EXACT wire codes (not a toast). ──────────
		const started = await directStartStream(page, "usb");
		expect(started).toMatchObject({
			success: false,
			error: "source_lost",
			reason: "source_lost",
		});

		// ── 4. REATTACH via the REAL seam → row re-enables, SAME selection kept. ──
		const reattach = await setDeviceAttached(page, "usb", true);
		expect(reattach.success).toBe(true);

		await expect(page.getByTestId("source-lost-banner")).toHaveCount(0, {
			timeout: 15_000,
		});
		await expect(usbRow).toHaveCount(1);
		await expect(usbRow).not.toContainText("Lost");
		// config.source is untouched by the hotplug — no operator action required.
		await expect(usbRow).toHaveAttribute("data-selected", "true");
		await expect(usbSelect).toBeEnabled();
		// All four gates green again → Start re-enables.
		await expect(start).toBeEnabled();
		await expect(page.getByTestId("source-audio")).toBeVisible();
	});

	test("a page reload with the device still detached shows the NAMED grayed row (restart persistence)", async ({
		page,
	}) => {
		// Select `usb`, then detach it (real seam). The SAME per-worker backend keeps
		// BOTH the persisted config.source and the detached mock state across a
		// browser reload — so this exercises the across-restart retention path
		// (todo 11(c): the lost row is rebuilt from config.last_seen_devices).
		const usbRow = page.getByTestId("source-row-usb");
		await expect(usbRow).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("source-select-usb").click();
		await expect(usbRow).toHaveAttribute("data-selected", "true", {
			timeout: 15_000,
		});
		expect((await setDeviceAttached(page, "usb", false)).success).toBe(true);
		await expect(page.getByTestId("source-lost-banner")).toBeVisible({
			timeout: 15_000,
		});

		// Fresh session: reload. config.source='usb' is persisted and the device is
		// still detached, so buildSources re-synthesizes the NAMED lost row on boot.
		await page.reload();
		await ensureAuthenticated(page);
		await navigateTo(page, "live");

		const usbRowAfter = page.getByTestId("source-row-usb");
		await expect(usbRowAfter).toHaveCount(1, { timeout: 15_000 });
		// The Metis-9 no-duplicate lock survives a restart: still no coarse row.
		await expect(page.getByTestId("source-row-libuvch264")).toHaveCount(0);
		// The row keeps the REAL device name — the NAMED grayed row, not a coarse label.
		await expect(page.getByTestId("source-row-name-usb")).toHaveText(
			RODE_DISPLAY_NAME,
		);
		await expect(usbRowAfter).toHaveAttribute("data-selected", "true");
		await expect(page.getByTestId("source-select-usb")).toBeDisabled();
		await expect(usbRowAfter).toContainText("Lost");
		await expect(page.getByTestId("source-lost-banner")).toBeVisible();
		// Audio block still follows the persisted (lost) source across the reload.
		await expect(page.getByTestId("source-audio")).toBeVisible();
		// The blocked source gate keeps Start disabled after the restart.
		await expect(
			page.getByRole("button", { name: /start stream/i }),
		).toBeDisabled();
	});
});

// ── The start-failure TOAST copy — the ONE part the real seam cannot reach ───────
// A LOST source disables the Start button (the readiness source gate blocks it), so
// the button PATH can only be walked against a GREEN, selected, available source
// whose start the proxy refuses with `source_lost`. This is the sanctioned inject
// fallback: it proves LiveView maps the wire `reason` → the SPECIFIC
// `live.startFailed.source_lost` copy (the UI copy surface for a start failure),
// complementing the REAL wire-code assertion in the lifecycle test above.

// A configured server keeps LiveView out of its empty state; a known pipeline makes
// the Start gate pass.
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

// A green capture StreamSource: selected + available so every readiness gate passes
// and the Start button is enabled (so the button path is reachable).
const CAP_GREEN: Record<string, unknown> = {
	origin: "capture",
	id: "video0",
	pipelineId: "hdmi",
	kind: "hdmi",
	displayName: "HDMI Camera",
	devicePath: "/dev/video0",
	modes: [{ width: 1920, height: 1080, framerates: [30, 60] }],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	defaultResolution: "1080p",
	defaultFramerate: 30,
	audioKind: "selectable",
	available: true,
};

function sendSources(sources: Record<string, unknown>[]): void {
	send({ sources: { hardware: "rk3588", sources } });
}

test.describe("lost-source start-failure copy (button path)", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the source surface; mobile/kiosk/RTL are the @visual suite",
		);

		pageWs = null;
		// Refuse the button-path start with source_lost (never touching the shared
		// backend), and make the INJECTED green source list authoritative.
		fakeStartReason = "source_lost";
		dropServerDevices = true;
		dropServerSources = true;

		await installWsProxy(page);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
	});

	test("clicking Start on a source the backend refuses renders the live.startFailed.source_lost copy", async ({
		page,
	}) => {
		// Inject a fully-green idle state: a selected available capture + a known
		// server + a recognized pipeline → all four readiness gates pass → Start is
		// enabled, so the button path is walkable.
		serverConfig({ source: "video0" });
		send(GENERIC_PIPELINES);
		sendSources([CAP_GREEN]);

		const start = page.getByRole("button", { name: /start stream/i });
		await expect(start).toBeEnabled({ timeout: 15_000 });

		// Click Start → handleStart dispatches streaming.start → the proxy refuses it
		// with `reason: source_lost` → LiveView maps it to the SPECIFIC copy and
		// surfaces it (as a toast — the UI copy surface for a start failure).
		await start.click();

		await expect(
			page.getByText(/the selected source was disconnected/i),
		).toBeVisible();
	});
});
