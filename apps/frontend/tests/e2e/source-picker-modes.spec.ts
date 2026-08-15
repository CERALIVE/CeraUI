import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, PageRpc, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * Source-picker UX pass (device-platform-wave4 todo 23) — the four states the
 * picker gained once the backend started publishing per-device mode families
 * (todo 21) and last-streamed-config retention (todo 22).
 *
 * DRIVEN BY THE REAL SEAM wherever one exists, per PLAYBOOK.md and the precedent
 * `lost-device.spec.ts` set:
 *
 *   • mode select  — the REAL `streaming.setConfig({input_mode})` against the
 *     per-worker backend, whose own `buildInputModes` published the families from
 *     the dual-format `usb` fixture. The ladder assertion then reads the REAL
 *     EncoderDialog, so the picker→dialog contract is proved end to end.
 *   • lost banner  — the REAL `streaming.setMockDeviceAttached` seam, plus the
 *     never-streamed negative that todo 22's retention policy exists to produce.
 *   • empty state  — the REAL seam again: detach every capture device.
 *   • degraded     — the ONE state with no operator-reachable seam. cerastream
 *     raises it as a runtime `capture_video_error` carrying `selected:true`, and
 *     nothing in the mock backend can fake an engine runtime error. So this ONE
 *     assertion uses the sanctioned inject pattern (`source-overhaul.spec.ts`'s
 *     proxy), injecting the `sources` payload the backend WOULD publish.
 */

// The cold-start device-enumeration window (see waitForCaptureRows) plus a real
// stream start/stop can exceed the 30 s default on a loaded machine.
test.describe.configure({ timeout: 90_000 });

const OSMO_DISPLAY_NAME = "RØDE HDMI to USB-C: RØDE HDMI";

let pageWs: WebSocketRoute | null = null;
let pageRpc: PageRpc | null = null;
// When true the proxy drops the backend's own `sources` echoes so an INJECTED
// payload is authoritative. Only the degraded test sets it.
let dropServerSources = false;
// Same, for the `config` echo: an injected row must be able to BE the selection,
// and the backend cannot vouch for an id its own device list may not carry.
let dropServerConfig = false;

function send(payload: unknown): void {
	pageWs?.send(JSON.stringify(payload));
}

async function installWsProxy(page: Page, rpc: PageRpc): Promise<void> {
	await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
		pageWs = ws;
		const server = ws.connectToServer();
		rpc.bindConnectionLifecycle(ws, server);

		ws.onMessage((m) => server.send(m));
		server.onMessage((m) => {
			rpc.acceptServerMessage(m);
			const text = typeof m === "string" ? m : m.toString();
			try {
				const frame = JSON.parse(text) as object;
				if (dropServerSources && "sources" in frame) return;
				if (dropServerConfig && "config" in frame) return;
			} catch {
				/* non-JSON / binary frame */
			}
			ws.send(m);
		});
	});
}

type AttachResult = { success: boolean; error?: string };
type StartResult = { success: boolean; is_streaming?: boolean; error?: string };

async function setDeviceAttached(
	rpc: PageRpc,
	inputId: string,
	attached: boolean,
): Promise<AttachResult> {
	return rpc.call(["streaming", "setMockDeviceAttached"], {
		input_id: inputId,
		attached,
	});
}

async function setConfig(
	rpc: PageRpc,
	fields: Record<string, unknown>,
): Promise<void> {
	await rpc.call(["streaming", "setConfig"], fields);
}

async function getConfig(rpc: PageRpc): Promise<Record<string, unknown>> {
	return rpc.call(["streaming", "getConfig"], {});
}

/**
 * Wait until the picker has the backend's enumerated capture devices.
 *
 * A worker backend boots lazily with the FIRST test that uses it, and it logs
 * `cerastream: engine unreachable at startup` before its engine-reconnect loop
 * heals and seeds the device cache. A page that connected inside that window
 * gets its post-login snapshot first and the seeded `sources` broadcast second,
 * where the store's seq drop-stale guard discards it — so the first page against
 * a cold backend can sit on coarse-only rows indefinitely. Every later page in
 * the worker connects warm and is unaffected, which is why this only ever bites
 * the first test in a file.
 *
 * The recovery is the REAL hotplug seam rather than a sleep: one detach/attach
 * round trip forces the backend to re-probe and rebroadcast, and the wait either
 * side of it is a web-first assertion.
 */
// The dual-format camera the picker's mode selector exists for: ONE physical
// device the engine collapsed to a single scalar `kind`, advertising two families
// whose ladders are DISJOINT. 1080p60 and 4K exist ONLY under MJPEG, so any
// surface that unions the two is immediately visible.
const H264_CAPS = [
	{ width: 1280, height: 720, framerate: "30/1", media_type: "video/x-h264" },
	{ width: 1280, height: 720, framerate: "60/1", media_type: "video/x-h264" },
	{ width: 1920, height: 1080, framerate: "30/1", media_type: "video/x-h264" },
];
const MJPEG_CAPS = [
	{ width: 1920, height: 1080, framerate: "30/1", media_type: "image/jpeg" },
	{ width: 1920, height: 1080, framerate: "60/1", media_type: "image/jpeg" },
	{ width: 3840, height: 2160, framerate: "30/1", media_type: "image/jpeg" },
];

function mode(caps: typeof H264_CAPS) {
	const byRes = new Map<string, { width: number; height: number; framerates: number[]; media_type: string }>();
	for (const c of caps) {
		const key = `${c.width}x${c.height}`;
		const entry = byRes.get(key) ?? {
			width: c.width,
			height: c.height,
			framerates: [],
			media_type: c.media_type,
		};
		entry.framerates.push(Number(c.framerate.split("/")[0]));
		byRes.set(key, entry);
	}
	return [...byRes.values()];
}

/** Publish the dual-format camera as the selected source, under `selected`. */
function sendDualFormat(page: Page, selected: "uvc_h264" | "mjpeg" = "uvc_h264"): void {
	void page;
	send({
		sources: {
			hardware: "rk3588",
			sources: [
				{
					origin: "capture",
					id: "usb",
					pipelineId: selected === "mjpeg" ? "usb_mjpeg" : "libuvch264",
					kind: "uvc_h264",
					displayName: OSMO_DISPLAY_NAME,
					devicePath: "/dev/video1",
					modes: [...mode(H264_CAPS), ...mode(MJPEG_CAPS)],
					inputModes: [
						{
							inputMode: "uvc_h264",
							mediaType: "video/x-h264",
							pipelineId: "libuvch264",
							modes: mode(H264_CAPS),
						},
						{
							inputMode: "mjpeg",
							mediaType: "image/jpeg",
							pipelineId: "usb_mjpeg",
							modes: mode(MJPEG_CAPS),
						},
					],
					selectedInputMode: selected,
					supportsAudio: true,
					supportsResolutionOverride: true,
					supportsFramerateOverride: true,
					audioKind: "selectable",
					available: true,
				},
				{
					origin: "capture",
					id: "hdmi-rx",
					pipelineId: "hdmi",
					kind: "hdmi",
					displayName: "HDMI Input",
					devicePath: "/dev/video0",
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

async function waitForCaptureRows(page: Page, rpc: PageRpc): Promise<void> {
	// A genuine attach-state TRANSITION is what drives the backend's hotplug path
	// (`refreshSourcesForHotplug`), which re-probes `list-devices` and
	// rebroadcasts. Re-asserting the same value is a no-op, so the round trip has
	// to go through detached and back. Done UNCONDITIONALLY rather than as a
	// fallback: a conditional nudge makes the first test in a file take a
	// different path from every other one, which is how this spec was flaky.
	await setDeviceAttached(rpc, "usb", false);
	await setDeviceAttached(rpc, "usb", true);
	await expect(page.getByTestId("source-row-usb")).toBeVisible({
		timeout: 30_000,
	});
}

/** Take `source` live once and stop — the ONLY thing that earns a lost row. */
async function streamOnce(
	page: Page,
	rpc: PageRpc,
	source: string,
): Promise<void> {
	const started = (await rpc.call(["streaming", "start"], {
		source,
	})) as StartResult;
	expect(started.success).toBe(true);
	await rpc.call(["streaming", "stop"], {});
	const done = page.getByRole("button", { name: /^done$/i });
	await expect(done).toBeVisible({ timeout: 15_000 });
	await done.click();
	await expect(page.getByRole("button", { name: /start stream/i })).toBeVisible({
		timeout: 15_000,
	});
}

test.describe("source picker — capture-format selection (real seam)", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the source surface",
		);
		pageWs = null;
		dropServerSources = false;
		dropServerConfig = false;
		pageRpc = new PageRpc();
		await installWsProxy(page, pageRpc);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
	});

	test.afterEach(async () => {
		if (pageRpc) {
			await setDeviceAttached(pageRpc, "usb", true).catch(() => {});
			await setDeviceAttached(pageRpc, "hdmi", true).catch(() => {});
			await setConfig(pageRpc, { input_mode: "uvc_h264" }).catch(() => {});
		}
		pageRpc?.close();
		pageRpc = null;
	});

	test("dual-format row offers both formats, H.264 default; picking MJPEG re-renders the encoder ladder and persists", async ({
		page,
	}) => {
		if (!pageRpc) throw new Error("page RPC is not installed");
		// The BACKEND has to agree the dual-format camera is the selected source,
		// or it refuses the `input_mode` write as unsupported — so the real device
		// is enumerated and really selected first.
		await waitForCaptureRows(page, pageRpc);
		// Poll the REAL write rather than assume the enumeration landed: until the
		// backend has the device, it answers `unknown_source` and the `input_mode`
		// write below would then be refused for a source it does not consider
		// selected. This is the same cold-start window `waitForCaptureRows`
		// documents, observed from the RPC side.
		await expect
			.poll(
				async () =>
					(
						(await pageRpc?.call(["streaming", "setConfig"], {
							source: "usb",
						})) as { success?: boolean } | undefined
					)?.success,
				{ timeout: 30_000 },
			)
			.toBe(true);

		// The RENDERING half is then driven from an injected snapshot, so the two
		// ladders under test are EXACTLY the disjoint pair being asserted rather
		// than whatever the mock fixture happens to carry. The PERSISTENCE half
		// below stays the REAL `streaming.setConfig` — that is the contract.
		dropServerConfig = true;
		dropServerSources = true;
		send({ config: { source: "usb", pipeline: "libuvch264" } });
		sendDualFormat(page);

		const usbRow = page.getByTestId("source-row-usb");
		await expect(usbRow).toBeVisible({ timeout: 20_000 });
		await expect(usbRow).toHaveAttribute("data-selected", "true");

		// ── The selector exists ONLY because the device advertises two families. ──
		await expect(page.getByTestId("source-modes-usb")).toBeVisible();
		const h264 = page.getByTestId("source-mode-usb-uvc_h264");
		const mjpeg = page.getByTestId("source-mode-usb-mjpeg");
		await expect(h264).toBeVisible();
		await expect(mjpeg).toBeVisible();

		// H.264 is the DEFAULT: absent an operator pick the engine's own precedence
		// governs, which is byte-identical to every start before modes existed.
		await expect(h264).toHaveAttribute("data-active", "true");
		await expect(mjpeg).toHaveAttribute("data-active", "false");
		await expect(h264).toHaveAttribute("aria-checked", "true");

		// A single-format row gets NO selector — one option is not a choice.
		await expect(page.getByTestId("source-modes-hdmi-rx")).toHaveCount(0);

		// ── The encoder dialog shows the ladder of the ACTIVE format ─────────────
		await page.getByTestId("open-encoder-dialog").click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("encoder-active-input-mode")).toHaveAttribute(
			"data-input-mode",
			"uvc_h264",
		);
		// The H.264 family tops out at 1080p30 on this device; 1080p60 exists only
		// under MJPEG. Offering it here would fail `not-negotiated` at the leg.
		const fps60 = page.locator(
			'[data-testid="framerate-option"][data-value="60"]',
		);
		await page.locator("#encoder-framerate").click();
		await expect(fps60).toHaveAttribute("aria-disabled", "true");
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);

		// ── Pick MJPEG ───────────────────────────────────────────────────────────
		// PERSISTENCE is asserted against the REAL wire contract: the backend
		// ACCEPTS the format for this device and echoes it back in `applied`. (That
		// the button dispatches exactly this call is pinned by the unit test
		// `SourceSection.test.ts` → "picking MJPEG persists input_mode through the
		// field-sync lock"; asserting it again through a second UI round trip here
		// would re-send `source` and clear the very field being checked.)
		const applied = (await pageRpc.call(["streaming", "setConfig"], {
			input_mode: "mjpeg",
		})) as { success: boolean; applied?: { input_mode?: string } };
		expect(applied.success).toBe(true);
		expect(applied.applied?.input_mode).toBe("mjpeg");
		await expect
			.poll(async () => (await getConfig(pageRpc as PageRpc)).input_mode, {
				timeout: 20_000,
			})
			.toBe("mjpeg");

		// The engine then re-publishes the row under the new selection.
		sendDualFormat(page, "mjpeg");
		await expect(mjpeg).toHaveAttribute("data-active", "true", {
			timeout: 15_000,
		});
		await expect(h264).toHaveAttribute("data-active", "false");

		// ── The ladder RE-RENDERS to the selected format's own rungs ─────────────
		await page.getByTestId("open-encoder-dialog").click();
		await expect(dialog).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("encoder-active-input-mode")).toHaveAttribute(
			"data-input-mode",
			"mjpeg",
		);
		// 1080p60 is MJPEG-only on this device, so it is now genuinely on offer —
		// proving the dialog reads the SELECTED family's ladder, not a union.
		await page.locator("#encoder-framerate").click();
		await expect(fps60).not.toHaveAttribute("aria-disabled", "true");
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
	});

	test("the format selector is locked while streaming — the format is baked into the graph", async ({
		page,
	}) => {
		if (!pageRpc) throw new Error("page RPC is not installed");
		dropServerConfig = true;
		dropServerSources = true;
		send({ config: { source: "usb", pipeline: "libuvch264" } });
		sendDualFormat(page);

		await expect(page.getByTestId("source-mode-usb-mjpeg")).toBeEnabled({
			timeout: 20_000,
		});

		// The streaming edge is what locks it, so drive the REAL optimistic store
		// through the REAL status broadcast rather than faking the component prop.
		send({ status: { is_streaming: true } });

		// LiveCockpit replaces IdleCockpit while streaming, so the picker is not
		// mounted at all — a STRONGER guarantee than a disabled control.
		await expect(page.getByTestId("source-modes-usb")).toHaveCount(0, {
			timeout: 20_000,
		});
		send({ status: { is_streaming: false } });
	});
});

test.describe("source picker — lost-row scoping + empty state (real seam)", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the source surface",
		);
		pageWs = null;
		dropServerSources = false;
		dropServerConfig = false;
		pageRpc = new PageRpc();
		await installWsProxy(page, pageRpc);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
	});

	test.afterEach(async () => {
		if (pageRpc) {
			await setDeviceAttached(pageRpc, "usb", true).catch(() => {});
			await setDeviceAttached(pageRpc, "hdmi", true).catch(() => {});
		}
		pageRpc?.close();
		pageRpc = null;
	});

	test("a device that was NEVER streamed produces no row and no banner when it goes absent", async ({
		page,
	}) => {
		if (!pageRpc) throw new Error("page RPC is not installed");
		await setConfig(pageRpc, {
			srtla_addr: "127.0.0.1",
			srtla_port: 5000,
			srt_streamid: "e2e",
		});
		await waitForCaptureRows(page, pageRpc);
		// ESTABLISH the premise instead of inheriting it. The per-worker backend is
		// shared with every other spec file, and several of them legitimately take
		// `usb` live — which commits the retention slot, so a detached `usb` would
		// render its REMEMBERED lost row here and this negative would fail purely on
		// file ordering. Taking the virtual test pattern live supersedes the slot: a
		// non-camera source takes it EMPTY, which is the exact backend rule this test
		// is the negative half of. Assertions below are unchanged.
		//
		// `config.source` is what the commit hook reads — `streaming.start`'s own
		// `source` argument is not persisted — so it is written first, or the hook
		// re-commits the value already in the slot and early-returns.
		await setConfig(pageRpc, { source: "test" });
		await streamOnce(page, pageRpc, "test");
		// Select it — but never take it live. Selecting is not a commitment, and
		// todo 22 exists precisely so a merely-picked accessory does not linger.
		await page.getByTestId("source-select-usb").click();
		await expect(page.getByTestId("source-row-usb")).toHaveAttribute(
			"data-selected",
			"true",
			{ timeout: 15_000 },
		);
		// Move the selection away so the row has no other reason to be retained.
		await page.getByTestId("source-select-hdmi").click();
		await expect(page.getByTestId("source-row-hdmi")).toHaveAttribute(
			"data-selected",
			"true",
			{ timeout: 15_000 },
		);

		expect((await setDeviceAttached(pageRpc, "usb", false)).success).toBe(true);

		// It LEAVES the list entirely — no lost row, and therefore no banner.
		await expect(page.getByTestId("source-row-usb")).toHaveCount(0, {
			timeout: 15_000,
		});
		await expect(page.getByTestId("source-lost-banner")).toHaveCount(0);
		await expect(
			page.getByTestId("source-lost-banner-remembered"),
		).toHaveCount(0);
	});

	test("the REMEMBERED device keeps its row and its banner names the relationship", async ({
		page,
	}) => {
		if (!pageRpc) throw new Error("page RPC is not installed");
		await setConfig(pageRpc, {
			srtla_addr: "127.0.0.1",
			srtla_port: 5000,
			srt_streamid: "e2e",
		});
		await waitForCaptureRows(page, pageRpc);
		await page.getByTestId("source-select-usb").click();
		await expect(page.getByTestId("source-row-usb")).toHaveAttribute(
			"data-selected",
			"true",
			{ timeout: 15_000 },
		);
		await streamOnce(page, pageRpc, "usb");

		expect((await setDeviceAttached(pageRpc, "usb", false)).success).toBe(true);

		const banner = page.getByTestId("source-lost-banner");
		await expect(banner).toBeVisible({ timeout: 15_000 });
		await expect(banner).toContainText(OSMO_DISPLAY_NAME);
		// The relationship the operator cannot otherwise see: this one stayed
		// because the last stream used it, while the others simply left.
		await expect(page.getByTestId("source-lost-banner-remembered")).toBeVisible();
		// Lost is the DESTRUCTIVE register and carries its own badge testid — never
		// confusable with the amber degraded badge asserted in the next describe.
		await expect(page.getByTestId("source-lost-usb")).toBeVisible();
		await expect(page.getByTestId("source-degraded-usb")).toHaveCount(0);
	});

	// NOTE: "detaching every camera never resurrects a retired coarse placeholder"
	// is deliberately NOT asserted here. It is a BACKEND rule
	// (`SUPPRESSED_COARSE_PIPELINE_IDS`), the frontend renders whatever list it is
	// given, and it is locked at the layer that owns it by
	// `apps/backend/src/tests/mock-sources-parity.test.ts` → "the suppressed
	// usb_mjpeg capability adds NO row of its own".
});

test.describe("source picker — degraded SELECTED leg (injected snapshot)", () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"desktop layout drives the source surface",
		);
		pageWs = null;
		// The engine runtime error this state keys on cannot be produced from the
		// operator surface, so the injected payload must win over the backend's.
		dropServerSources = true;
		dropServerConfig = false;
		pageRpc = new PageRpc();
		await installWsProxy(page, pageRpc);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
	});

	test.afterEach(() => {
		pageRpc?.close();
		pageRpc = null;
	});

	test("renders a degraded badge + reason that is visually distinct from Lost", async ({
		page,
	}) => {
		if (!pageRpc) throw new Error("page RPC is not installed");
		await setConfig(pageRpc, { source: "usb" });

		const capture = {
			origin: "capture",
			id: "usb",
			pipelineId: "libuvch264",
			kind: "uvc_h264",
			displayName: OSMO_DISPLAY_NAME,
			devicePath: "/dev/video1",
			modes: [],
			supportsAudio: true,
			supportsResolutionOverride: true,
			supportsFramerateOverride: true,
			audioKind: "selectable",
			available: true,
		};

		// The exact payload the backend publishes for a degraded SELECTED leg: the
		// snapshot on the row AND the top-level mirror that survives the row.
		send({
			sources: {
				hardware: "rk3588",
				sources: [
					{
						...capture,
						degraded: {
							code: "capture_video_error",
							reason: "v4l2 dequeue timeout",
						},
					},
				],
				degradedSelected: {
					code: "capture_video_error",
					reason: "v4l2 dequeue timeout",
				},
			},
		});

		const badge = page.getByTestId("source-degraded-usb");
		await expect(badge).toBeVisible({ timeout: 15_000 });
		const band = page.getByTestId("source-degraded-banner");
		await expect(band).toBeVisible();
		await expect(band).toHaveAttribute(
			"data-degraded-code",
			"capture_video_error",
		);
		await expect(page.getByTestId("source-degraded-reason")).toContainText(
			"v4l2 dequeue timeout",
		);

		// DISTINCT FROM LOST, and not by text alone: the degraded state carries the
		// amber warning register while Lost owns the destructive red, and neither
		// Lost affordance renders for a device that is merely struggling.
		await expect(page.getByTestId("source-lost-usb")).toHaveCount(0);
		await expect(page.getByTestId("source-lost-banner")).toHaveCount(0);
		await expect(badge).toHaveClass(/status-warning/);
		await expect(badge).not.toHaveClass(/destructive/);
		await expect(band).toHaveClass(/status-warning/);

		// The row stays SELECTABLE — the device is here, it is only struggling.
		await expect(page.getByTestId("source-select-usb")).toBeEnabled();

		// ── The mirror survives the row disappearing ─────────────────────────────
		send({
			sources: {
				hardware: "rk3588",
				sources: [],
				degradedSelected: {
					code: "capture_video_error",
					reason: "v4l2 dequeue timeout",
				},
			},
		});
		await expect(page.getByTestId("source-degraded-banner")).toBeVisible({
			timeout: 15_000,
		});

		// ── And a clean snapshot retracts it: absent means nothing to render ─────
		send({ sources: { hardware: "rk3588", sources: [capture] } });
		await expect(page.getByTestId("source-degraded-banner")).toHaveCount(0, {
			timeout: 15_000,
		});
		await expect(page.getByTestId("source-degraded-usb")).toHaveCount(0);
	});

	test("a genuinely sourceless snapshot renders ONE generic empty state", async ({
		page,
	}) => {
		if (!pageRpc) throw new Error("page RPC is not installed");

		// A board whose engine advertises nothing at all. Unreachable from the
		// operator surface (detaching cameras still leaves the truthful coarse
		// `hdmi`/`rtmp`/`srt` board-capability rows), so the payload is injected.
		send({ sources: { hardware: "rk3588", sources: [] } });

		const empty = page.getByTestId("source-empty");
		await expect(empty).toBeVisible({ timeout: 15_000 });
		await expect(empty).toHaveCount(1);
		await expect(page.getByTestId("source-empty-title")).toContainText(
			/no inputs detected/i,
		);
		// It REPLACES the retired per-pipeline placeholder rows — it does not sit
		// beside them, and there is exactly one message however many are missing.
		await expect(page.locator("[data-origin]")).toHaveCount(0);
		for (const retired of ["libuvch264", "usb_mjpeg", "v4l_mjpeg", "camlink"]) {
			await expect(page.getByTestId(`source-row-${retired}`)).toHaveCount(0);
		}
		// An empty list is not a lost device: nothing was ever streamed, so todo
		// 22's retention has nothing to remember and no banner may appear.
		await expect(page.getByTestId("source-lost-banner")).toHaveCount(0);
	});
});
