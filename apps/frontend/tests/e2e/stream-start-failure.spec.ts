/**
 * T16 — specific stream-start failure reason in the LiveView toast, @functional.
 *
 * When a stream start is refused, the backend returns a structured
 * `{ success: false, error }` carrying a cerastream Tier-2 code. The LiveView
 * toast must surface the SPECIFIC per-code message — not the generic
 * "Failed to start stream" — and fall back to the generic copy when the reason
 * is absent or unrecognised.
 *
 * State is injected per-page with a `routeWebSocket` proxy (same pattern as
 * disabled-reasons.spec.ts): real auth + hydration flow through to the live mock
 * backend, and only the `streaming.start` RPC reply is rewritten (plus a known
 * recognised pipeline injected so the Start control is enabled), so the forced
 * state remains page-local and cannot persist into this worker's later tests.
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
	await page.routeWebSocket((url) => url.pathname === '/ws', (ws) => {
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
const KNOWN_SOURCE = 'e2e-start-source';

// A schema-valid capture StreamSource for the unified device-first list. The
// GoLiveCard source gate resolves `config.source` against this list (T13); a
// single available capture source with a matching id makes that gate pass.
const START_SOURCE = {
	origin: 'capture',
	id: KNOWN_SOURCE,
	pipelineId: KNOWN_PIPELINE,
	kind: 'hdmi',
	displayName: 'E2E Start Camera',
	devicePath: '/dev/video0',
	modes: [{ width: 1920, height: 1080, framerates: [30, 60] }],
	supportsAudio: false,
	supportsResolutionOverride: false,
	supportsFramerateOverride: false,
	audioKind: 'none',
	available: true,
};

/**
 * Drive the Live "Start Stream" control into a failed start whose RPC reply is
 * `result`, then return so the caller can assert the resulting toast. Pins the
 * config to a recognised pipeline + source AND a server target (the default dev
 * backend ships without one, so all four StreamSetupChain gates — source /
 * destination / network / engine — resolve green and Start is enabled), and
 * replies to the streaming.start RPC with the supplied structured result.
 */
async function startWithReply(
	page: Page,
	result: Frame | (() => Frame),
	onPowerCall?: (path: string) => void,
): Promise<WsHandle> {
	const ws = await attachWs(page, {
		mutateInbound: (frame) => {
			const status = frame.status as Frame | undefined;
			if (status && 'is_streaming' in status) status.is_streaming = false;
			const config = frame.config as Frame | undefined;
			if (config) {
				config.pipeline = KNOWN_PIPELINE;
				config.source = KNOWN_SOURCE;
				if (!config.srtla_addr && !config.relay_server) config.srtla_addr = '127.0.0.1';
			}
			// Drop the real pipelines + sources registries; we push authoritative ones.
			return !('pipelines' in frame) && !('sources' in frame);
		},
		interceptOutbound: (frame, reply) => {
			const path = rpcPath(frame);
			if (path === 'streaming.start') {
				reply({ id: frame.id, result: typeof result === 'function' ? result() : result });
				return true;
			}
			if (onPowerCall && (path === 'system.reboot' || path === 'system.poweroff')) {
				onPowerCall(path);
				reply({ id: frame.id, result: { success: false } });
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
	ws.push({ sources: { hardware: 'generic', sources: [START_SOURCE] } });
	ws.push({ config: { pipeline: KNOWN_PIPELINE, source: KNOWN_SOURCE, srtla_addr: '127.0.0.1' } });

	const start = page.getByTestId('live-bar').getByRole('button');
	await expect(start).toBeVisible();
	await expect(start).toBeEnabled();
	await start.click();
	return ws;
}

test('Restart box opens Power and waits for the nested reboot confirmation', async ({ page }) => {
	let attempt = 0;
	const powerCalls: string[] = [];
	await startWithReply(page, () => {
		const attemptId = `power-${++attempt}`;
		return {
			result: 'failed', success: false, attemptId,
			failure: { attemptId, phase: 'connect', class: 'engine_unavailable', retriable: true },
		};
	}, (path) => powerCalls.push(path));
	await page.getByRole('button', { name: 'Try again', exact: true }).click();
	await page.getByRole('button', { name: 'Restart box', exact: true }).click();
	const power = page.getByRole('dialog', { name: 'Reboot / Power' });
	await expect(power).toBeVisible();
	expect(powerCalls).toEqual([]);
	await power.getByRole('button', { name: 'Reboot', exact: true }).click();
	const confirmation = page.getByRole('dialog', { name: 'Are you sure?' });
	await expect(confirmation).toBeVisible();
	expect(powerCalls).toEqual([]);
	await confirmation.getByRole('button', { name: 'Reboot', exact: true }).click();
	await expect.poll(() => powerCalls).toEqual(['system.reboot']);
});

test('Open stream setup focuses the shipped card heading', async ({ page }) => {
	const attemptId = 'invalid-setup';
	await startWithReply(page, {
		result: 'failed', success: false, attemptId,
		failure: { attemptId, phase: 'params', class: 'start_invalid', retriable: false },
	});
	await page.getByRole('button', { name: 'Open stream setup', exact: true }).press('Enter');
	const heading = page.getByTestId('stream-setup-chain').getByRole('heading', { name: 'Stream setup' });
	await expect(heading).toBeFocused();
});

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
			error: 'srt_connect_failed',
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
			error: 'totally_unknown_reason',
		});

		await expect(page.getByText(GENERIC_TEXT, { exact: true })).toBeVisible();
		await expect(page.getByText(SRT_CONNECT_TEXT)).toHaveCount(0);
	});
});

for (const [locale, theme] of [['en', 'light'], ['ar', 'dark']] as const) {
	test(`refusal actions fit at 390×390 and follow reading order in ${locale} ${theme}`, async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 390 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.addInitScript(({ locale, theme }) => {
			localStorage.setItem('locale', JSON.stringify({ code: locale }));
			localStorage.setItem('theme', JSON.stringify(theme));
			localStorage.setItem('mode-watcher-mode', theme);
		}, { locale, theme });
		const attemptId = `phone-${locale}`;
		const ws = await startWithReply(page, {
			result: 'failed', success: false, attemptId,
			failure: { attemptId, phase: 'connect', class: 'engine_unavailable', retriable: true },
		});
		const toast = page.locator('[data-sonner-toast]').filter({ hasText: locale === 'ar' ? 'حاول مرة أخرى' : 'Try again' });
		const primary = toast.getByRole('button', { name: locale === 'ar' ? 'حاول مرة أخرى' : 'Try again', exact: true });
		const logs = toast.getByRole('button', { name: locale === 'ar' ? 'عرض السجلات' : 'View logs', exact: true });
		await expect(primary).toBeVisible();
		await expect(logs).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
		await expect(page.locator('[data-sonner-toaster]').first()).toHaveAttribute('data-sonner-theme', theme);
		await expect(page.locator('section[aria-live="polite"]').filter({ has: toast })).toHaveCount(1);
		const [p, l] = await Promise.all([primary.boundingBox(), logs.boundingBox()]);
		const bar = await page.getByTestId('live-bar').boundingBox();
		if (!p || !l || !bar) throw new Error('missing refusal action or Live bar bounds');
		for (const box of [p, l]) {
			expect(box.height).toBeGreaterThanOrEqual(44);
			expect(box.x).toBeGreaterThanOrEqual(0);
			expect(box.x + box.width).toBeLessThanOrEqual(390);
			expect(box.y).toBeGreaterThanOrEqual(0);
			expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
		}
		expect(p.y < l.y || (p.y === l.y && (locale === 'ar' ? p.x > l.x : p.x < l.x))).toBe(true);
		await primary.focus();
		await page.keyboard.press('Tab');
		await expect(logs).toBeFocused();
		ws.push({ netif: { eth0: { enabled: false } } });
		await expect(page.getByTestId('live-bar').getByRole('button')).toBeDisabled();
		await primary.press('Enter');
		await expect(logs).toBeVisible();
	});
}
