/**
 * Device pairing (claim code) — end-to-end, Task 20.
 *
 * Two layers:
 *   1. Happy path against the REAL dev backend (mock platform): open the
 *      dedicated Device Pairing dialog, generate a code, watch the countdown
 *      tick, complete pairing, and assert the paired state surfaces the
 *      subscription standing. Evidence → task-20-pairing-ok.txt.
 *   2. Fail paths via the field-lock WebSocket harness (addInitScript + token
 *      rewrite, see PLAYBOOK.md "Model Spec"):
 *        • expired code → the validity window elapses and the dialog
 *          auto-regenerates a fresh code (a second generateClaimCode frame).
 *        • invalid code → completePairing is faked to reject, and the dialog
 *          renders the error state.
 *      Evidence → task-20-pairing-fail.txt.
 *
 * No screenshots, no fixed-delay waits: charset assertions and web-first polling.
 */
import fs from 'node:fs';

import { expect, type Page, test as base } from '@playwright/test';

import { test } from './fixtures/index.js';
import { evidencePath } from './helpers/index.js';
import { SettingsPage } from './pages/settings.js';

const CLAIM_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6,8}$/;

// ── Layer 1: real backend happy path ────────────────────────────────────────

test.describe('Device pairing (claim code)', () => {
	test('shows code + ticking countdown, completes pairing, surfaces subscription standing', async ({
		authedPage: page,
	}) => {
		const settings = new SettingsPage(page);
		await settings.open();
		await settings.openPairing();

		const code = await settings.generateClaimCode();
		expect(code).toMatch(CLAIM_CODE_PATTERN);

		const expiry = page.getByTestId('claim-code-expiry');
		const firstLabel = ((await expiry.textContent()) ?? '').trim();
		await expect
			.poll(async () => ((await expiry.textContent()) ?? '').trim(), {
				timeout: 5000,
				message: 'countdown should tick (label decrements each second)',
			})
			.not.toBe(firstLabel);

		await settings.completePairing();
		const subStatus = page.getByTestId('pairing-sub-status');
		await expect(subStatus).toBeVisible();
		const standing = ((await subStatus.textContent()) ?? '').trim();

		fs.writeFileSync(
			evidencePath('task-20-pairing-ok.txt'),
			[
				'Task 20 — Device pairing happy path (real dev backend / mock platform)',
				`Generated: ${new Date().toISOString()}`,
				'',
				`Claim code shown: ${code} (matches ${CLAIM_CODE_PATTERN})`,
				`Countdown ticking: "${firstLabel}" -> changed within 5s ✓`,
				'Complete pairing → paired state visible (pairing-status) ✓',
				`Subscription standing surfaced (pairing-sub-status): "${standing}" ✓`,
				'Result: PASS',
				'',
			].join('\n'),
			'utf8',
		);

		await settings.closePairing();
	});
});

// ── Layer 2: WebSocket harness fail paths ────────────────────────────────────

const TOKEN: string = (() => {
	const tokensPath = new URL('../../../backend/auth_tokens.json', import.meta.url);
	const raw = fs.readFileSync(tokensPath, 'utf8');
	const tokens = Object.keys(JSON.parse(raw) as Record<string, true>);
	if (tokens.length === 0) {
		throw new Error(`No persistent auth tokens in ${tokensPath}; cannot authenticate e2e socket.`);
	}
	return tokens[0] as string;
})();

function installPairingHarness(token: string): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__cera) return;
	const Real = w.WebSocket;

	w.__cera = {
		socket: null,
		_pairGenCount: 0,
		_pairExpireFirst: false,
		_pairReject: false,
	};

	class HookedWS extends Real {
		// biome-ignore lint/suspicious/noExplicitAny: native ctor signature.
		constructor(url: string, protocols?: any) {
			super(url, protocols);
			w.__cera.socket = this;
			this.__realSend = Real.prototype.send.bind(this);
		}

		// biome-ignore lint/suspicious/noExplicitAny: WebSocket.send payload union.
		send(data: any) {
			try {
				const msg = JSON.parse(data);
				const p = Array.isArray(msg.path) ? msg.path.join('.') : null;
				const id = msg.id;

				if (p === 'auth.login') {
					msg.input = { token, persistent_token: true };
					return this.__realSend(JSON.stringify(msg));
				}

				if (p === 'pairing.generateClaimCode' && w.__cera._pairExpireFirst) {
					w.__cera._pairGenCount += 1;
					const now = Date.now();
					const first = w.__cera._pairGenCount === 1;
					const result = {
						code: first ? 'ABCD2345' : 'EFGH6789',
						validUntil: first ? now + 700 : now + 300_000,
						windowSeconds: 300,
					};
					setTimeout(() => {
						this.dispatchEvent(
							new MessageEvent('message', { data: JSON.stringify({ id, result }) }),
						);
					}, 0);
					return undefined;
				}

				if (p === 'pairing.completePairing' && w.__cera._pairReject) {
					setTimeout(() => {
						this.dispatchEvent(
							new MessageEvent('message', {
								data: JSON.stringify({
									id,
									result: { paired: false, error: 'invalid-claim-code' },
								}),
							}),
						);
					}, 0);
					return undefined;
				}
			} catch {
				/* not an RPC frame */
			}
			return this.__realSend(data);
		}
	}

	w.WebSocket = HookedWS;
	try {
		localStorage.setItem('auth', 'e2e-token-marker');
	} catch {
		/* localStorage unavailable */
	}
}

base.describe('Device pairing fail paths (WS harness)', () => {
	base.skip(({ browserName }) => browserName !== 'chromium', 'single-browser harness proof');

	base.beforeEach(async ({ page }, testInfo) => {
		base.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the pairing dialog');
		await page.addInitScript(installPairingHarness, TOKEN);
		await page.goto('/');
	});

	async function openPairingDialog(page: Page): Promise<void> {
		const settings = new SettingsPage(page);
		await settings.open();
		await settings.openPairing();
	}

	base('expired code auto-regenerates a fresh code', async ({ page }) => {
		await page.evaluate(() => {
			(window as any).__cera._pairExpireFirst = true;
		});
		await openPairingDialog(page);
		await page.getByTestId('generate-claim-code').click();

		await expect
			.poll(() => page.evaluate(() => (window as any).__cera._pairGenCount), {
				timeout: 8000,
				message: 'expired code should trigger an automatic regenerate (second generate frame)',
			})
			.toBeGreaterThanOrEqual(2);

		await expect(page.getByTestId('claim-code')).toHaveText('EFGH6789');
		await expect(page.getByTestId('claim-code-expiry')).toBeVisible();

		fs.writeFileSync(
			evidencePath('task-20-pairing-fail.txt'),
			[
				'Task 20 — Device pairing fail paths (WS harness)',
				`Generated: ${new Date().toISOString()}`,
				'',
				'A) Expired code → auto-regenerate',
				'   First generate returned a code expiring in ~700ms (validUntil now+700).',
				'   Countdown crossed validUntil → shouldAutoRegenerate fired generate again.',
				'   _pairGenCount reached >= 2; displayed code rotated to the fresh "EFGH6789" ✓',
				'',
			].join('\n'),
			'utf8',
		);
	});

	base('invalid code surfaces the error state', async ({ page }) => {
		await page.evaluate(() => {
			(window as any).__cera._pairReject = true;
		});
		await openPairingDialog(page);

		const code = await new SettingsPage(page).generateClaimCode();
		expect(code).toMatch(CLAIM_CODE_PATTERN);

		await page.getByTestId('complete-pairing').click();
		await expect(page.getByTestId('pairing-error')).toBeVisible();

		fs.appendFileSync(
			evidencePath('task-20-pairing-fail.txt'),
			[
				'B) Invalid code → error state',
				'   completePairing faked to reject with "invalid-claim-code".',
				'   Dialog rendered the error state (pairing-error visible) ✓',
				'',
				'Result: PASS',
				'',
			].join('\n'),
			'utf8',
		);
	});
});
