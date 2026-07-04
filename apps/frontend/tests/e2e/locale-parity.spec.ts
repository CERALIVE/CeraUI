import type { WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";
// Direct import of the ar locale dictionary — the ORACLE this spec proves the
// rendered DOM matches byte-for-byte (todo 18, capability-first-live-experience).
import ar from "../../../../packages/i18n/src/ar/index.js";

/**
 * Locale-parity regression gate (todo 18, capability-first-live-experience).
 *
 * Proves two things end-to-end, against the REAL locale-selector control (not a
 * localStorage shortcut):
 *   1. Selecting Arabic flips `<html dir>` to "rtl" — the RTL contract every
 *      locale-dependent layout in the app relies on.
 *   2. The embedded-audio read-only state (`data-testid="audio-source-embedded"`,
 *      shipped by todo 13) renders the EXACT Arabic string from the imported
 *      `ar/index.ts` dictionary — not an English placeholder, not a paraphrase.
 *
 * Mechanism: the page socket is proxied (routeWebSocket, the established
 * source-overhaul/truthfulness pattern) so this spec injects a deterministic
 * config + sources + capabilities snapshot that satisfies the embedded-audio gate.
 * Since the experience-simplification restructure (T13), SourceSection resolves the
 * active source from the unified `sources` broadcast, not `pipelines`: the gate is
 * `activeSource.audioKind === 'embedded' && capabilities.network_embedded_audio ===
 * true`, where `activeSource = sources.find(s => s.id === config.source)`.
 */

const EMBEDDED_SOURCES = {
	sources: {
		hardware: "generic",
		sources: [
			{
				origin: "network",
				id: "srt",
				pipelineId: "srt",
				labelKey: "settings.sources.srt",
				requiresGateway: "srt",
				url: "srt://192.168.1.100:4001",
				modes: [],
				supportsAudio: true,
				supportsResolutionOverride: false,
				supportsFramerateOverride: false,
				audioKind: "embedded",
				available: true,
			},
		],
	},
};

const EMBEDDED_CAPABILITIES = {
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
		network_embedded_audio: true,
	},
};

test.describe("Locale parity — Arabic RTL + embedded-audio exact-match (todo 18)", () => {
	let pageWs: WebSocketRoute | null;

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop",
			"locale/RTL behaviour is layout-independent; one project is sufficient",
		);
		pageWs = null;

		// Same proxy shape as source-overhaul/truthfulness: drop the backend's own
		// `devices`/`capabilities`/`pipelines`/`sources` echoes so the injected
		// snapshot below is authoritative regardless of the worker's mock scenario.
		// `sources` MUST be dropped (T22 pattern): SourceSection reads the folded
		// `sources` broadcast, so the backend's own echo would override our fixture.
		await page.routeWebSocket(/:(3002|31\d\d|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				const text = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(text) as Record<string, unknown>;
					if (
						frame &&
						typeof frame === "object" &&
						("devices" in frame ||
							"capabilities" in frame ||
							"pipelines" in frame ||
							"sources" in frame)
					) {
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
	});

	test("setLocale('ar') via the locale-selector flips <html dir> to rtl", async ({ page }) => {
		await page.getByTestId("locale-selector").click();
		await page.getByTestId("locale-option-ar").click();

		await expect
			.poll(() => page.evaluate(() => document.documentElement.dir), {
				timeout: 8000,
				message: "document.documentElement.dir should flip to rtl for Arabic",
			})
			.toBe("rtl");
		await expect
			.poll(() => page.evaluate(() => document.documentElement.lang))
			.toBe("ar");
	});

	test("embedded-audio state renders the exact ar dictionary string", async ({ page }) => {
		await page.getByTestId("locale-selector").click();
		await page.getByTestId("locale-option-ar").click();
		await expect
			.poll(() => page.evaluate(() => document.documentElement.dir))
			.toBe("rtl");

		await navigateTo(page, "live");

		pageWs?.send(
			JSON.stringify({
				config: {
					srtla_addr: "127.0.0.1",
					srtla_port: 5000,
					srt_streamid: "e2e",
					max_br: 6000,
					pipeline: "srt",
					source: "srt",
				},
			}),
		);
		pageWs?.send(JSON.stringify(EMBEDDED_SOURCES));
		pageWs?.send(JSON.stringify(EMBEDDED_CAPABILITIES));

		const embedded = page.getByTestId("audio-source-embedded");
		await expect(embedded).toBeVisible({ timeout: 20_000 });

		// Exact-match against the IMPORTED ar/index.ts dictionary — the strongest
		// possible proof this is a real translation, not an English placeholder or
		// a paraphrase drifted from the source file. Param-free key, so the raw
		// dictionary value IS the rendered text.
		await expect(embedded).toHaveText(ar.live.source.audioEmbedded, { useInnerText: true });

		// No literal interpolation residue (`{...}`/`{{...}}`) ever reaches the DOM.
		const text = await embedded.innerText();
		expect(text).not.toMatch(/\{\{?[^}]*\}\}?/);
	});
});
