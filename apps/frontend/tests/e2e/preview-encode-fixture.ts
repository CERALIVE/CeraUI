import type { Page, WebSocketRoute } from '@playwright/test';

import { expect } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';

/**
 * Shared WS harness for the four T15 preview-toggle functional specs.
 *
 * Everything the control reads is DRIVEN ON THE PROXY rather than through a
 * frontend fixture, for two reasons that both bit earlier todos in this effort:
 *
 *  - CI serves a PRODUCTION bundle (`vite preview`), which prunes every
 *    `import.meta.env.DEV` fixture. A spec that leans on one passes locally and
 *    fails in CI (T13's finding).
 *  - The backend re-broadcasts `status` on its own cadence, and its
 *    `preview_encoder_realized` is `null` whenever the mock is idle — so a value
 *    merely PUSHED once would be retracted by the next tick. Rewriting the frame
 *    as it passes is the only stable form (T11's `device-stats` finding).
 *
 * `streaming.setConfig` is answered ON THE PROXY too, never forwarded. The
 * backend persists `previewEncode` to disk, so a forwarded write would leak into
 * every later test sharing that worker's backend. The proxy records the call,
 * synthesizes the `{success, applied}` result the real procedure returns, and
 * echoes the `config` broadcast that follows it — which is exactly the round trip
 * the control's pessimistic switch waits for.
 */

/** The three readings of the capability gate that the specs need to produce. */
export type CapabilityFixture = true | false | 'absent';

export interface PreviewEncoderRealizedFixture {
	selected_element?: string;
	realized_element: string;
	mode: 'software' | 'hardware';
	fallback_reason?: { code: 'factory-missing' } | { code: 'property-failure'; property: string };
}

export interface RecordedRpcCall {
	readonly path: readonly string[];
	readonly input: Record<string, unknown>;
}

export interface PreviewEncodeHarness {
	/** Every `streaming.setConfig` the page dispatched, in order. */
	readonly setConfigCalls: RecordedRpcCall[];
	/** Push a `config` broadcast, as the backend does after a persisted write. */
	pushConfig(config: Record<string, unknown>): void;
}

const SERVER_CONFIG = {
	srtla_addr: '127.0.0.1',
	srtla_port: 5000,
	srt_streamid: 'e2e',
	max_br: 5000,
};

interface HarnessOptions {
	capability: CapabilityFixture;
	realized?: PreviewEncoderRealizedFixture | null;
}

function applyCapability(
	capabilities: Record<string, unknown>,
	capability: CapabilityFixture,
): void {
	const preview = {
		...((capabilities.preview as Record<string, unknown> | undefined) ?? {
			enabled: true,
			bound: true,
		}),
	};
	if (capability === 'absent') {
		delete preview.preview_hw_capability;
	} else {
		preview.preview_hw_capability = capability;
	}
	capabilities.preview = preview;
}

/**
 * Mock the preview media leg: a codec-config so the canvas leaves `connecting`,
 * and no access units. The real mock upstream sends genuine H.264, which drives
 * the harness browser's decoder to `error` — noise this spec has no interest in.
 */
function mockPreviewSocket(ws: WebSocketRoute): void {
	ws.onMessage((message) => {
		const text = typeof message === 'string' ? message : message.toString();
		try {
			if ((JSON.parse(text) as { action?: string })?.action !== 'start') return;
		} catch {
			return;
		}
		ws.send(JSON.stringify({ type: 'codec-config', codec: 'avc1.42E01E' }));
	});
}

export async function routePreviewEncode(
	page: Page,
	options: HarnessOptions,
): Promise<PreviewEncodeHarness> {
	const setConfigCalls: RecordedRpcCall[] = [];
	let pageWs: WebSocketRoute | null = null;

	// The mock preview leg speaks WebCodecs only; neutralizing RTCPeerConnection
	// keeps the tier ladder off WebRTC so the canvas settles deterministically.
	await page.addInitScript(() => {
		(window as { RTCPeerConnection?: unknown }).RTCPeerConnection = undefined;
	});

	await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
		if (ws.url().includes('/preview')) {
			mockPreviewSocket(ws);
			return;
		}
		pageWs = ws;
		const server = ws.connectToServer();

		ws.onMessage((m) => {
			const text = typeof m === 'string' ? m : m.toString();
			try {
				const request = JSON.parse(text) as {
					id?: string;
					path?: string[];
					input?: Record<string, unknown>;
				};
				if (
					request.id &&
					request.path?.join('.') === 'streaming.setConfig' &&
					request.input?.previewEncode !== undefined
				) {
					setConfigCalls.push({ path: request.path, input: request.input });
					const applied = { previewEncode: request.input.previewEncode };
					ws.send(JSON.stringify({ id: request.id, result: { success: true, applied } }));
					ws.send(JSON.stringify({ config: applied }));
					return;
				}
			} catch {
				/* binary / non-JSON frame */
			}
			server.send(m);
		});

		server.onMessage((m) => {
			const text = typeof m === 'string' ? m : m.toString();
			try {
				const frame = JSON.parse(text) as {
					capabilities?: Record<string, unknown>;
					status?: Record<string, unknown>;
				};
				if (frame.capabilities) {
					applyCapability(frame.capabilities, options.capability);
					ws.send(JSON.stringify(frame));
					return;
				}
				if (frame.status) {
					// Pinned idle so the cockpit DOM never swaps mid-spec; the control
					// is deliberately independent of `is_streaming` and reads only the
					// realized field, which is what makes that pin safe here.
					frame.status.is_streaming = false;
					frame.status.preview_encoder_realized = options.realized ?? null;
					ws.send(JSON.stringify(frame));
					return;
				}
			} catch {
				/* binary / non-JSON frame */
			}
			ws.send(m);
		});
	});

	return {
		setConfigCalls,
		pushConfig(config) {
			pageWs?.send(JSON.stringify({ config }));
		},
	};
}

/** Reveal the collapsed "Preview" disclosure that hosts the control. */
export async function openPreviewDisclosure(page: Page): Promise<void> {
	const disclosure = page.getByTestId('preview-disclosure');
	await expect(disclosure).toBeVisible();
	await disclosure.locator('summary').click();
	await expect(page.getByTestId('preview')).toBeVisible();
}

/**
 * Route → authenticate → Live → seed config → reveal the disclosure. The server
 * config frame is what takes the Live view out of its empty state; without it the
 * cockpit (and therefore the disclosure) never renders.
 */
export async function bootstrapPreviewEncode(
	page: Page,
	options: HarnessOptions & { persistedRequest?: 'software' | 'hardware' },
): Promise<PreviewEncodeHarness> {
	const harness = await routePreviewEncode(page, options);
	await page.goto('/');
	await ensureAuthenticated(page);
	await navigateTo(page, 'live');
	harness.pushConfig({
		...SERVER_CONFIG,
		...(options.persistedRequest ? { previewEncode: options.persistedRequest } : {}),
	});
	await openPreviewDisclosure(page);
	return harness;
}
