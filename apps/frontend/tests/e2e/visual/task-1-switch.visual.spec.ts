import fs from 'node:fs';
import path from 'node:path';

import { expect, type Locator, type Page, test } from '@playwright/test';

import { navigateTo, setTheme } from '../helpers/index.js';

// Repo-local evidence dir (apps/frontend/tests/e2e/visual -> CeraUI root, 5 up).
const REPO_EVIDENCE_DIR = path.resolve(import.meta.dirname, '../../../../../.omo/evidence');
function repoEvidence(name: string): string {
	return path.join(REPO_EVIDENCE_DIR, name);
}

/**
 * Task 1 — Switch primitive redesign: visible track + substantial thumb.
 *
 * Proves, against the REAL frontend at the 1024x600 kiosk viewport, that the
 * redesigned Switch (switch.svelte track/thumb + app.css --switch-off token)
 * reads as a real switch in BOTH states and BOTH themes:
 *   - Scenario 1 (track visibility): the OFF track's rendered background-color
 *     is NOT equal to the card surface behind it, in dark AND light.
 *   - Scenario 2 (thumb + transition): the thumb slides (translateX grows on
 *     toggle), the transition is animated (duration > 0), and the after-inset
 *     hit area expands the bare 32x18.4px track into a >=44px-wide target.
 *
 * Auth: the app socket is wrapped (addInitScript) so auth.login is rewritten to
 * a valid persistent token from the backend's auth_tokens.json — no device
 * password needed. Tagged @visual so evidence screenshots are permitted.
 */

const TOKEN: string = (() => {
	const tokensPath = path.resolve(import.meta.dirname, '../../../../backend/auth_tokens.json');
	const tokens = Object.keys(
		JSON.parse(fs.readFileSync(tokensPath, 'utf8')) as Record<string, true>,
	).filter((t) => t !== 'placeholder');
	if (tokens.length === 0) {
		throw new Error(`No real persistent auth tokens in ${tokensPath}; cannot authenticate.`);
	}
	return tokens[0];
})();

function installAuthHarness(token: string): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__ceraAuth) return;
	w.__ceraAuth = true;
	const Real = w.WebSocket;

	class HookedWS extends Real {
		// biome-ignore lint/suspicious/noExplicitAny: native ctor signature.
		constructor(url: string, protocols?: any) {
			super(url, protocols);
			this.__realSend = Real.prototype.send.bind(this);
		}

		// biome-ignore lint/suspicious/noExplicitAny: WebSocket.send payload union.
		send(data: any) {
			try {
				const msg = JSON.parse(data);
				const p = Array.isArray(msg.path) ? msg.path.join('.') : null;
				if (p === 'auth.login') {
					msg.input = { token, persistent_token: true };
					return this.__realSend(JSON.stringify(msg));
				}
			} catch {
				/* non-RPC frame */
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

type SwitchMetrics = {
	ariaChecked: string | null;
	dataState: string | null;
	dataSlot: string | null;
	trackBg: string;
	surfaceBg: string | null;
	thumbOffsetX: number;
	thumbTransitionMs: number;
	trackW: number;
	trackH: number;
	afterW: number;
	afterH: number;
};

/** Read rendered switch metrics for the exact located switch element. */
function readSwitchMetrics(toggle: Locator): Promise<SwitchMetrics> {
	return toggle.evaluate((el: HTMLElement) => {
		const cs = getComputedStyle(el);

		let surfaceBg: string | null = null;
		let p = el.parentElement;
		while (p) {
			const bg = getComputedStyle(p).backgroundColor;
			if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
				surfaceBg = bg;
				break;
			}
			p = p.parentElement;
		}

		const thumb = el.querySelector("[data-slot='switch-thumb']") as HTMLElement;
		const tcs = getComputedStyle(thumb);
		const thumbTransitionMs = (parseFloat(tcs.transitionDuration) || 0) * 1000;

		const rect = el.getBoundingClientRect();
		// Tailwind v4 `translate-x-*` drives the CSS `translate` property (not
		// `transform`), so measure the thumb's physical offset within the track
		// via bounding rects rather than parsing a transform matrix.
		const thumbRect = thumb.getBoundingClientRect();
		const thumbOffsetX = thumbRect.left - rect.left;
		const af = getComputedStyle(el, '::after');
		const insetL = parseFloat(af.left) || 0;
		const insetR = parseFloat(af.right) || 0;
		const insetT = parseFloat(af.top) || 0;
		const insetB = parseFloat(af.bottom) || 0;

		return {
			ariaChecked: el.getAttribute('aria-checked'),
			dataState: el.getAttribute('data-state'),
			dataSlot: el.getAttribute('data-slot'),
			trackBg: cs.backgroundColor,
			surfaceBg,
			thumbOffsetX,
			thumbTransitionMs,
			trackW: rect.width,
			trackH: rect.height,
			afterW: rect.width - insetL - insetR,
			afterH: rect.height - insetT - insetB,
		};
	});
}

test.describe('@visual Task 1 — switch redesign', () => {
	test.use({ viewport: { width: 1024, height: 600 } });

	test.skip(({ browserName }) => browserName !== 'chromium', 'single-browser visual proof');

	const results: Record<string, unknown> = {};

	test.afterAll(() => {
		fs.writeFileSync(
			repoEvidence('task-1-thumb-transition.json'),
			`${JSON.stringify({ generated: new Date().toISOString(), ...results }, null, 2)}\n`,
			'utf8',
		);
	});

	async function runTheme(
		page: Page,
		theme: 'dark' | 'light',
		shot: string,
	): Promise<{ off: SwitchMetrics; on: SwitchMetrics }> {
		await page.addInitScript(installAuthHarness, TOKEN);
		// First load establishes the origin so localStorage is writable; then
		// persist the theme and reload so mode-watcher applies it at init.
		await page.goto('/?mode=touch');
		await setTheme(page, theme);
		await page.reload();

		// Authed shell: <header> renders once the token-rewritten login lands.
		await expect(page.locator('header').first()).toBeVisible({ timeout: 20_000 });
		await expect
			.poll(() => page.evaluate((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme))
			.toBe(true);

		await navigateTo(page, 'network');

		const switches = page.getByRole('switch');
		await expect(switches.first()).toBeVisible({ timeout: 15_000 });

		// Pick the first ENABLED switch (a live BondToggle in the Cellular section).
		const count = await switches.count();
		let toggle = switches.first();
		for (let i = 0; i < count; i++) {
			if (await switches.nth(i).isEnabled()) {
				toggle = switches.nth(i);
				break;
			}
		}
		await toggle.scrollIntoViewIfNeeded();

		const before = await readSwitchMetrics(toggle);

		// Flip to the opposite state. A live Ethernet disable may raise a confirm
		// dialog; accept it so the toggle actually flips.
		await toggle.click();
		const confirm = page.getByRole('alertdialog').getByRole('button', { name: /confirm|disable|continue|yes/i });
		if (await confirm.isVisible().catch(() => false)) {
			await confirm.click();
		}
		const opposite = before.ariaChecked === 'true' ? 'false' : 'true';
		await expect(toggle).toHaveAttribute('aria-checked', opposite, { timeout: 10_000 });

		const after = await readSwitchMetrics(toggle);

		await page.screenshot({ path: repoEvidence(shot) });

		// Restore original state (best-effort) so themes don't interfere.
		await toggle.click().catch(() => undefined);
		const restoreConfirm = page
			.getByRole('alertdialog')
			.getByRole('button', { name: /confirm|disable|continue|yes/i });
		if (await restoreConfirm.isVisible().catch(() => false)) {
			await restoreConfirm.click().catch(() => undefined);
		}

		// Map measurements to OFF / ON states regardless of starting state.
		const off = before.ariaChecked === 'false' ? before : after;
		const on = before.ariaChecked === 'true' ? before : after;
		return { off, on };
	}

	test('@visual track visibility + thumb transition — dark', { tag: '@visual' }, async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'kiosk desktop layout');
		const { off, on } = await runTheme(page, 'dark', 'task-1-track-visibility-dark.png');
		results.dark = { off, on };

		// Scenario 1: OFF track must not dissolve into the card surface.
		expect(off.surfaceBg, 'surface behind switch should be resolvable').not.toBeNull();
		expect(off.trackBg).not.toBe(off.surfaceBg);
		// ON track stays the primary (lime) and differs from OFF.
		expect(on.trackBg).not.toBe(off.trackBg);
		expect(on.ariaChecked).toBe('true');

		// Scenario 2: thumb slides + animated transition + >=44px-wide hit area.
		expect(Math.abs(on.thumbOffsetX - off.thumbOffsetX)).toBeGreaterThan(5);
		expect(off.thumbTransitionMs).toBeGreaterThan(0);
		expect(off.afterW).toBeGreaterThanOrEqual(44);
		expect(off.afterH).toBeGreaterThan(off.trackH);
	});

	test('@visual track visibility + thumb transition — light', { tag: '@visual' }, async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'kiosk desktop layout');
		const { off, on } = await runTheme(page, 'light', 'task-1-track-visibility-light.png');
		results.light = { off, on };

		expect(off.surfaceBg, 'surface behind switch should be resolvable').not.toBeNull();
		expect(off.trackBg).not.toBe(off.surfaceBg);
		expect(on.trackBg).not.toBe(off.trackBg);
		expect(on.ariaChecked).toBe('true');

		expect(Math.abs(on.thumbOffsetX - off.thumbOffsetX)).toBeGreaterThan(5);
		expect(off.thumbTransitionMs).toBeGreaterThan(0);
		expect(off.afterW).toBeGreaterThanOrEqual(44);
		expect(off.afterH).toBeGreaterThan(off.trackH);
	});
});
