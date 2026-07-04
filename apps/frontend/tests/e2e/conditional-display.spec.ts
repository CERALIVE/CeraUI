/**
 * T11 — Conditional-display state lock (regression).
 *
 * The seven branches below were audited and found CORRECT; this spec exists to
 * keep them that way. Each state is driven to a single, deterministic branch and
 * asserts BOTH that the intended branch renders AND that the sibling branch is
 * hidden — so a future edit that breaks the condition flips at least one
 * assertion red. No component source is touched.
 *
 * States locked (migrated to the GoLiveCard readiness model — Wave 3 T10/T11
 * absorbed the standalone onboarding/idle-ingest cards into GoLiveCard's gates):
 *   1. LiveView empty       — no server + idle → GoLiveCard destination gate blocked.
 *   2. LiveView idle-ingest — server set, not streaming → GoLiveCard network gate:
 *                             ready (enabled+IP'd links) vs blocked (no links).
 *   3. LiveView streaming   — active stream → bitrate HUD visible.
 *   4. DestinationSection   — managed gate: waiting (loading) vs none (empty).
 *   5. ServerIngestSlots    — prompt hint vs steady hint.
 *   6. AudioDialog          — gated (no pipeline) vs ungated (audio-capable).
 *   7. SshDialog            — inactive vs active display + the async/optimistic
 *                             toggle that holds disabled until the device confirms.
 *
 * Conventions (PLAYBOOK.md): role/text/ARIA assertions only — never screenshots,
 * never fixed-delay waits, never raw tab-id selectors. Navigation goes through
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
	test('LiveView empty: no server + idle blocks the GoLiveCard destination gate, hides the ready bar + streaming', async ({
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

		// Target branch: no server → the GoLiveCard destination gate blocks with an
		// open-server fix (the old "Choose a destination" onboarding hero was absorbed
		// into this readiness gate by T10/T11).
		const card = page.getByTestId('go-live-card');
		await expect(card).toBeVisible();
		const destGate = card.locator('[data-testid="go-live-gate"][data-gate="destination"]');
		await expect(destGate).toHaveAttribute('data-state', 'blocked');
		await expect(destGate.getByTestId('go-live-gate-fix')).toHaveAttribute('data-fix', 'openServer');

		// Start is blocked, and the disabled control surfaces a reason via `title`.
		const start = page.getByRole('button', { name: /start stream/i });
		await expect(start).toBeDisabled();
		await expect(start).toHaveAttribute('title', /\S/);

		// Sibling branches must be absent: not the all-green collapsed ready bar, and
		// no bitrate slider (idle has no live slider — the ceiling is a chip, T12).
		await expect(page.getByTestId('go-live-ready-bar')).toBeHidden();
		await expect(page.getByRole('slider')).toHaveCount(0);

		await assertNoNewA11y(page);
	});

	// ── 2a. LiveView idle-ingest: links ready ──────────────────────────────────
	test('LiveView idle: server configured + bonded links up resolves the network gate ready, hides the blocked + streaming states', async ({
		page,
	}) => {
		// Default mock scenario (multi-modem-wifi) brings up eth0 + 3 modems + WiFi,
		// all enabled with IPs → the GoLiveCard network gate resolves ok. Inject a
		// server so the destination gate is satisfied too, isolating the network gate.
		const ws = await attachWs(page, {
			mutateInbound: (frame) => {
				const status = frame.status as Frame | undefined;
				if (status) status.is_streaming = false;
				const config = frame.config as Frame | undefined;
				if (config && !config.srtla_addr && !config.relay_server) config.srtla_addr = '127.0.0.1';
				return true;
			},
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
		ws.push({ status: { is_streaming: false } });

		// Target branch: the network gate is ok (enabled+IP'd links standing by) — the
		// old links-ready idle card was absorbed into this readiness gate (T10/T11).
		const card = page.getByTestId('go-live-card');
		await expect(card).toBeVisible();
		const networkGate = card.locator('[data-testid="go-live-gate"][data-gate="network"]');
		await expect(networkGate).toHaveAttribute('data-state', 'ok');

		// Sibling branches absent: the network gate is NOT blocked (no goNetwork fix on
		// it) and the destination gate is not blocked either (server configured).
		await expect(networkGate.getByTestId('go-live-gate-fix')).toHaveCount(0);
		await expect(
			card.locator('[data-testid="go-live-gate"][data-gate="destination"][data-state="blocked"]'),
		).toHaveCount(0);

		// Bitrate is first-class on the idle surface, but via the tap-to-edit ceiling
		// chip that opens EncoderDialog (T12 one-owner) — NOT a live idle slider.
		await expect(page.getByTestId('bitrate-ceiling-chip')).toBeVisible();
		await expect(page.getByRole('slider')).toHaveCount(0);

		await assertNoNewA11y(page);
	});

	// ── 2b. LiveView idle-ingest: no links ─────────────────────────────────────
	test('LiveView idle: server configured but no bonded links blocks the network gate, hides the ready + streaming states', async ({
		page,
	}) => {
		// Force every interface disabled so no link is enabled+IP'd → the GoLiveCard
		// network gate resolves blocked (points to Network via the goNetwork fix).
		// Inject a server so ONLY the network gate is the discriminator here.
		const ws = await attachWs(page, {
			mutateInbound: (frame) => {
				const status = frame.status as Frame | undefined;
				if (status) status.is_streaming = false;
				const config = frame.config as Frame | undefined;
				if (config && !config.srtla_addr && !config.relay_server) config.srtla_addr = '127.0.0.1';
				const netif = frame.netif as Record<string, Frame> | undefined;
				if (netif) {
					for (const entry of Object.values(netif)) {
						if (entry && typeof entry === 'object') entry.enabled = false;
					}
				}
				return true;
			},
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
		ws.push({ status: { is_streaming: false } });

		// Target branch: the network gate blocks (no enabled+IP'd link) and offers the
		// goNetwork fix — the old "No bonded links yet" empty card, now a readiness gate.
		const card = page.getByTestId('go-live-card');
		await expect(card).toBeVisible();
		const networkGate = card.locator('[data-testid="go-live-gate"][data-gate="network"]');
		await expect(networkGate).toHaveAttribute('data-state', 'blocked');
		await expect(networkGate.getByTestId('go-live-gate-fix')).toHaveAttribute('data-fix', 'goNetwork');

		// Sibling branch absent: the network gate is not ok. The idle bitrate ceiling
		// chip is present regardless of link readiness (T12) — never a live slider.
		await expect(page.getByTestId('bitrate-ceiling-chip')).toBeVisible();
		await expect(page.getByRole('slider')).toHaveCount(0);

		await assertNoNewA11y(page);
	});

	// ── 2c. LiveView idle-bitrate commit path ──────────────────────────────────
	test('LiveView idle: the bitrate ceiling persists via setConfig, never the live setBitrate', async ({
		page,
	}) => {
		// While idle the bitrate ceiling is edited through the GoLiveCard chip →
		// EncoderDialog, whose Save persists via streaming.setConfig (persist for the
		// next start), NOT streaming.setBitrate (the live engine hot-adjust) — T12.
		const rpcPaths: string[] = [];
		const ws = await attachWs(page, {
			mutateInbound: (frame) => {
				const status = frame.status as Frame | undefined;
				if (status) status.is_streaming = false;
				return true;
			},
			interceptOutbound: (frame) => {
				const path = Array.isArray(frame.path) ? (frame.path as string[]).join('.') : '';
				if (path) rpcPaths.push(path);
				return false; // record only — forward to the real mock backend
			},
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');
		ws.push({ status: { is_streaming: false } });

		// Open EncoderDialog via the idle bitrate-ceiling chip, edit the ceiling, Save.
		await page.getByTestId('bitrate-ceiling-chip').click();
		const dialog = page.getByRole('dialog', { name: 'Encoder Settings' });
		await expect(dialog).toBeVisible();
		const bitrateInput = dialog.locator('#encoder-bitrate');
		await bitrateInput.fill('7000');
		rpcPaths.length = 0;
		await dialog.getByRole('button', { name: 'Save' }).click();

		await expect
			.poll(() => rpcPaths.filter((p) => p === 'streaming.setConfig').length, {
				message: 'idle bitrate edit should dispatch streaming.setConfig',
			})
			.toBeGreaterThan(0);
		expect(rpcPaths).not.toContain('streaming.setBitrate');

		await assertNoNewA11y(page, ['aria-input-field-name']);
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

		const managed = dialog.getByTestId('destination-ceralive');
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

		const managed = dialog.getByTestId('destination-ceralive');
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
		// Seed remote_key so isPairedToManagedCloud() returns true and destination-ceralive is enabled.
		ws.push({ config: { remote_key: 'test-key', remote_provider: 'ceralive' } });
		ws.push({ 'ingest.slots': { slots: [SLOT_A, SLOT_B] } });

		const managed = dialog.getByTestId('destination-ceralive');
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
		// Seed remote_key so isPairedToManagedCloud() returns true and destination-ceralive is enabled.
		ws.push({ config: { remote_key: 'test-key', remote_provider: 'ceralive' } });
		ws.push({ 'ingest.slots': { slots: [SLOT_A] } });

		const managed = dialog.getByTestId('destination-ceralive');
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

		// Target branch: the gated "select a video source first" notice.
		await expect(
			dialog.getByText('Please select a video source first to configure audio settings'),
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

		// Target branch: the enabled audio controls. The source SELECTION moved to the
		// Source section (T15), so the dialog now surfaces a read-only active-source
		// line plus the codec control — both present only in the enabled branch.
		await expect(dialog.getByTestId('audio-source-active')).toBeVisible();
		await expect(dialog.locator('#audioCodec')).toBeVisible();
		// Sibling branches absent: neither gate notice is shown when audio is supported.
		await expect(
			dialog.getByText('Please select a video source first to configure audio settings'),
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
