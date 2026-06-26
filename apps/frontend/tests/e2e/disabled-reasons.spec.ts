/**
 * T15 — Disabled-reason hints + loading/empty distinction, @functional.
 *
 * Audited "silent" disabled controls now carry a concise, accessible reason
 * (a `title` attribute) explaining WHY they are disabled, and the WiFi / modem
 * network-scan lists distinguish an in-progress "scanning" state from a settled
 * "no networks found" state. This spec drives each control into its disabled /
 * loading branch against the REAL frontend stack and asserts the reason / state
 * via the accessibility tree — never a screenshot (PLAYBOOK.md).
 *
 * State is injected per-page with a `routeWebSocket` proxy (same pattern as
 * conditional-display.spec.ts): real auth + hydration flow through to the live
 * mock backend; only the specific fields a branch depends on are rewritten or an
 * RPC is held pending, so nothing here leaks into a sibling spec running in
 * parallel.
 *
 * Controls covered (each previously silent — no reason where one already exists,
 * e.g. PowerDialog / Encoder / Transport are intentionally untouched):
 *   • WiFi scan button         — "Scanning in progress" while a scan is pending.
 *   • Hotspot start/stop        — "Enter a valid name and password…" when invalid.
 *   • Audio codec select        — "Select an audio source first" with no source.
 *   • Stream start button       — reuses the existing cannot-start copy.
 *   • WiFi list                 — distinct "Searching for networks…" vs empty.
 *   • Modem available networks  — distinct "Searching for operators…" vs empty.
 */
import type { Page, WebSocketRoute } from '@playwright/test';

import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';

type Frame = Record<string, unknown>;

interface WsHooks {
	/** Mutate a parsed server→client broadcast frame in place; return false to drop it. */
	mutateInbound?: (frame: Frame) => boolean;
	/**
	 * Intercept a parsed client→server RPC frame. Reply directly to the client and
	 * return true to swallow it (never forwarded), or false to let it through.
	 */
	interceptOutbound?: (frame: Frame, replyToClient: (response: unknown) => void) => boolean;
}

interface WsHandle {
	/** Inject a seq-less broadcast frame straight to the client. */
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

	return {
		push: (frame: Frame) => route?.send(JSON.stringify(frame)),
	};
}

/** RPC path of a parsed outbound frame, or '' when it is not an RPC frame. */
function rpcPath(frame: Frame): string {
	return Array.isArray(frame.path) ? (frame.path as string[]).join('.') : '';
}

test.describe('disabled-reason hints + loading/empty distinction (T15)', () => {
	test.beforeEach(({ browserName }, testInfo) => {
		test.skip(browserName !== 'chromium', 'single-browser reason/loading lock');
		test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives these surfaces');
	});

	// ── A2. Audio codec select — disabled reason when no source is chosen ───────
	test('Audio codec: disabled with no source carries the "select a source" reason', async ({
		page,
	}) => {
		const AUDIO_PIPELINE = 'e2e-audio-pipeline';
		const ws = await attachWs(page, {
			mutateInbound: (frame) => {
				const config = frame.config as Frame | undefined;
				if (config) {
					config.pipeline = AUDIO_PIPELINE;
					// No saved audio source → draftSource stays undefined → codec locked.
					delete config.asrc;
				}
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

		await page.getByTestId('open-audio-dialog').click();
		const dialog = page.getByRole('dialog', { name: 'Audio Settings' });
		await expect(dialog).toBeVisible();

		// Codec is locked (no source) and now explains why via `title`.
		const codec = dialog.locator('#audioCodec');
		await expect(codec).toBeVisible();
		await expect(codec).toHaveAttribute('title', 'Select an audio source first');
	});

	// ── A1. Hotspot start/stop — disabled reason when the form is invalid ───────
	test('Hotspot toggle: disabled with an invalid form carries the "enter name/password" reason', async ({
		page,
	}) => {
		await page.goto('/');
		await ensureAuthenticated(page);
		await page.locator('header').first().waitFor({ state: 'visible', timeout: 30_000 });
		await navigateTo(page, 'network');
		await page.getByTestId('open-hotspot-dialog').click();
		const dialog = page.getByRole('dialog', { name: 'Configure Hotspot' });
		await expect(dialog).toBeVisible();

		// Force the form invalid deterministically (independent of any mock seed).
		await page.locator('#hotspot-name').fill('');
		await page.locator('#hotspot-password').fill('');

		const toggle = dialog.getByRole('button', { name: 'Enable Hotspot', exact: true });
		await expect(toggle).toBeDisabled();
		await expect(toggle).toHaveAttribute(
			'title',
			'Enter a valid name and password to start the hotspot',
		);
	});

	// ── A3. Stream start — disabled reason when the pipeline is unrecognized ────
	test('Stream start: disabled without a usable pipeline carries the cannot-start reason', async ({
		page,
	}) => {
		await attachWs(page, {
			mutateInbound: (frame) => {
				const config = frame.config as Frame | undefined;
				// Keep a server target (hasServer true so the control renders) but
				// make the pipeline unrecognized → canStart false.
				if (config) config.pipeline = 'e2e-unknown-pipeline';
				const status = frame.status as Frame | undefined;
				if (status) status.is_streaming = false;
				return true;
			},
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await navigateTo(page, 'live');

		const start = page.getByRole('button', { name: 'Start Stream' });
		await expect(start).toBeVisible();
		await expect(start).toBeDisabled();
		await expect(start).toHaveAttribute(
			'title',
			'Select a video source before starting the stream',
		);
	});

	// ── A4 + B5. WiFi scan button reason + list scanning-vs-empty distinction ───
	test('WiFi: empty vs scanning are distinct, and the scan button explains why it is disabled', async ({
		page,
	}) => {
		const ws = await attachWs(page, {
			mutateInbound: (frame) => {
				// Empty every interface's available list so the list renders its
				// empty/scanning branch (not the network rows).
				const status = frame.status as Frame | undefined;
				const wifi = (status?.wifi ?? frame.wifi) as Record<string, Frame> | undefined;
				if (wifi) {
					for (const key of Object.keys(wifi)) {
						const iface = wifi[key];
						if (iface && typeof iface === 'object') iface.available = [];
					}
				}
				return true;
			},
			interceptOutbound: (frame, reply) => {
				// Hold every wifi.scan pending: reply success but never change the
				// available-set signature, so the user scan op stays `pending`.
				if (rpcPath(frame) === 'wifi.scan') {
					reply({ id: frame.id, result: { success: true } });
					return true;
				}
				return false;
			},
		});
		void ws;
		await page.goto('/');
		await ensureAuthenticated(page);
		await page.locator('header').first().waitFor({ state: 'visible', timeout: 30_000 });
		await navigateTo(page, 'network');
		await page.getByTestId('open-wifi-selector-dialog').click();
		const dialog = page.getByRole('dialog', { name: 'Available Networks' });
		await expect(dialog).toBeVisible();

		// Settled empty state: the "no networks" branch, NOT the scanning branch.
		await expect(dialog.getByTestId('wifi-empty-state')).toBeVisible();
		await expect(dialog.getByTestId('wifi-scanning-state')).toBeHidden();

		const scan = dialog.getByTestId('wifi-scan-button');
		await expect(scan).toBeEnabled();
		// No reason while it is actionable.
		await expect(scan).not.toHaveAttribute('title', /.+/);
		await scan.click();

		// Scanning state is now distinct from the empty state, and the button
		// explains its disabled reason.
		await expect(dialog.getByTestId('wifi-scanning-state')).toBeVisible();
		await expect(dialog.getByText('Searching for networks…')).toBeVisible();
		await expect(dialog.getByTestId('wifi-empty-state')).toBeHidden();
		await expect(scan).toBeDisabled();
		await expect(scan).toHaveAttribute('title', 'Scanning in progress');
	});

	// ── B6. Modem available networks — scanning-vs-none distinction ─────────────
	test('Modem: available-networks list distinguishes scanning from "no networks found"', async ({
		page,
	}) => {
		const patchModems = (modems: Record<string, Frame> | undefined) => {
			if (!modems) return;
			for (const key of Object.keys(modems)) {
				const modem = modems[key];
				if (!modem || typeof modem !== 'object') continue;
				modem.config = { ...((modem.config as Frame) ?? {}), roaming: true };
				modem.available_networks = {};
			}
		};
		await attachWs(page, {
			mutateInbound: (frame) => {
				patchModems(frame.modems as Record<string, Frame> | undefined);
				const status = frame.status as Frame | undefined;
				patchModems(status?.modems as Record<string, Frame> | undefined);
				return true;
			},
			interceptOutbound: (frame, reply) => {
				// Hold modems.scan pending (no new operators) so the scanning state
				// is observable and never settles to "no networks".
				if (rpcPath(frame) === 'modems.scan') {
					reply({ id: frame.id, result: { success: true } });
					return true;
				}
				return false;
			},
		});
		await page.goto('/');
		await ensureAuthenticated(page);
		await page.locator('header').first().waitFor({ state: 'visible', timeout: 30_000 });
		await navigateTo(page, 'network');
		await page.getByTestId('open-modem-config-dialog').first().click();
		const dialog = page.getByRole('dialog').first();
		await expect(dialog).toBeVisible();

		// Roaming is injected on → the operator scan area is shown; with no
		// operators and no scan running, the settled "none" hint is visible.
		await expect(dialog.getByText('No networks found yet. Scan to search for operators.')).toBeVisible();
		await expect(dialog.getByTestId('modem-scanning-state')).toBeHidden();

		const scan = dialog.getByTestId('modem-scan-button');
		await expect(scan).toBeEnabled();
		await scan.click();

		// In-flight: the scanning state replaces the settled "none" hint.
		await expect(dialog.getByTestId('modem-scanning-state')).toBeVisible();
		await expect(dialog.getByText('Searching for operators…')).toBeVisible();
		await expect(
			dialog.getByText('No networks found yet. Scan to search for operators.'),
		).toBeHidden();
	});
});
