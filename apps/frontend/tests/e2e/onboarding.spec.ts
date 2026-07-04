/**
 * First-run onboarding guidance (Live) — migrated to the GoLiveCard readiness model.
 *
 * The standalone multi-step checklist (`OnboardingChecklist.svelte`, testid
 * `live-onboarding`, with `onboarding-step-network/-server/-start` sub-steps and a
 * "Dismiss setup guide" button) was UNMOUNTED by the Wave 3 T10/T11 restructure and
 * its Network → Server → Start orientation ABSORBED into `GoLiveCard`'s readiness
 * gates (source / network / destination / engine, each `ok`/`warn`/`blocked` with a
 * one-tap `go-live-gate-fix` button). The file is kept-not-deleted as a rollback
 * shim (`TD-unmounted-source-shims`) but is never rendered, so `live-onboarding` no
 * longer appears in the DOM. These tests assert the equivalent behavior on the
 * readiness gates instead.
 *
 * The gates are derived state only:
 *   • network     — at least one enabled bonded interface that has an IP (getNetif()).
 *   • destination — config.srtla_addr || config.relay_server (the existing hasServer).
 * A blocked config gate exposes a fix button (`data-fix="goNetwork"` /
 * `data-fix="openServer"`); both config gates satisfied is the new-model equivalent
 * of the old checklist auto-hiding.
 *
 * Conventions (PLAYBOOK.md): role/test-id/ARIA assertions only — never
 * screenshots, never fixed-delay waits, never raw tab-id selectors. A page-local
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
	await page.routeWebSocket(/:(3002|31\d\d|8090|8091)\//, (ws: WebSocketRoute) => {
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

test.describe('first-run onboarding (Live) — GoLiveCard readiness gates', () => {
	test.beforeEach(({ browserName }, testInfo) => {
		test.skip(browserName !== 'chromium', 'single-browser onboarding proof');
		test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the gates');
	});

	test('first run: no server + no network blocks the network and destination gates', async ({
		page,
	}) => {
		await attachWs(page, { mutateInbound: firstRunMutator });
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');

		const card = page.getByTestId('go-live-card');
		await expect(card).toBeVisible();

		// Network + destination are the two incomplete CONFIG gates, each blocked
		// with a one-tap fix (the old onboarding-step-network / -server steps).
		const networkGate = card.locator('[data-testid="go-live-gate"][data-gate="network"]');
		await expect(networkGate).toHaveAttribute('data-state', 'blocked');
		await expect(networkGate.getByTestId('go-live-gate-fix')).toHaveAttribute(
			'data-fix',
			'goNetwork',
		);

		const destinationGate = card.locator(
			'[data-testid="go-live-gate"][data-gate="destination"]',
		);
		await expect(destinationGate).toHaveAttribute('data-state', 'blocked');
		await expect(destinationGate.getByTestId('go-live-gate-fix')).toHaveAttribute(
			'data-fix',
			'openServer',
		);
	});

	test('the destination-gate fix opens the receiver dialog', async ({ page }) => {
		await attachWs(page, { mutateInbound: firstRunMutator });
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');

		const card = page.getByTestId('go-live-card');
		await expect(card).toBeVisible();

		// The destination gate's fix button (the old "Choose destination" step) opens
		// the receiver/server dialog.
		await card
			.locator('[data-testid="go-live-gate"][data-gate="destination"]')
			.getByTestId('go-live-gate-fix')
			.click();

		await expect(page.getByRole('dialog', { name: 'Receiver Server' })).toBeVisible();
	});

	test('the readiness gates re-render the same blocked state after a reload', async ({
		page,
	}) => {
		// There is no reachable dismiss/persisted-hide path anymore: the
		// OnboardingChecklist "Dismiss setup guide" affordance persisted via
		// onboarding.svelte.ts ($persist("live-onboarding-dismissed")), but that
		// component is unmounted (TD-unmounted-source-shims). GoLiveCard only
		// auto-collapses when every gate goes green — a DERIVED state, not a user
		// dismissal. So this locks the config-driven behavior that is actually
		// reachable: the same first-run state re-renders the same blocked gates
		// after a reload (no persisted dismissal can hide them).
		await attachWs(page, { mutateInbound: firstRunMutator });
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');

		const card = page.getByTestId('go-live-card');
		await expect(card).toBeVisible();
		await expect(
			card.locator('[data-testid="go-live-gate"][data-gate="destination"]'),
		).toHaveAttribute('data-state', 'blocked');

		await page.reload();
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');

		const reloadedCard = page.getByTestId('go-live-card');
		await expect(reloadedCard).toBeVisible();
		await expect(
			reloadedCard.locator('[data-testid="go-live-gate"][data-gate="destination"]'),
		).toHaveAttribute('data-state', 'blocked');
		await expect(
			reloadedCard.locator('[data-testid="go-live-gate"][data-gate="network"]'),
		).toHaveAttribute('data-state', 'blocked');
	});

	test('fully-configured device: the network + destination gates are satisfied', async ({
		page,
	}) => {
		// No mutation — the default mock seeds a server target and bonded links, so
		// both config gates resolve satisfied. New-model equivalent of the old
		// "checklist auto-hides once both config steps are complete": neither gate is
		// blocked (absent whether the card is expanded with ok gates or collapsed to
		// the ready bar).
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');

		const card = page.getByTestId('go-live-card');
		await expect(card).toBeVisible();
		await expect(
			card.locator('[data-testid="go-live-gate"][data-gate="network"][data-state="blocked"]'),
		).toHaveCount(0);
		await expect(
			card.locator(
				'[data-testid="go-live-gate"][data-gate="destination"][data-state="blocked"]',
			),
		).toHaveCount(0);
	});
});
