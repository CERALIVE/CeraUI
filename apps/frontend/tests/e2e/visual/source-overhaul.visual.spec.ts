import path from "node:path";

import type { WebSocketRoute } from "@playwright/test";

import { expect, test } from "../fixtures/index.js";
import { ensureAuthenticated, navigateTo, setLocale } from "../helpers/index.js";

/**
 * @visual evidence for the Track-1 source-experience overhaul (Task 15).
 *
 * Captures the three overhauled surfaces — the capability-first encoder dialog,
 * the unified Source section, and the calm coming-soon affordances — across the
 * four conditions the overhaul must hold up in: desktop, mobile, the kiosk
 * 1024×600 panel, and a RTL (Arabic) locale. One PNG per surface per condition,
 * landing in apps/frontend/test-results/ (repo-local, gitignored), so a reviewer
 * can eyeball the redesign without running the app.
 *
 * Tagged @visual (per-test) so the screenshot guard in fixtures permits the
 * element/page screenshots here and the functional `--grep-invert @visual` gate
 * excludes this file. Snapshots are written as evidence PNGs (the established
 * Track-1 convention — see ingest-states / source-preference) rather than
 * `toHaveScreenshot` baselines, so no committed baseline drift.
 *
 * Determinism: the page socket is proxied so the spec injects its own config /
 * pipelines / devices / sources snapshots and DROPS the backend's `devices` and
 * `sources` echoes — the injected source list is authoritative regardless of mock
 * churn.
 */

type Device = {
	input_id: string;
	device_path: string;
	display_name: string;
	media_class: "video" | "audio";
	kind: string;
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

// The unified device-first list reads the folded `sources` broadcast; each `id`
// matches its device input_id so config.source selects the HDMI capture.
function captureSource(id: string, kind: string, pipelineId: string, displayName: string) {
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

const SOURCES = {
	sources: {
		hardware: "rk3588",
		sources: [
			captureSource("video0", "hdmi", "hdmi", "HDMI Camera"),
			captureSource("video1", "usb", "libuvch264", "USB Capture"),
		],
	},
};

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

const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../test-results/task-15-visual",
);

type Condition = {
	name: string;
	project: "desktop" | "mobile";
	viewport: { width: number; height: number };
	locale?: string;
};

// Desktop project owns desktop / kiosk / RTL; the mobile project owns mobile.
// Each condition self-skips in the other project so every PNG is produced once.
const CONDITIONS: readonly Condition[] = [
	{ name: "desktop", project: "desktop", viewport: { width: 1280, height: 800 } },
	{ name: "kiosk-1024x600", project: "desktop", viewport: { width: 1024, height: 600 } },
	{ name: "rtl-ar", project: "desktop", viewport: { width: 1280, height: 800 }, locale: "ar" },
	{ name: "mobile", project: "mobile", viewport: { width: 390, height: 844 } },
];

for (const condition of CONDITIONS) {
	test.describe(`@visual source overhaul — ${condition.name}`, () => {
		let pageWs: WebSocketRoute | null;

		const evidence = (surface: string): string =>
			path.join(EVIDENCE_DIR, `${surface}-${condition.name}.png`);

		// Outside beforeEach, whose reset narrows pageWs to null: TypeScript cannot
		// see the route callback assign it.
		const inject = (frame: object): void => {
			pageWs?.send(JSON.stringify(frame));
		};

		test.beforeEach(async ({ page }, testInfo) => {
			test.skip(
				testInfo.project.name !== condition.project,
				`${condition.name} renders in the ${condition.project} project`,
			);
			pageWs = null;

			await page.setViewportSize(condition.viewport);

			await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
				pageWs = ws;
				const server = ws.connectToServer();
				ws.onMessage((m) => server.send(m));
				server.onMessage((m) => {
					const text = typeof m === "string" ? m : m.toString();
					try {
						const frame = JSON.parse(text) as Record<string, unknown>;
						// Drop the backend device and source echoes so the injected lists win.
						if (frame && typeof frame === "object" && ("devices" in frame || "sources" in frame)) return;
					} catch {
						/* non-JSON / binary frame */
					}
					ws.send(m);
				});
			});

			await page.goto("/");
			if (condition.locale) {
				await setLocale(page, condition.locale);
				await page.reload();
			}
			await ensureAuthenticated(page);
			await navigateTo(page, "live");

			// A configured server + a selected source leaves the empty state, enables the
			// encoder Edit (disabled while no source resolves) and renders the Source
			// section with its audio card (hidden until an effective source exists).
			inject({
				config: {
					srtla_addr: "127.0.0.1",
					srtla_port: 5000,
					srt_streamid: "e2e",
					max_br: 6000,
					pipeline: "hdmi",
					source: "video0",
				},
			});
			inject(SOURCES);
			inject(GENERIC_PIPELINES);
			inject({
				devices: { engine: "cerastream", active_input: "video0", devices: [HDMI, USB] },
			});
		});

		test("encoder surface", { tag: "@visual" }, async ({ page }) => {
			// The StreamSetupChain (T9/T10) always renders its four setup rows (no
			// collapse), so the migrated `open-encoder-dialog` trigger is permanently
			// visible — no expand step needed.
			await expect(page.getByTestId("stream-setup-chain")).toBeVisible({
				timeout: 20_000,
			});

			const trigger = page.getByTestId("open-encoder-dialog");
			await expect(trigger).toBeVisible({ timeout: 20_000 });
			await trigger.click();

			// Locate the open dialog by role (NOT the title — it is localized, so an
			// English name fails under the RTL/ar profile); the capability-gated
			// bitrate control always renders, so wait on it before capturing.
			const dialog = page.getByRole("dialog").first();
			await expect(dialog).toBeVisible();
			await expect(dialog.getByTestId("encoder-bitrate-control")).toBeVisible();

			await dialog.screenshot({ path: evidence("encoder") });
		});

		test("unified source surface", { tag: "@visual" }, async ({ page }) => {
			const section = page.getByTestId("source-section");
			await expect(section).toBeVisible({ timeout: 20_000 });
			await section.scrollIntoViewIfNeeded();

			// Composes the unified device-first source list (T13 replaced the old
			// `input-picker` with a `source-list` <ul>) + the audio source in one
			// coherent section.
			await expect(section.getByTestId("source-list")).toBeVisible();
			await expect(section.getByTestId("source-audio")).toBeVisible();

			await section.screenshot({ path: evidence("source") });
		});

		test("coming-soon states", { tag: "@visual" }, async ({ page }) => {
			const roadmap = page.getByTestId("live-roadmap");
			await expect(roadmap).toBeVisible({ timeout: 20_000 });
			await roadmap.scrollIntoViewIfNeeded();

			// The roadmap pills live inside a `<details>` disclosure (T12), closed by
			// default — open it (click its <summary>) before asserting pill visibility.
			await roadmap.locator("summary").click();

			// Calm informational pills (not the disabled-with-reason warning), each
			// bound to an open tech-debt id. TD-pip is resolved (composition ships as
			// the feature-gated CompositionCard), so its pill must stay gone.
			await expect(roadmap.locator('[data-debt-id="TD-mode-fallback"]')).toBeVisible();
			await expect(roadmap.locator('[data-debt-id="TD-pip"]')).toHaveCount(0);

			await roadmap.screenshot({ path: evidence("comingsoon") });
		});
	});
}
