/**
 * First-run onboarding guidance (Live) — migrated to the GoLiveCard readiness model.
 *
 * The standalone multi-step checklist (`OnboardingChecklist.svelte`, testid
 * `live-onboarding`, with `onboarding-step-network/-server/-start` sub-steps and a
 * "Dismiss setup guide" button) was UNMOUNTED by the Wave 3 T10/T11 restructure and
 * its Network → Server → Start orientation ABSORBED into the StreamSetupChain's
 * setup rows (encoder / audio / destination / network, each `ok`/`warn`/`blocked`).
 * The file is kept-not-deleted as a rollback shim (`TD-unmounted-source-shims`) but
 * is never rendered, so `live-onboarding` no longer appears in the DOM. These tests
 * assert the equivalent behavior on the setup rows instead.
 *
 * The row states are derived state only:
 *   • network     — at least one enabled bonded interface that has an IP (getNetif()).
 *   • destination — config.srtla_addr || config.relay_server (the existing hasServer).
 * The network row carries a one-tap fix (`setup-row-fix` `data-fix="goNetwork"`)
 * that navigates to the Network view; the destination row's fix affordance is its
 * Edit button (`open-server-dialog`) which opens the receiver dialog. Both config
 * rows satisfied is the new-model equivalent of the old checklist auto-hiding.
 *
 * Conventions (PLAYBOOK.md): role/test-id/ARIA assertions only — never
 * screenshots, never fixed-delay waits, never raw tab-id selectors. A page-local
 * `routeWebSocket` proxy forces the first-run state (no server + no network) by
 * stripping the seeded server fields and dropping every `netif` frame, so the
 * scenario remains page-local and cannot persist into this worker's later tests.
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
	await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws: WebSocketRoute) => {
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

		const card = page.getByTestId('stream-setup-chain');
		await expect(card).toBeVisible();

		// Network + destination are the two incomplete CONFIG rows, each blocked (the
		// old onboarding-step-network / -server steps).
		const networkRow = card.locator('[data-testid="setup-row"][data-row="network"]');
		await expect(networkRow).toHaveAttribute('data-state', 'blocked');
		await expect(networkRow.getByTestId('setup-row-fix')).toHaveAttribute(
			'data-fix',
			'goNetwork',
		);

		const destinationRow = card.locator(
			'[data-testid="setup-row"][data-row="destination"]',
		);
		await expect(destinationRow).toHaveAttribute('data-state', 'blocked');
		// The destination row's fix affordance is its Edit button, not a setup-row-fix.
		await expect(card.getByTestId('open-server-dialog')).toBeVisible();
	});

	test('the destination-gate fix opens the receiver dialog', async ({ page }) => {
		await attachWs(page, { mutateInbound: firstRunMutator });
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');

		const card = page.getByTestId('stream-setup-chain');
		await expect(card).toBeVisible();

		// The destination row's Edit button (the old "Choose destination" step) opens
		// the receiver/server dialog.
		await card.getByTestId('open-server-dialog').click();

		await expect(page.getByRole('dialog', { name: 'Receiver Server' })).toBeVisible();
	});

	test('the readiness gates re-render the same blocked state after a reload', async ({
		page,
	}) => {
		// There is no reachable dismiss/persisted-hide path anymore: the
		// OnboardingChecklist "Dismiss setup guide" affordance persisted via
		// onboarding.svelte.ts ($persist("live-onboarding-dismissed")), but that
		// component is unmounted (TD-unmounted-source-shims). The StreamSetupChain
		// always renders its rows (no collapse) — the row states are DERIVED, not a
		// user dismissal. So this locks the config-driven behavior that is actually
		// reachable: the same first-run state re-renders the same blocked rows
		// after a reload (no persisted dismissal can hide them).
		await attachWs(page, { mutateInbound: firstRunMutator });
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');

		const card = page.getByTestId('stream-setup-chain');
		await expect(card).toBeVisible();
		await expect(
			card.locator('[data-testid="setup-row"][data-row="destination"]'),
		).toHaveAttribute('data-state', 'blocked');

		await page.reload();
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');

		const reloadedCard = page.getByTestId('stream-setup-chain');
		await expect(reloadedCard).toBeVisible();
		await expect(
			reloadedCard.locator('[data-testid="setup-row"][data-row="destination"]'),
		).toHaveAttribute('data-state', 'blocked');
		await expect(
			reloadedCard.locator('[data-testid="setup-row"][data-row="network"]'),
		).toHaveAttribute('data-state', 'blocked');
	});

	test('fully-configured device: the network + destination rows are satisfied', async ({
		page,
	}) => {
		// A fully-configured device: inject a server target (the default dev backend
		// ships without one) on top of the default multi-modem-wifi bonded links, so
		// both config rows resolve satisfied. New-model equivalent of the old
		// "checklist auto-hides once both config steps are complete": neither row is
		// blocked (the chain always renders its rows — no vacuous collapse pass).
		await attachWs(page, {
			mutateInbound: (frame) => {
				const config = frame.config as Frame | undefined;
				if (config && !config.srtla_addr && !config.relay_server) {
					config.srtla_addr = '127.0.0.1';
				}
				return true;
			},
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');

		const card = page.getByTestId('stream-setup-chain');
		await expect(card).toBeVisible();
		await expect(
			card.locator('[data-testid="setup-row"][data-row="network"][data-state="blocked"]'),
		).toHaveCount(0);
		await expect(
			card.locator(
				'[data-testid="setup-row"][data-row="destination"][data-state="blocked"]',
			),
		).toHaveCount(0);
	});
});
