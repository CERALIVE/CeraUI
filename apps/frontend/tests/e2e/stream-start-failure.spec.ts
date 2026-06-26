/**
 * T16 — specific stream-start failure reason in the LiveView toast, @functional.
 *
 * When a stream start is refused, the backend returns a structured
 * `{ success: false, reason }` carrying a cerastream Tier-2 code. The LiveView
 * toast must surface the SPECIFIC per-code message — not the generic
 * "Failed to start stream" — and fall back to the generic copy when the reason
 * is absent or unrecognised.
 *
 * State is injected per-page with a `routeWebSocket` proxy (same pattern as
 * disabled-reasons.spec.ts): real auth + hydration flow through to the live mock
 * backend, and only the `streaming.start` RPC reply is rewritten (plus a known
 * recognised pipeline injected so the Start control is enabled), so nothing here
 * leaks into a sibling spec running in parallel.
 */
import type { Page, WebSocketRoute } from '@playwright/test';

import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';

type Frame = Record<string, unknown>;

interface WsHooks {
	mutateInbound?: (frame: Frame) => boolean;
	interceptOutbound?: (frame: Frame, replyToClient: (response: unknown) => void) => boolean;
}

interface WsHandle {
	push: (frame: Frame) => void;
}

async function attachWs(page: Page, hooks: WsHooks): Promise<WsHandle> {
	let route: WebSocketRoute | null = null;
	await page.routeWebSocket(/:(3002|31\d\d|8090|8091)\//, (ws) => {
		route = ws;
		const server = ws.connectToServer();
		ws.onMessage((message) => {
			if (hooks.interceptOutbound) {
				const text = typeof message === 'string' ? message : message.toString();
				try {
					const frame = JSON.parse(text) as Frame;
					const handled = hooks.interceptOutbound(frame, (response) =>
						ws.send(JSON.stringify(response)),
					);
					if (handled) return;
				} catch {
					/* non-JSON / keepalive frame — pass through */
				}
			}
			server.send(message);
		});
		server.onMessage((message) => {
			if (hooks.mutateInbound) {
				const text = typeof message === 'string' ? message : message.toString();
				try {
					const frame = JSON.parse(text) as Frame;
					const keep = hooks.mutateInbound(frame);
					if (!keep) return;
					ws.send(JSON.stringify(frame));
					return;
				} catch {
					/* non-JSON / binary frame — pass through */
				}
			}
			ws.send(message);
		});
	});
	return { push: (frame: Frame) => route?.send(JSON.stringify(frame)) };
}

/** RPC path of a parsed outbound frame, or '' when it is not an RPC frame. */
function rpcPath(frame: Frame): string {
	return Array.isArray(frame.path) ? (frame.path as string[]).join('.') : '';
}

const GENERIC_TEXT = 'Failed to start stream';
const SRT_CONNECT_TEXT = /Couldn.t reach the SRT server/;
const KNOWN_PIPELINE = 'e2e-start-pipeline';

/**
 * Drive the Live "Start Stream" control into a failed start whose RPC reply is
 * `result`, then return so the caller can assert the resulting toast. Pins the
 * config to a recognised pipeline (so Start is enabled) while keeping the seeded
 * server target intact (so the control renders at all), and replies to the
 * streaming.start RPC with the supplied structured result.
 */
async function startWithReply(page: Page, result: Frame): Promise<void> {
	const ws = await attachWs(page, {
		mutateInbound: (frame) => {
			const status = frame.status as Frame | undefined;
			if (status && 'is_streaming' in status) status.is_streaming = false;
			const config = frame.config as Frame | undefined;
			if (config) config.pipeline = KNOWN_PIPELINE;
			// Drop the real pipelines registry; we push our own authoritative one.
			return !('pipelines' in frame);
		},
		interceptOutbound: (frame, reply) => {
			if (rpcPath(frame) === 'streaming.start') {
				reply({ id: frame.id, result });
				return true;
			}
			return false;
		},
	});
	await page.goto('/');
	await ensureAuthenticated(page);
	await navigateTo(page, 'live');
	ws.push({
		pipelines: {
			hardware: 'generic',
			pipelines: {
				[KNOWN_PIPELINE]: {
					name: 'E2E Start Pipeline',
					supportsAudio: false,
					supportsResolutionOverride: false,
					supportsFramerateOverride: false,
				},
			},
		},
	});
	ws.push({ config: { pipeline: KNOWN_PIPELINE } });

	const start = page.getByRole('button', { name: 'Start Stream' });
	await expect(start).toBeVisible();
	await expect(start).toBeEnabled();
	await start.click();
}

test.describe('stream-start failure reason in the toast (T16)', () => {
	test.beforeEach(({ browserName }, testInfo) => {
		test.skip(browserName !== 'chromium', 'single-browser toast-copy lock');
		test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the Live controls');
	});

	test('a structured reason renders the SPECIFIC per-code message, not the generic copy', async ({
		page,
	}) => {
		await startWithReply(page, {
			success: false,
			is_streaming: false,
			reason: 'srt_connect_failed',
		});

		// The concrete per-code message is shown…
		await expect(page.getByText(SRT_CONNECT_TEXT)).toBeVisible();
		// …and the generic fallback copy is NOT.
		await expect(page.getByText(GENERIC_TEXT, { exact: true })).toHaveCount(0);
	});

	test('an unknown reason falls back to the generic message', async ({ page }) => {
		await startWithReply(page, {
			success: false,
			is_streaming: false,
			reason: 'totally_unknown_reason',
		});

		await expect(page.getByText(GENERIC_TEXT, { exact: true })).toBeVisible();
		await expect(page.getByText(SRT_CONNECT_TEXT)).toHaveCount(0);
	});
});
