/**
 * T13 — first-run onboarding guidance (Live).
 *
 * A calm, dismissible "get set up" checklist that guides Network → Server → Start
 * and checks each step off from existing config/state. It complements — never
 * duplicates — the empty-state hero: the hero is the focused "choose a
 * destination" CTA, this is the multi-step orientation a first-run operator sees.
 *
 * The checklist is derived state only:
 *   • Network — at least one enabled bonded interface that has an IP (getNetif()).
 *   • Server  — config.srtla_addr || config.relay_server (the existing hasServer).
 *   • Start   — the stream is or has been live (is_streaming / hadSession).
 * It auto-hides once both config steps (Network + Server) are satisfied, and can
 * be dismissed at any time; the dismissal persists in localStorage across reloads.
 *
 * Conventions (PLAYBOOK.md): role/test-id/ARIA assertions only — never
 * screenshots, never `waitForTimeout`, never `#nav-tab-*`. A page-local
 * `routeWebSocket` proxy forces the first-run state (no server + no network) by
 * stripping the seeded server fields and dropping every `netif` frame, so the
 * scenario can never leak into a sibling spec running in parallel.
 */
import type { Page, WebSocketRoute } from '@playwright/test';

import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';

type Frame = Record<string, unknown>;

interface WsHooks {
	/** Mutate a parsed server→client broadcast frame in place; return false to drop it. */
	mutateInbound?: (frame: Frame) => boolean;
}

/**
 * Install a page-local WebSocket proxy in front of the real dev backend. Real
 * traffic still flows (auth + hydration work against the live mock); the hook
 * only rewrites or drops the specific frames a scenario depends on. The route
 * survives a page reload, so a persisted-dismissal check sees the same state.
 */
async function attachWs(page: Page, hooks: WsHooks): Promise<void> {
	await page.routeWebSocket(/:(3002|8090|8091)\//, (ws: WebSocketRoute) => {
		const server = ws.connectToServer();
		ws.onMessage((message) => server.send(message));
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
}

/** Strip the seeded server target and drop every netif frame → true first run. */
function firstRunMutator(frame: Frame): boolean {
	const config = frame.config as Frame | undefined;
	if (config) {
		delete config.srtla_addr;
		delete config.relay_server;
	}
	const status = frame.status as Frame | undefined;
	if (status) status.is_streaming = false;
	// Drop the bonded-interface list so getNetif() stays empty (no network step).
	return !('netif' in frame);
}

test.describe('T13 — first-run onboarding (Live)', () => {
	test.beforeEach(({ browserName }, testInfo) => {
		test.skip(browserName !== 'chromium', 'single-browser onboarding proof');
		test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the checklist');
	});

	test('first run: no server + no network shows the checklist with actionable steps', async ({
		page,
	}) => {
		await attachWs(page, { mutateInbound: firstRunMutator });
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');

		const panel = page.getByTestId('live-onboarding');
		await expect(panel).toBeVisible();

		// Network + Server are the two incomplete CONFIG steps, each actionable.
		const networkStep = panel.getByTestId('onboarding-step-network');
		const serverStep = panel.getByTestId('onboarding-step-server');
		await expect(networkStep).toHaveAttribute('data-complete', 'false');
		await expect(serverStep).toHaveAttribute('data-complete', 'false');
		await expect(networkStep.getByRole('button', { name: 'Set up Network' })).toBeVisible();
		await expect(serverStep.getByRole('button', { name: 'Choose destination' })).toBeVisible();

		// Start is the final, not-yet-reached step.
		await expect(panel.getByTestId('onboarding-step-start')).toHaveAttribute(
			'data-complete',
			'false',
		);

		// Touch-safe: the dismiss control meets the 44px minimum tap target.
		const dismiss = panel.getByRole('button', { name: 'Dismiss setup guide' });
		const box = await dismiss.boundingBox();
		expect(box, 'dismiss control should have a layout box').not.toBeNull();
		expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
	});

	test('the server step opens the receiver dialog', async ({ page }) => {
		await attachWs(page, { mutateInbound: firstRunMutator });
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');

		const panel = page.getByTestId('live-onboarding');
		await expect(panel).toBeVisible();
		await panel
			.getByTestId('onboarding-step-server')
			.getByRole('button', { name: 'Choose destination' })
			.click();

		await expect(page.getByRole('dialog', { name: 'Receiver Server' })).toBeVisible();
	});

	test('dismissal persists across a reload', async ({ page }) => {
		await attachWs(page, { mutateInbound: firstRunMutator });
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');

		const panel = page.getByTestId('live-onboarding');
		await expect(panel).toBeVisible();

		await panel.getByRole('button', { name: 'Dismiss setup guide' }).click();
		await expect(panel).toBeHidden();

		// Reload with the SAME first-run state — the checklist would re-show were the
		// dismissal not persisted. localStorage must keep it gone.
		await page.reload();
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
		await expect(page.getByTestId('live-onboarding')).toBeHidden();
	});

	test('fully-configured device: the checklist is hidden', async ({ page }) => {
		// No mutation — the default mock seeds a server target and bonded links, so
		// both config steps are satisfied and the checklist must never show.
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');

		await expect(page.getByTestId('live-onboarding')).toBeHidden();
	});
});
