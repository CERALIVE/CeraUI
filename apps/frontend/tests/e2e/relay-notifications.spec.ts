import fs from 'node:fs';
import path from 'node:path';

import { expect, type Page, test } from '@playwright/test';

import { navigateTo } from './helpers/index.js';

// Workstream evidence root: CeraUI/.omo/evidence (where every prior task in this
// workstream wrote its evidence). e2e -> tests -> frontend -> apps -> CeraUI.
const EVIDENCE_DIR = path.resolve(import.meta.dirname, '../../../../.omo/evidence');

/**
 * Task 21 — Relay catalog + notification toasts, integrated E2E (mock mode).
 *
 * Exercises the full stack the relay-servers-and-notifications workstream built,
 * against the REAL dev backend (MOCK_SCENARIO=multi-modem-wifi, NODE_ENV=
 * development → `dev.emit` registered):
 *
 *   1. Startup noise — a fresh authed connect surfaces ≤1 toast (T16/T17:
 *      auth-success removed, initial connect suppressed).
 *   2. Relay tab — with the live catalog populated (T6/T7) the relay tab is
 *      enabled, each server renders a RelayRttIndicator (T12, `data-rtt-tier`),
 *      the RTT digits animate across ≥2 rebroadcasts (T7, every 1.5s), and the
 *      operator's server selection is NOT disturbed by those updates.
 *   3. Single toast — a backend notification injected via `dev.emit` produces
 *      exactly ONE toast (T13/T14: one emitter, dedup by name) whose store
 *      duration is ~5s (`* 1000`, not the old `* 2500`).
 *   4. Locale — switching locale via the locale-selector then triggering a NEW
 *      notification renders the translated string (de). Already-visible toasts
 *      are intentionally NOT re-translated (D10 — stale accepted), so the switch
 *      precedes the trigger.
 *   5. Manual fallback — when the relay catalog is absent the relay tab is gated
 *      (disabled + waiting hint, D6) and the manual SRTLA path still saves.
 *
 * ── Auth + harness (mirrors field-lock.spec.ts) ─────────────────────────────
 * The app's authenticated socket is wrapped via `addInitScript` so the test can
 * authenticate WITHOUT the device password: the `auth.login` frame is rewritten
 * to a valid persistent TOKEN read from the backend's `auth_tokens.json` (the
 * playwright.config seeds a `placeholder` token). The SAME harness optionally
 * strips the `relays` key from inbound frames so the relay catalog can be held
 * absent on demand (scenario 5) — the app sets `socket.onmessage` by assignment
 * (client.ts), so the wrapper intercepts that assignment.
 *
 * Conventions (PLAYBOOK.md): no `page.screenshot()`/`toHaveScreenshot()` in this
 * functional spec, no `waitForTimeout()` — every async wait is a web-first
 * assertion or `expect.poll` against a real changing signal. Evidence is written
 * as ARIA/text proof (the PLAYBOOK-sanctioned form) to `.omo/evidence/
 * task-21-e2e/`; video is captured at the runner level (allowed — it does not go
 * through the guarded `page.screenshot`).
 *
 * Backend broadcasts reach EVERY authed client, so this file runs `serial` to
 * keep `dev.emit` injections from leaking between its own tests.
 */

const TOKEN: string = (() => {
	const tokensPath = path.resolve(import.meta.dirname, '../../../backend/auth_tokens.json');
	const tokens = Object.keys(
		JSON.parse(fs.readFileSync(tokensPath, 'utf8')) as Record<string, true>,
	);
	if (tokens.length === 0) {
		throw new Error(`No persistent auth tokens in ${tokensPath}; cannot authenticate e2e socket.`);
	}
	return tokens[0];
})();

// duration:5 (seconds on the wire) → 5000ms in the store (proves the `* 1000`
// fix vs the old `* 2500`).
const NOTIF_DURATION_S = 5;

// Capture video evidence for every test in this file (runner-level, not the
// guarded page.screenshot path).
test.use({ video: 'on' });

test.describe.configure({ mode: 'serial' });

const evidence: string[] = [];
function record(line: string): void {
	evidence.push(line);
	console.log(`[task-21-e2e] ${line}`);
}

test.afterAll(() => {
	if (evidence.length === 0) return;
	const dir = path.join(EVIDENCE_DIR, 'task-21-e2e');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, 'report.txt'),
		[
			'Task 21 — Relay catalog + notification toasts, integrated E2E',
			'Driver: real frontend + real dev backend (mock multi-modem-wifi),',
			'        notifications injected via dev.emit, store/relay state read in-page.',
			`Generated: ${new Date().toISOString()}`,
			'',
			...evidence,
			'',
		].join('\n'),
		'utf8',
	);
});

/**
 * Browser-side WebSocket harness (serialized via addInitScript; fully
 * self-contained except its single options argument). Rewrites `auth.login` to a
 * persistent token and, when `dropRelays` is set, strips the `relays` key from
 * every inbound frame so the catalog stays absent.
 */
function installWsHarness(opts: { token: string; dropRelays: boolean }): void {
	const Native = window.WebSocket;

	class HookedWebSocket extends Native {
		set onmessage(handler: ((this: WebSocket, ev: MessageEvent) => unknown) | null) {
			if (handler === null || !opts.dropRelays) {
				super.onmessage = handler;
				return;
			}
			const self = this;
			super.onmessage = (ev: MessageEvent) => {
				try {
					const parsed = JSON.parse(ev.data);
					if (
						parsed &&
						typeof parsed === 'object' &&
						Object.prototype.hasOwnProperty.call(parsed, 'relays')
					) {
						delete parsed.relays;
						handler.call(self, new MessageEvent('message', { data: JSON.stringify(parsed) }));
						return;
					}
				} catch {
					/* non-JSON frame — pass through untouched */
				}
				handler.call(self, ev);
			};
		}

		get onmessage(): ((this: WebSocket, ev: MessageEvent) => unknown) | null {
			return super.onmessage;
		}

		send(data: string | Blob | BufferSource): void {
			if (typeof data === 'string') {
				try {
					const msg = JSON.parse(data);
					if (Array.isArray(msg.path) && msg.path.join('.') === 'auth.login') {
						msg.input = { token: opts.token, persistent_token: true };
						super.send(JSON.stringify(msg));
						return;
					}
				} catch {
					/* not an RPC frame (e.g. keepalive) */
				}
			}
			super.send(data);
		}
	}

	window.WebSocket = HookedWebSocket as typeof WebSocket;
	// Non-empty value makes Layout attempt auto-login on load; the harness
	// rewrites that login frame to the token.
	try {
		localStorage.setItem('auth', 'e2e-token-marker');
	} catch {
		/* localStorage unavailable */
	}
}

// ── In-page bridges (use the app's own singleton modules; no source edits) ──

interface ActiveLite {
	name: string;
	text: string;
	type: string;
	durationMs: number;
	isPersistent: boolean;
}

/** Read the central notification store's active entries (T10/T13). */
function readActiveNotifications(page: Page): Promise<ActiveLite[]> {
	return page.evaluate(async () => {
		const specPath = '/src/lib/stores/notifications.svelte.ts';
		const mod = await import(/* @vite-ignore */ specPath);
		return mod.getActive();
	});
}

/** Inject a backend `notifications` broadcast via the dev-only `dev.emit`. */
async function emitNotification(page: Page, notification: Record<string, unknown>): Promise<void> {
	await page.evaluate(async (n) => {
		const specPath = '/src/lib/rpc/client.ts';
		const mod = await import(/* @vite-ignore */ specPath);
		await mod.rpc.dev.emit({ type: 'notifications', payload: { show: [n] } });
	}, notification);
}

/** Read the live relay catalog server count from the subscriptions store. */
function readRelayServerCount(page: Page): Promise<number> {
	return page.evaluate(async () => {
		const specPath = '/src/lib/rpc/subscriptions.svelte.ts';
		const mod = await import(/* @vite-ignore */ specPath);
		const relays = mod.getRelays();
		return relays ? Object.keys(relays.servers ?? {}).length : -1;
	});
}

/**
 * Open the Receiver Server dialog from the Live destination, tolerant of both
 * layouts: when a server is configured the StreamSettingsCard row carries the
 * `open-server-dialog` testid; with no server the Live view shows the empty
 * state whose single "Edit Settings" button opens the same dialog.
 */
async function openServerDialog(page: Page) {
	const byTestId = page.getByTestId('open-server-dialog');
	if ((await byTestId.count()) > 0) {
		await byTestId.click();
	} else {
		await page.getByRole('button', { name: 'Edit Settings' }).first().click();
	}
	const dialog = page.getByRole('dialog', { name: 'Receiver Server' });
	await expect(dialog).toBeVisible();
	return dialog;
}

test.beforeEach(({ browserName }, testInfo) => {
	test.skip(browserName !== 'chromium', 'single-browser integration proof');
	test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the relay dialog + shell');
});

// ── Describe 1: live backend (catalog populated) ────────────────────────────

test.describe('relay catalog + notifications (live mock backend)', () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(installWsHarness, { token: TOKEN, dropRelays: false });
		await page.goto('/');
		await navigateTo(page, 'live');
	});

	test('1 — fresh connect surfaces ≤1 toast (startup-noise check)', async ({ page }) => {
		const active = await readActiveNotifications(page);
		const visibleToasts = await page.locator('[data-sonner-toast]').count();

		expect(active.length).toBeLessThanOrEqual(1);
		expect(visibleToasts).toBeLessThanOrEqual(1);
		record(
			`Scenario 1: startup noise — store active=${active.length}, visible toasts=${visibleToasts} (≤1) ✓`,
		);
	});

	test('2 — relay tab populates with animating RTT indicators and a stable selection', async ({
		page,
	}) => {
		// Sanity: the live catalog is populated (T6/T7) before we open the dialog.
		await expect
			.poll(async () => readRelayServerCount(page), {
				timeout: 10_000,
				message: 'relay catalog should populate from the mock backend',
			})
			.toBeGreaterThan(0);

		const dialog = await openServerDialog(page);

		const relayTab = dialog.getByRole('tab', { name: 'Relay Server' });
		await expect(relayTab).toBeEnabled();
		await relayTab.click();
		record('Scenario 2: catalog populated → relay tab ENABLED ✓');

		// Open the server catalog and assert RTT indicators render with real tiers.
		await dialog.locator('#relay-server').click();
		const tierEls = page.locator('[data-rtt-tier]');
		await expect(tierEls.first()).toBeVisible();
		const tiers = await tierEls.evaluateAll((els) => els.map((e) => e.getAttribute('data-rtt-tier')));
		expect(tiers.some((t) => t === 'good' || t === 'fair' || t === 'weak')).toBe(true);
		record(`Scenario 2: server list RTT tiers observed = ${JSON.stringify(tiers)} ✓`);

		// Select the first server (exercise the real Select UI).
		await page.getByRole('option').first().click();
		const nameLoc = dialog.locator('#relay-server span.truncate').first();
		const selectedName = (await nameLoc.textContent())?.trim() ?? '';
		expect(selectedName.length).toBeGreaterThan(0);
		record(`Scenario 2: selected server = "${selectedName}"`);

		// The trigger's RTT indicator must animate across ≥2 rebroadcasts (1.5s
		// each). Collect distinct rounded readings until we see ≥2 or time out.
		const rttLoc = dialog.locator('#relay-server [data-rtt-tier]');
		await expect(rttLoc).toBeVisible();
		const seen = new Set<string>();
		await expect
			.poll(
				async () => {
					const t = (await rttLoc.textContent())?.trim();
					if (t) seen.add(t);
					return seen.size;
				},
				{ timeout: 12_000, message: 'RTT digits should change across ≥2 rebroadcasts' },
			)
			.toBeGreaterThanOrEqual(2);
		record(
			`Scenario 2: RTT animated across rebroadcasts — distinct readings = ${JSON.stringify([...seen])} ✓`,
		);

		// Selection must be intact despite the live RTT churn.
		await expect(nameLoc).toHaveText(selectedName);
		record('Scenario 2: selection stayed stable across RTT updates ✓');
	});

	test('3 — a backend notification shows exactly one toast with ~5s duration', async ({ page }) => {
		// Baseline: no toasts before injection.
		await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);

		await emitNotification(page, {
			name: 'e2e-single-toast',
			type: 'info',
			msg: 'E2E single toast probe',
			key: 'notifications.updateAvailable',
			is_dismissable: true,
			is_persistent: false,
			duration: NOTIF_DURATION_S,
		});

		// Exactly ONE toast — no duplicate emitter (T14).
		await expect(page.locator('[data-sonner-toast]')).toHaveCount(1);
		await expect(page.getByText('Update Available')).toBeVisible();

		// Duration is seconds→ms (`* 1000`), not the old `* 2500`.
		const active = await readActiveNotifications(page);
		const entry = active.find((n) => n.name === 'e2e-single-toast');
		expect(entry?.durationMs).toBe(NOTIF_DURATION_S * 1000);
		record(
			`Scenario 3: single toast (count=1, no dup), durationMs=${entry?.durationMs} (~5s) ✓`,
		);
	});

	test('4 — switching locale translates a newly triggered notification (de)', async ({ page }) => {
		// Switch locale to German via the real locale-selector control.
		await page.getByTestId('locale-selector').click();
		await page.getByTestId('locale-option-de').click();
		await expect
			.poll(() => page.evaluate(() => document.documentElement.lang), {
				timeout: 8000,
				message: 'locale should switch to de (translations loaded)',
			})
			.toBe('de');
		record('Scenario 4: locale switched to de via locale-selector ✓');

		// Trigger a NEW notification AFTER the switch (D10: never re-translate an
		// already-visible toast). `notifications.saved` is genuinely localized:
		// en "Saved" → de "Gespeichert".
		await emitNotification(page, {
			name: 'e2e-locale-toast',
			type: 'success',
			msg: 'Saved',
			key: 'notifications.saved',
			is_dismissable: true,
			is_persistent: false,
			duration: NOTIF_DURATION_S,
		});

		await expect(page.getByText('Gespeichert')).toBeVisible();
		const active = await readActiveNotifications(page);
		const entry = active.find((n) => n.name === 'e2e-locale-toast');
		expect(entry?.text).toBe('Gespeichert');
		record(
			`Scenario 4: post-switch notification rendered translated text "${entry?.text}" (de) ✓`,
		);
	});
});

// ── Describe 2: relay catalog ABSENT (manual fallback) ──────────────────────

test.describe('relay gate + manual fallback (catalog absent)', () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(installWsHarness, { token: TOKEN, dropRelays: true });
		await page.goto('/');
		await navigateTo(page, 'live');
	});

	test('5 — relay tab is gated (disabled + waiting hint); manual SRTLA still saves', async ({
		page,
	}) => {
		// The catalog is suppressed → getRelays() stays undefined (count -1).
		await expect
			.poll(() => readRelayServerCount(page), {
				timeout: 8000,
				message: 'relay catalog should be held absent by the harness',
			})
			.toBe(-1);

		const dialog = await openServerDialog(page);

		// D6 gate: relay tab disabled + waiting hint.
		await expect(dialog.getByRole('tab', { name: 'Relay Server' })).toBeDisabled();
		await expect(page.getByText('Waiting for relay servers')).toBeVisible();
		record('Scenario 5: catalog absent → relay tab DISABLED + waiting hint shown ✓');

		// Manual SRTLA path still usable.
		await dialog.getByRole('tab', { name: 'Manual Configuration' }).click();
		await dialog.locator('#srtla-addr').fill('192.168.50.10');
		await dialog.locator('#srtla-port').fill('5000');

		const save = dialog.getByRole('button', { name: 'Save' });
		await expect(save).toBeEnabled();
		await save.click();

		// Accepted → dialog closes (setConfig resolved, toast.success fired).
		await expect(dialog).toBeHidden();
		record('Scenario 5: manual SRTLA config accepted (dialog closed) ✓');
	});
});
