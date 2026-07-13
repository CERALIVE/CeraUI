import type { WebSocketRoute } from '@playwright/test';

import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';

/**
 * C4 — the preview follows the APPLIED source.
 *
 * With the preview enabled over the mock backend, selecting a different source in
 * the unified SourceSection list must make PreviewCanvas tear its socket down and
 * redial with a fresh token so the preview shows the newly applied input.
 *
 * The proxy (routeWebSocket, same pattern as source-overhaul.spec.ts):
 *   • forwards auth + RPC traffic to the real backend untouched;
 *   • DROPS the backend's own `devices`/`sources` echoes so the INJECTED unified
 *     source list is authoritative (video0/video1);
 *   • HOLDS the `streaming.setConfig` RPC (a source id the real backend does not
 *     know would be rejected by its source-routing gate), then fake-resolves it and
 *     injects the applied `config.source` echo — the settled edge PreviewCanvas
 *     watches;
 *   • mocks the SEPARATE `/preview` socket leg (codec-config → status `waiting`,
 *     no access units) and COUNTS each dial, so a redial is observable as the dial
 *     count incrementing.
 */

let pageWs: WebSocketRoute | null = null;
// Each new `/preview` WebSocket connection increments this — a redial is proven by
// the count going from 1 (initial) to 2 (after the source change).
let previewDials = 0;
let holdSetConfig = false;
let heldSetConfigId: string | number | null = null;
let heldSetConfigInput: Record<string, unknown> | null = null;

function send(payload: unknown): void {
	pageWs?.send(JSON.stringify(payload));
}

function resolveHeldSetConfig(): void {
	if (heldSetConfigId !== null) {
		pageWs?.send(
			JSON.stringify({
				id: heldSetConfigId,
				result: { success: true, applied: heldSetConfigInput ?? {} },
			}),
		);
		heldSetConfigId = null;
		heldSetConfigInput = null;
	}
}

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
		ws.send(JSON.stringify({ type: 'audio-level', rms_db: [-18], peak_db: [-6] }));
	});
}

type Device = {
	input_id: string;
	device_path: string;
	display_name: string;
	media_class: 'video' | 'audio';
	kind: string;
};

const HDMI: Device = {
	input_id: 'video0',
	device_path: '/dev/video0',
	display_name: 'HDMI Camera',
	media_class: 'video',
	kind: 'hdmi',
};
const USB: Device = {
	input_id: 'video1',
	device_path: '/dev/video1',
	display_name: 'USB Capture',
	media_class: 'video',
	kind: 'usb',
};

function captureSource(
	id: string,
	kind: string,
	pipelineId: string,
	displayName: string,
): Record<string, unknown> {
	return {
		origin: 'capture',
		id,
		pipelineId,
		kind,
		displayName,
		devicePath: `/dev/${id}`,
		modes: [{ width: 1920, height: 1080, framerates: [30, 60] }],
		supportsAudio: kind === 'hdmi',
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		defaultResolution: '1080p',
		defaultFramerate: 30,
		audioKind: kind === 'hdmi' ? 'selectable' : 'none',
		available: true,
	};
}

const CAP_HDMI = captureSource('video0', 'hdmi', 'hdmi', 'HDMI Camera');
const CAP_USB = captureSource('video1', 'usb', 'libuvch264', 'USB Capture');

function serverConfig(extra: Record<string, unknown> = {}): void {
	send({
		config: {
			srtla_addr: '127.0.0.1',
			srtla_port: 5000,
			srt_streamid: 'e2e',
			max_br: 6000,
			pipeline: 'hdmi',
			...extra,
		},
	});
}

function sendSources(sources: Record<string, unknown>[]): void {
	send({ sources: { hardware: 'rk3588', sources } });
}

function sendDevices(activeInput: string, devices: Device[]): void {
	send({ devices: { engine: 'cerastream', active_input: activeInput, devices } });
}

test.describe('C4 preview follows the applied source', () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== 'desktop',
			'desktop layout drives the source overhaul; mobile/kiosk/RTL are the @visual suite',
		);

		pageWs = null;
		previewDials = 0;
		holdSetConfig = false;
		heldSetConfigId = null;
		heldSetConfigInput = null;

		await page.routeWebSocket(/:(3002|31\d\d|6173)/, (ws) => {
			if (ws.url().includes('/preview')) {
				previewDials += 1;
				mockPreviewSocket(ws);
				return;
			}
			pageWs = ws;
			const server = ws.connectToServer();

			ws.onMessage((m) => {
				if (holdSetConfig) {
					const text = typeof m === 'string' ? m : m.toString();
					try {
						const frame = JSON.parse(text) as {
							id?: string | number;
							path?: unknown;
							input?: Record<string, unknown>;
						};
						const rpc = Array.isArray(frame.path) ? frame.path.join('.') : null;
						if (rpc === 'streaming.setConfig') {
							heldSetConfigId = frame.id ?? null;
							heldSetConfigInput = frame.input ?? null;
							return;
						}
					} catch {
						/* non-RPC frame */
					}
				}
				server.send(m);
			});

			server.onMessage((m) => {
				const text = typeof m === 'string' ? m : m.toString();
				try {
					const frame = JSON.parse(text) as { status?: Record<string, unknown> };
					if ('devices' in (frame as object)) return;
					if ('sources' in (frame as object)) return;
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

		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
	});

	test('selecting a different source closes the preview socket and redials', async ({
		page,
	}) => {
		holdSetConfig = true;
		serverConfig({ source: 'video0' });
		sendDevices('video0', [HDMI, USB]);
		sendSources([CAP_HDMI, CAP_USB]);

		// Open the collapsed preview disclosure and enable the preview.
		const disclosure = page.getByTestId('preview-disclosure');
		await expect(disclosure).toBeVisible({ timeout: 15_000 });
		await disclosure.locator('summary').click();
		const preview = page.getByTestId('preview');
		await expect(preview).toBeVisible();
		await page.getByTestId('preview-toggle').click();

		// The first dial reaches the mocked codec-config → terminal `waiting` state.
		await expect(preview).toHaveAttribute('data-status', 'waiting', {
			timeout: 10_000,
		});
		await expect.poll(() => previewDials, { timeout: 10_000 }).toBe(1);

		// Select the other source: setConfig is held, then fake-resolved + the applied
		// config echo injected — the settled edge PreviewCanvas follows.
		await page.getByTestId('source-select-video1').click();
		await expect.poll(() => heldSetConfigId !== null, { timeout: 5_000 }).toBe(true);
		resolveHeldSetConfig();
		serverConfig({ source: 'video1' });

		// The preview socket closes and redials: a SECOND `/preview` dial happens and
		// the status cycles back to `waiting` on the fresh socket.
		await expect
			.poll(() => previewDials, { timeout: 10_000 })
			.toBeGreaterThanOrEqual(2);
		await expect(preview).toHaveAttribute('data-status', 'waiting', {
			timeout: 10_000,
		});
	});
});
