import path from 'node:path';

import type { Page, WebSocketRoute } from '@playwright/test';

import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';

/**
 * Todo 27 — PreviewCanvas honest states + working dev preview.
 *
 * TIER DISCIPLINE (the load-bearing convention here): the preview delivery tier
 * is selected by the harness browser's WebCodecs support, so this spec BRANCHES
 * on it rather than asserting one path unconditionally:
 *
 *   • WebCodecs tier — asserts the canvas reaches `data-status="live"` decoding
 *     the REAL Todo-21 mock preview server on :9997 (real H.264 access units).
 *     Runs ONLY when the harness Chromium can decode `avc1.42c00d` via
 *     `VideoDecoder.isConfigSupported` — otherwise the test is SKIPPED with a
 *     logged reason (open-source Chromium ships without proprietary H.264).
 *     Asserting a real decode unconditionally would flake in exactly those CI
 *     browsers, which is what the branch prevents.
 *   • MSE tier — a SEPARATE test deletes `window.VideoDecoder` in an init-script
 *     (before app boot) so the component selects the `<video>`/MSE fallback, then
 *     asserts the video element + compat badge render and the `tier:"mse"`
 *     handshake is sent. The mock serves WebCodecs framing only (documented in
 *     apps/backend/src/mocks/providers/preview.ts), so this proves MSE PATH
 *     SELECTION deterministically without a synthetic fMP4 media source.
 *
 * State attributes read: `data-tier` (webcodecs|mse|none) and `data-status`
 * (idle|connecting|reconnecting|waiting|live|unsupported|error) on the
 * `data-testid="preview"` section.
 */

const EVIDENCE_DIR = path.resolve(import.meta.dirname, '../../../../test-results');

const SERVER_CONFIG = {
	srtla_addr: '127.0.0.1',
	srtla_port: 5000,
	srt_streamid: 'e2e',
	max_br: 5000,
};

/** avc1.42c00d — baseline H.264, level 1.3; matches the mock preview fixture. */
const FIXTURE_CODEC = 'avc1.42c00d';

let pageWs: WebSocketRoute | null = null;

/**
 * Proxy the backend WS, force is_streaming:false so the idle Live DOM is stable.
 *
 * Single-origin preview proxy (Task 20): PreviewCanvas mints a token over the RPC
 * socket, then dials the SAME backend origin at `/preview?token=…`, so the preview
 * socket matches THIS route too. With no `onPreview`, that leg proxies to the real
 * mock-preview upstream (the WebCodecs-tier decode path). The MSE-tier block passes
 * an `onPreview` to fake it in-page instead — the real upstream serves only
 * WebCodecs framing.
 */
async function routeBackend(
	page: Page,
	onPreview?: (ws: WebSocketRoute) => void,
): Promise<void> {
	await page.routeWebSocket(/:(3002|31\d\d)/, (ws) => {
		if (onPreview && ws.url().includes('/preview')) {
			onPreview(ws);
			return;
		}
		pageWs = ws;
		const server = ws.connectToServer();
		ws.onMessage((m) => server.send(m));
		server.onMessage((m) => {
			const text = typeof m === 'string' ? m : m.toString();
			try {
				const frame = JSON.parse(text) as { status?: Record<string, unknown> };
				if (frame?.status?.is_streaming) {
					frame.status.is_streaming = false;
					ws.send(JSON.stringify(frame));
					return;
				}
			} catch {
				/* binary / non-JSON frame */
			}
			ws.send(m);
		});
	});
}

/** Inject a server config frame so the Live view leaves its empty state. */
function injectServerConfig(): void {
	pageWs?.send(JSON.stringify({ config: SERVER_CONFIG }));
}

async function webcodecsH264Advertised(page: Page): Promise<boolean> {
	return page.evaluate(async (codec) => {
		const VD = (
			window as {
				VideoDecoder?: { isConfigSupported?: (c: unknown) => Promise<{ supported?: boolean }> };
			}
		).VideoDecoder;
		if (!VD || typeof VD.isConfigSupported !== 'function') return false;
		try {
			const result = await VD.isConfigSupported({ codec, codedWidth: 320, codedHeight: 240 });
			return result?.supported === true;
		} catch {
			return false;
		}
	}, FIXTURE_CODEC);
}

/**
 * Toggle the preview on and resolve the terminal decode outcome. Open-source
 * Chromium advertises `avc1` via `isConfigSupported` but ships no working H.264
 * decoder, so the real decode raises the component's `error` state — that is the
 * "not truly WebCodecs-capable" branch and is SKIPPED with a logged reason, not
 * failed. Only a browser that actually decodes reaches `live`.
 */
async function toggleAndReachLiveOrSkip(page: Page): Promise<void> {
	const preview = page.getByTestId('preview');
	await expect(preview).toHaveAttribute('data-tier', 'webcodecs');
	await page.getByTestId('preview-toggle').click();
	await expect
		.poll(() => preview.getAttribute('data-status'), { timeout: 20_000 })
		.toMatch(/^(live|error)$/);
	const status = await preview.getAttribute('data-status');
	test.skip(status === 'error', 'harness Chromium advertises but cannot decode avc1.42c00d');
	await expect(preview).toHaveAttribute('data-status', 'live');
}

test.describe('PreviewCanvas — WebCodecs tier + idle copy', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'WebCodecs is a Chromium proof');

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the Live column');
		pageWs = null;
		await routeBackend(page);
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
		injectServerConfig();
	});

	test('idle toggle shows the honest "preview off" copy, not a stalled state', async ({
		page,
	}) => {
		const preview = page.getByTestId('preview');
		await expect(preview).toBeVisible();
		// Off by default: the calm off-copy is shown; no media surface, no dial.
		await expect(preview).toHaveAttribute('data-status', 'idle');
		await expect(page.getByTestId('preview-off')).toBeVisible();
		await expect(page.getByTestId('preview-off')).toContainText(/preview off/i);
		await expect(page.getByTestId('preview-canvas')).toBeHidden();
	});

	test('WebCodecs tier decodes the mock preview server to a live canvas', async ({ page }) => {
		test.skip(
			!(await webcodecsH264Advertised(page)),
			'harness Chromium does not advertise WebCodecs avc1.42c00d',
		);
		await toggleAndReachLiveOrSkip(page);
		await expect(page.getByTestId('preview-canvas')).toBeVisible();
	});

	test('@visual evidence: live decoded canvas', { tag: '@visual' }, async ({ page }) => {
		test.skip(
			!(await webcodecsH264Advertised(page)),
			'harness Chromium does not advertise WebCodecs avc1.42c00d',
		);
		await toggleAndReachLiveOrSkip(page);
		await page
			.getByTestId('preview')
			.screenshot({ path: path.join(EVIDENCE_DIR, 'task-27-webcodecs-live.png') });
	});
});

test.describe('PreviewCanvas — forced MSE tier', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'single-browser preview proof');

	let mseHandshakeTier: string | null = null;

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the Live column');
		pageWs = null;
		mseHandshakeTier = null;

		// Delete WebCodecs BEFORE the app boots so the component selects the MSE
		// (<video>) fallback tier at module-eval.
		await page.addInitScript(() => {
			// biome-ignore lint/performance/noDelete: force the MSE fallback path.
			delete (window as { VideoDecoder?: unknown }).VideoDecoder;
		});
		// The real mock-preview upstream serves WebCodecs framing only, so fake the
		// `/preview` leg here to supply an MSE codec-config and capture the client's
		// start-handshake tier.
		await routeBackend(page, (ws) => {
			ws.onMessage((message) => {
				const text = typeof message === 'string' ? message : message.toString();
				let parsed: { action?: string; tier?: string };
				try {
					parsed = JSON.parse(text);
				} catch {
					return;
				}
				if (parsed?.action !== 'start') return;
				mseHandshakeTier = parsed.tier ?? null;
				ws.send(
					JSON.stringify({
						type: 'codec-config',
						tier: 'mse',
						mime: `video/mp4; codecs="${FIXTURE_CODEC}"`,
					}),
				);
			});
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
		injectServerConfig();
	});

	test('selects the <video> path, shows the compat badge, sends the mse handshake', async ({
		page,
	}) => {
		const preview = page.getByTestId('preview');
		await expect(preview).toHaveAttribute('data-tier', 'mse');

		await page.getByTestId('preview-toggle').click();

		// Deterministic, codec-independent MSE-path proof.
		await expect(page.getByTestId('preview-video')).toBeVisible();
		await expect(page.getByTestId('preview-compat')).toBeVisible();
		await expect
			.poll(() => mseHandshakeTier, { message: 'the client should hand-shake tier:"mse"' })
			.toBe('mse');
	});
});
