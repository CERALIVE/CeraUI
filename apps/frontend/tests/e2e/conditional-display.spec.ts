/**
 * T11 — Conditional-display state lock (regression).
 *
 * The seven branches below were audited and found CORRECT; this spec exists to
 * keep them that way. Each state is driven to a single, deterministic branch and
 * asserts BOTH that the intended branch renders AND that the sibling branch is
 * hidden — so a future edit that breaks the condition flips at least one
 * assertion red. No component source is touched.
 *
 * States locked:
 *   1. LiveView empty       — no server + idle → choose-destination onboarding.
 *   2. LiveView idle-ingest — server set, not streaming → idle bonded-links card.
 *   3. LiveView streaming   — active stream → bitrate HUD visible.
 *   4. DestinationSection   — managed gate: waiting (loading) vs none (empty).
 *   5. ServerIngestSlots    — prompt hint vs steady hint.
 *   6. AudioDialog          — gated (no pipeline) vs ungated (audio-capable).
 *   7. SshDialog            — inactive vs active display + the async/optimistic
 *                             toggle that holds disabled until the device confirms.
 *
 * Conventions (PLAYBOOK.md): role/text/ARIA assertions only — never screenshots,
 * never `waitForTimeout`, never `#nav-tab-*` selectors. Navigation goes through
 * `navigateTo()`. Each state is isolated per-page with a `routeWebSocket` proxy
 * (no global `dev.emit` broadcast) so a state forced here can never leak into a
 * sibling spec running in parallel. Every suite includes an axe gate.
 */
import type { Page, WebSocketRoute } from '@playwright/test';

import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';
import { runAxe } from './helpers/axe.js';

type Frame = Record<string, unknown>;

interface WsHooks {
	/** Mutate a parsed server→client broadcast frame in place; return false to drop it. */
	mutateInbound?: (frame: Frame) => boolean;
	/**
	 * Intercept a parsed client→server RPC frame. Reply directly to the client and
	 * return true to swallow it (never forwarded to the backend), or false to let
	 * it through unchanged.
	 */
	interceptOutbound?: (frame: Frame, replyToClient: (response: unknown) => void) => boolean;
}

interface WsHandle {
	/** Inject a seq-less broadcast frame straight to the client (bypasses the seq guard). */
	push: (frame: Frame) => void;
}

/**
 * Install a page-local WebSocket proxy in front of the real dev backend. Real
 * traffic still flows (so auth + hydration work against the live mock); the hooks
 * only rewrite or inject the specific fields a state depends on. Page-scoped, so
 * nothing here is observable by another spec's page.
 */
async function attachWs(page: Page, hooks: WsHooks): Promise<WsHandle> {
	let route: WebSocketRoute | null = null;

	await page.routeWebSocket(/:(3002|8090|8091)\//, (ws) => {
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

	return {
		push: (frame: Frame) => route?.send(JSON.stringify(frame)),
	};
}

/**
 * Assert the page carries no critical/serious axe violations beyond the single
 * baselined rule (`color-contrast`, per a11y-baseline.json). A NEW critical or
 * serious rule introduced by a regression in any locked state fails here.
 */
async function assertNoNewA11y(page: Page, extraAllowed: readonly string[] = []): Promise<void> {
	// `color-contrast` is the repo's standing baseline (a11y-baseline.json). Callers
	// may allow additional PRE-EXISTING rules a state legitimately surfaces that the
	// baseline gate (idle live/network/settings only) never scans — never to mask a
	// regression this lock introduced.
	const allowed = new Set(['color-contrast', ...extraAllowed]);
	const violations = await runAxe(page);
	const fresh = violations.filter((violation) => !allowed.has(violation.id));
	expect(
		fresh,
		`unexpected critical/serious a11y violations:\n${JSON.stringify(fresh, null, 2)}`,
	).toEqual([]);
}

async function openServerDialog(page: Page) {
	await navigateTo(page, 'live');
	await page.getByTestId('open-server-dialog').click();
	const dialog = page.getByRole('dialog', { name: 'Receiver Server' });
	await expect(dialog).toBeVisible();
	return dialog;
}

async function openAudioDialog(page: Page) {
	await navigateTo(page, 'live');
	await page.getByTestId('open-audio-dialog').click();
	const dialog = page.getByRole('dialog', { name: 'Audio Settings' });
	await expect(dialog).toBeVisible();
	return dialog;
}

async function openSshDialog(page: Page) {
	await page.locator('header').first().waitFor({ state: 'visible', timeout: 30_000 });
	await navigateTo(page, 'settings');
	await page.getByRole('button', { name: /SSH Access/ }).first().click();
	const dialog = page.getByRole('dialog', { name: 'SSH Access' });
	await expect(dialog).toBeVisible();
	return dialog;
}

test.describe('conditional-display state lock (T11)', () => {
	test.beforeEach(({ browserName }, testInfo) => {
		test.skip(browserName !== 'chromium', 'single-browser display-state lock');
		test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the display states');
	});

	// ── 1. LiveView empty state ────────────────────────────────────────────────
	test('LiveView empty: no server + idle renders the onboarding prompt, hides idle + streaming', async ({
		page,
	}) => {
		await attachWs(page, {
			mutateInbound: (frame) => {
				const config = frame.config as Frame | undefined;
				if (config) {
					delete config.srtla_addr;
					delete config.relay_server;
				}
				const status = frame.status as Frame | undefined;
				if (status) status.is_streaming = false;
				return true;
			},
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');

		// Target branch: the empty/onboarding state.
		await expect(page.getByRole('heading', { name: 'Choose a destination' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Edit Settings' })).toBeVisible();

		// Sibling branches must be absent: no idle-ingest card, no bitrate slider.
		await expect(page.getByTestId('ingest-idle-empty')).toBeHidden();
		await expect(page.getByRole('slider')).toHaveCount(0);

		await assertNoNewA11y(page);
	});

	// ── 2. LiveView idle-ingest ────────────────────────────────────────────────
	test('LiveView idle: server configured but not streaming shows the idle card, hides empty + streaming', async ({
		page,
	}) => {
		const ws = await attachWs(page, {
			mutateInbound: (frame) => {
				const status = frame.status as Frame | undefined;
				if (status) status.is_streaming = false;
				return true;
			},
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
		ws.push({ status: { is_streaming: false } });

		// Target branch: idle bonded-ingest card.
		await expect(page.getByTestId('ingest-idle-empty')).toBeVisible();
		await expect(page.getByRole('heading', { name: 'No bonded links yet' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Manage links' })).toBeVisible();

		// Sibling branches absent: not the empty state, not the streaming slider.
		await expect(page.getByRole('heading', { name: 'Choose a destination' })).toBeHidden();
		await expect(page.getByRole('slider')).toHaveCount(0);

		await assertNoNewA11y(page);
	});

	// ── 3. LiveView streaming ──────────────────────────────────────────────────
	test('LiveView streaming: an active stream reveals the bitrate HUD, hides idle + empty', async ({
		page,
	}) => {
		const ws = await attachWs(page, {
			mutateInbound: (frame) => {
				const status = frame.status as Frame | undefined;
				if (status) status.is_streaming = true;
				return true;
			},
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');

		// The mock never periodically re-broadcasts is_streaming, so drive it and
		// poll the streaming-only bitrate slider into existence (no fixed sleep).
		await expect
			.poll(
				async () => {
					ws.push({ status: { is_streaming: true } });
					return page
						.getByRole('slider')
						.first()
						.isVisible()
						.catch(() => false);
				},
				{ timeout: 8000, message: 'bitrate slider should appear once streaming' },
			)
			.toBe(true);

		// Target branch: the streaming bitrate adjuster.
		await expect(page.getByRole('slider').first()).toBeVisible();

		// Sibling branches absent: no idle card, no empty-state prompt.
		await expect(page.getByTestId('ingest-idle-empty')).toBeHidden();
		await expect(page.getByRole('heading', { name: 'Choose a destination' })).toBeHidden();

		// The bits-ui slider thumb carries no per-thumb accessible name (the label
		// sits on the slider root) — a pre-existing component limitation present
		// whenever the bitrate adjuster renders, not introduced by this lock.
		await assertNoNewA11y(page, ['aria-input-field-name']);
	});

	// ── 4. DestinationSection managed gate ─────────────────────────────────────
	test('Destination gate — loading: an absent relay catalog shows the waiting hint, managed disabled', async ({
		page,
	}) => {
		await attachWs(page, {
			// Drop the relay catalog entirely → getRelays() stays undefined (waiting).
			mutateInbound: (frame) => !('relays' in frame),
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		const dialog = await openServerDialog(page);

		const managed = dialog.getByTestId('destination-managed');
		await expect(managed).toBeDisabled();
		await expect(managed).toContainText('Waiting for relay servers');
		// The "none" gate hint must NOT be the one shown while waiting.
		await expect(managed).not.toContainText('No relay servers available');
		// Custom stays the always-reachable fallback.
		await expect(dialog.getByTestId('destination-custom')).toBeEnabled();

		await assertNoNewA11y(page);
	});

	test('Destination gate — none: an empty relay catalog shows the none hint, managed disabled', async ({
		page,
	}) => {
		await attachWs(page, {
			mutateInbound: (frame) => {
				if ('relays' in frame) frame.relays = { servers: {}, accounts: {} };
				return true;
			},
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		const dialog = await openServerDialog(page);

		const managed = dialog.getByTestId('destination-managed');
		await expect(managed).toBeDisabled();
		// The empty catalog arrives within the same window destination-server waits on.
		await expect(managed).toContainText('No relay servers available', { timeout: 15_000 });
		await expect(managed).not.toContainText('Waiting for relay servers');
		await expect(dialog.getByTestId('destination-custom')).toBeEnabled();

		await assertNoNewA11y(page);
	});

	// ── 5. ServerIngestSlots prompt hint ───────────────────────────────────────
	const SLOT_A = {
		endpointId: 'slot-a',
		host: '10.0.0.1',
		port: 5000,
		protocol: 'srtla',
		key: 'key-a',
		label: 'US East',
		region: 'us-east',
	};
	const SLOT_B = {
		endpointId: 'slot-b',
		host: '10.0.0.2',
		port: 5000,
		protocol: 'srtla',
		key: 'key-b',
		label: 'EU West',
		region: 'eu-west',
	};

	test('Ingest slots — prompt: multiple unresolved slots show the choose-instance prompt, not the steady hint', async ({
		page,
	}) => {
		const ws = await attachWs(page, {
			// Keep our injected slot list authoritative — drop any backend slot push.
			mutateInbound: (frame) => !('ingest.slots' in frame),
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		const dialog = await openServerDialog(page);
		ws.push({ 'ingest.slots': { slots: [SLOT_A, SLOT_B] } });

		const managed = dialog.getByTestId('destination-managed');
		await expect(managed).toBeEnabled({ timeout: 15_000 });
		await managed.click();

		// Target branch: the prompt hint (two slots, none auto-resolved).
		await expect(dialog.getByTestId('ingest-slots')).toBeVisible();
		await expect(dialog.getByText('Select a cloud instance to continue.')).toBeVisible();
		// Sibling branch: the steady hint must NOT show while prompting.
		await expect(
			dialog.getByText('Choose which cloud instance receives your stream.'),
		).toBeHidden();

		await assertNoNewA11y(page);
	});

	test('Ingest slots — resolved: a single auto-resolved slot shows the steady hint, not the prompt', async ({
		page,
	}) => {
		const ws = await attachWs(page, {
			mutateInbound: (frame) => !('ingest.slots' in frame),
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		const dialog = await openServerDialog(page);
		ws.push({ 'ingest.slots': { slots: [SLOT_A] } });

		const managed = dialog.getByTestId('destination-managed');
		await expect(managed).toBeEnabled({ timeout: 15_000 });
		await managed.click();

		await expect(dialog.getByTestId('ingest-slots')).toBeVisible();
		await expect(
			dialog.getByText('Choose which cloud instance receives your stream.'),
		).toBeVisible();
		await expect(dialog.getByText('Select a cloud instance to continue.')).toBeHidden();

		await assertNoNewA11y(page);
	});

	// ── 6. AudioDialog gate ────────────────────────────────────────────────────
	test('Audio gate — no pipeline: shows the select-pipeline notice, hides the audio source control', async ({
		page,
	}) => {
		await attachWs(page, {
			mutateInbound: (frame) => {
				const config = frame.config as Frame | undefined;
				if (config) delete config.pipeline;
				return true;
			},
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		const dialog = await openAudioDialog(page);

		// Target branch: the gated "select a pipeline first" notice.
		await expect(
			dialog.getByText('Please select an encoder pipeline first to configure audio settings'),
		).toBeVisible();
		// Sibling branches absent: no other gate notice, no audio source control.
		await expect(dialog.getByText('No audio settings supported')).toBeHidden();
		await expect(dialog.getByText('Audio source', { exact: true })).toHaveCount(0);

		await assertNoNewA11y(page);
	});

	test('Audio gate — enabled: an audio-capable pipeline renders the audio source control, hides both gate notices', async ({
		page,
	}) => {
		const AUDIO_PIPELINE = 'e2e-audio-pipeline';
		const ws = await attachWs(page, {
			mutateInbound: (frame) => {
				const config = frame.config as Frame | undefined;
				if (config) config.pipeline = AUDIO_PIPELINE;
				// Keep our injected pipeline catalog authoritative.
				return !('pipelines' in frame);
			},
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
		ws.push({
			pipelines: {
				hardware: 'generic',
				pipelines: { [AUDIO_PIPELINE]: { name: 'E2E Audio', supportsAudio: true } },
			},
		});
		ws.push({ config: { pipeline: AUDIO_PIPELINE } });

		const dialog = await openAudioDialog(page);

		// Target branch: the enabled audio controls (the audio source field).
		await expect(dialog.getByText('Audio source', { exact: true })).toBeVisible();
		// Sibling branches absent: neither gate notice is shown when audio is supported.
		await expect(
			dialog.getByText('Please select an encoder pipeline first to configure audio settings'),
		).toBeHidden();
		await expect(dialog.getByText('No audio settings supported')).toBeHidden();

		await assertNoNewA11y(page);
	});

	// ── 7. SshDialog display + async toggle ────────────────────────────────────
	test('SSH — inactive: shows the Start control + Inactive badge, hides the active state', async ({
		page,
	}) => {
		const ws = await attachWs(page, {
			mutateInbound: (frame) => {
				const status = frame.status as Frame | undefined;
				if (status) status.ssh = { active: false, user: 'cera' };
				return true;
			},
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		const dialog = await openSshDialog(page);
		ws.push({ status: { ssh: { active: false, user: 'cera' } } });

		await expect(dialog.getByRole('button', { name: 'Start SSH Server' })).toBeVisible();
		await expect(dialog.getByText('Inactive', { exact: true })).toBeVisible();
		// Sibling branch absent.
		await expect(dialog.getByRole('button', { name: 'Stop SSH Server' })).toHaveCount(0);

		await assertNoNewA11y(page);
	});

	test('SSH — active: shows the Stop control + Active badge, hides the inactive state', async ({
		page,
	}) => {
		const ws = await attachWs(page, {
			mutateInbound: (frame) => {
				const status = frame.status as Frame | undefined;
				if (status) status.ssh = { active: true, user: 'cera' };
				return true;
			},
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		const dialog = await openSshDialog(page);
		ws.push({ status: { ssh: { active: true, user: 'cera' } } });

		await expect(dialog.getByRole('button', { name: 'Stop SSH Server' })).toBeVisible();
		await expect(dialog.getByText('Active', { exact: true })).toBeVisible();
		// Sibling branch absent.
		await expect(dialog.getByRole('button', { name: 'Start SSH Server' })).toHaveCount(0);

		await assertNoNewA11y(page);
	});

	test('SSH — async toggle: the Start control stays optimistically disabled until the device confirms', async ({
		page,
	}) => {
		const ws = await attachWs(page, {
			mutateInbound: (frame) => {
				const status = frame.status as Frame | undefined;
				if (status) status.ssh = { active: false, user: 'cera' };
				return true;
			},
			interceptOutbound: (frame, reply) => {
				const path = Array.isArray(frame.path) ? (frame.path as string[]).join('.') : '';
				if (path === 'system.sshStart') {
					// Resolve the RPC success but WITHHOLD the authoritative ssh.active=true
					// echo, so the keyed op stays pending → the toggle holds its busy state.
					reply({ id: frame.id, result: { success: true } });
					return true;
				}
				return false;
			},
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		const dialog = await openSshDialog(page);
		ws.push({ status: { ssh: { active: false, user: 'cera' } } });

		const start = dialog.getByRole('button', { name: 'Start SSH Server' });
		await expect(start).toBeEnabled();
		await start.click();

		// Optimistic async toggle: the pending op disables the control and it never
		// flips to "Stop" while the device has not yet confirmed ssh.active.
		await expect(start).toBeDisabled();
		await expect(dialog.getByRole('button', { name: 'Stop SSH Server' })).toHaveCount(0);

		await assertNoNewA11y(page);
	});
});
