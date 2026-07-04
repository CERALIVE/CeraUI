import path from 'node:path';

import type { Page, WebSocketRoute } from '@playwright/test';

import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';

/**
 * #72 — LiveView preview placement verification.
 *
 * Proves the already-shipped local preview meets the issue's intent against the
 * real frontend in a browser:
 *   1. <PreviewCanvas> (data-testid="preview") renders under the <SourceSection>
 *      (data-testid="source-section"), which wraps the <InputPicker> device
 *      selector (data-testid="input-picker"), in the same Live column.
 *   2. The preview toggle is operable (aria-pressed flips, canvas mounts).
 *   3. The audio level meter mounts when the preview is on.
 *   4. With no active encode the preview reaches the `waiting` state and shows
 *      the i18n string live.preview.waiting ("Waiting for video…").
 *
 * Two WebSocket routes are installed:
 *   • Backend (:3002) — proxied to the real mock backend. Status frames are
 *     pinned to is_streaming:false (so the idle Live DOM is stable regardless of
 *     what other workers broadcast via dev.emit), and a server `config` frame is
 *     injected after navigation so the Live view leaves its empty state and
 *     renders the SourceSection + PreviewCanvas siblings.
 *   • Preview (:9997) — cerastream serves the preview WS here; it is unserved
 *     under the mock stack, so we mock it: on the client's {action:"start"} we
 *     reply with a codec-config (→ decoder configured → status "waiting") and an
 *     audio-level frame, leaving the socket frame-less. With no video access
 *     units the terminal state is "waiting" — exactly the no-active-encode case.
 *
 * The two @visual tests capture repo-local evidence PNGs (gitignored); the
 * functional tests carry the real assertions and run under the @visual-excluded
 * gate.
 */

// CeraUI repo-root test-results (gitignored). e2e -> tests -> frontend -> apps -> CeraUI.
const EVIDENCE_DIR = path.resolve(import.meta.dirname, '../../../../test-results');

const SERVER_CONFIG = {
	srtla_addr: '127.0.0.1',
	srtla_port: 5000,
	srt_streamid: 'e2e',
	max_br: 5000,
};

let pageWs: WebSocketRoute | null = null;

/** Mock the preview leg: codec-config + one audio-level frame, NO access units. */
function mockPreviewSocket(ws: WebSocketRoute): void {
	ws.onMessage((message) => {
		const text = typeof message === 'string' ? message : message.toString();
		let parsed: { action?: string };
		try {
			parsed = JSON.parse(text);
		} catch {
			return;
		}
		if (parsed?.action !== 'start') return;
		ws.send(JSON.stringify({ type: 'codec-config', codec: 'avc1.42E01E' }));
		ws.send(JSON.stringify({ type: 'audio-level', rms_db: [-18, -24], peak_db: [-6, -11] }));
	});
}

/**
 * Proxy the backend WS, force is_streaming:false on status frames.
 *
 * Single-origin preview proxy (Task 20): PreviewCanvas mints a token over the RPC
 * socket, then dials the SAME backend origin at `/preview?token=…`, so the preview
 * socket matches THIS route too. Fake that leg in-page (codec-config + audio-level,
 * no access units → terminal `waiting`) rather than proxying to the real
 * mock-preview upstream, whose real H.264 access units would drive the harness
 * browser's `VideoDecoder` to `error` instead of `waiting`.
 */
async function routeBackend(page: Page): Promise<void> {
	await page.routeWebSocket(/:(3002|31\d\d)/, (ws) => {
		if (ws.url().includes('/preview')) {
			mockPreviewSocket(ws);
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

test.describe('LiveView preview placement (#72)', () => {
	test.beforeEach(async ({ page }) => {
		pageWs = null;
		await routeBackend(page);
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
		injectServerConfig();
	});

	test('PreviewCanvas renders under the source section, toggle + meter operable', async ({
		page,
	}) => {
		const picker = page.getByTestId('input-picker');
		const preview = page.getByTestId('preview');
		await expect(picker).toBeVisible();
		await expect(preview).toBeVisible();

		// DOM proof for the overhauled Live column (Task 4–16): the bare
		// <InputPicker> is now wrapped by <SourceSection> and the roadmap pills sit
		// between it and the preview, so the preview is no longer the picker's
		// immediate sibling. The invariant is that the preview is a same-column
		// sibling that FOLLOWS the source section which contains the input picker.
		const placement = await page.evaluate(() => {
			const section = document.querySelector('[data-testid="source-section"]');
			const picker = document.querySelector('[data-testid="input-picker"]');
			const preview = document.querySelector('[data-testid="preview"]');
			if (!section || !picker || !preview) return 'missing';
			const wrapsPicker = section.contains(picker);
			const followsSection = !!(
				section.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING
			);
			const sameColumn = section.parentElement === preview.parentElement;
			return wrapsPicker && followsSection && sameColumn
				? 'ok'
				: `wraps=${wrapsPicker} follows=${followsSection} sameColumn=${sameColumn}`;
		});
		expect(placement).toBe('ok');

		// Toggle the preview on: aria-pressed flips, canvas + audio meter mount.
		const toggle = page.getByTestId('preview-toggle');
		await expect(toggle).toHaveAttribute('aria-pressed', 'false');
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');

		await expect(page.getByTestId('preview-canvas')).toBeVisible();
		await expect(page.getByTestId('audio-level-meter')).toBeVisible();
	});

	test('no active encode → preview reaches the waiting state with the i18n string', async ({
		page,
	}) => {
		const preview = page.getByTestId('preview');
		await expect(preview).toBeVisible();
		await page.getByTestId('preview-toggle').click();

		// codec-config but no video access units → terminal status is "waiting".
		await expect(preview).toHaveAttribute('data-status', 'waiting');
		// live.preview.waiting === "Waiting for video…" (en base locale).
		await expect(preview).toContainText('Waiting for video');
		// Meter still mounts in the waiting state.
		await expect(page.getByTestId('audio-level-meter')).toBeVisible();
	});

	test('@visual evidence: preview + meter adjacent to the input selector', {
		tag: '@visual',
	}, async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'desktop viewport owns evidence');

		await expect(page.getByTestId('input-picker')).toBeVisible();
		await page.getByTestId('preview-toggle').click();
		await expect(page.getByTestId('preview-canvas')).toBeVisible();
		await expect(page.getByTestId('audio-level-meter')).toBeVisible();

		await page
			.getByRole('main')
			.first()
			.screenshot({ path: path.join(EVIDENCE_DIR, '72-liveview-verify.png') });
	});

	test('@visual evidence: waiting state', { tag: '@visual' }, async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'desktop viewport owns evidence');

		const preview = page.getByTestId('preview');
		await expect(preview).toBeVisible();
		await page.getByTestId('preview-toggle').click();
		await expect(preview).toHaveAttribute('data-status', 'waiting');
		await expect(preview).toContainText('Waiting for video');

		await preview.screenshot({ path: path.join(EVIDENCE_DIR, '72-waiting.png') });
	});
});
