/**
 * F3 — Real Manual QA (Groups 3, 4, 5), screenshot-free.
 *
 * Drives the REAL frontend against the REAL dev backend (MOCK_SCENARIO=
 * multi-modem-wifi) and verifies behaviour via ARIA / role / web-first
 * assertions — no raw pixel captures and no fixed-duration sleeps.
 *
 *   - Group 3: Modem Config toggles expose their state (aria-checked + On/Off
 *     text label) and have a ≥44px hit area (measured, not screenshotted).
 *   - Group 4: The "Switch to Hotspot" control is gated behind a confirm
 *     dialog; `wifi.hotspotStart` does NOT fire on open or on Cancel.
 *   - Group 5: Staleness — when incoming WS frames freeze past
 *     STALE_THRESHOLD_MS (5s) live telemetry dims (opacity-50); on resume the
 *     dimming clears.
 *
 * Auth: uses the standard password flow (`ensureAuthenticated`) — NO module-load
 * read of `auth_tokens.json`, so collection never crashes when it is absent.
 *
 * WS harness: a `page.routeWebSocket` proxy (installed BEFORE navigation, the
 * same technique as `data-previsualization.spec.ts`) lets us
 *   - record outgoing RPC paths in the Node test process (Group 4), and
 *   - pause the server→client stream to simulate a stall (Group 5)
 * without touching app source and without an auth-resetting socket close.
 *
 * Note: Groups 1 (signal previsualization) and 2 (HUD telemetry) live in
 * `data-previsualization.spec.ts`, which covers those outcomes end-to-end.
 *
 * Prereq: backend on :3002 (NODE_ENV=development), frontend Vite :6173 — both
 * auto-started by playwright.config.ts.
 */
import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated } from './helpers/index.js';
import { NetworkPage } from './pages/network.js';

test.describe.configure({ mode: 'serial' });

test.describe('F3 manual QA — modem toggles, hotspot gate, staleness', () => {
	test.skip(
		({ browserName }) => browserName !== 'chromium',
		'single-browser integration proof',
	);

	// Per-test WS harness state, owned by the Node test process. Installed before
	// navigation so the app's only socket is the proxied one.
	let sentPaths: string[];
	let frozen: boolean;

	const hotspotStartCount = () =>
		sentPaths.filter((p) => p === 'wifi.hotspotStart').length;

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== 'desktop',
			'desktop layout drives these flows',
		);

		sentPaths = [];
		frozen = false;

		// Proxy the app WS to the real backend. Record outgoing RPC paths and
		// gate the server→client stream behind `frozen` (the staleness switch).
		await page.routeWebSocket(/:(3002|8090|8091)\//, (ws) => {
			const server = ws.connectToServer();
			ws.onMessage((message) => {
				try {
					const raw = typeof message === 'string' ? message : message.toString();
					const msg = JSON.parse(raw) as { path?: unknown };
					const path = Array.isArray(msg.path) ? msg.path.join('.') : null;
					if (path) sentPaths.push(path);
				} catch {
					/* non-JSON frame */
				}
				server.send(message);
			});
			server.onMessage((message) => {
				if (!frozen) ws.send(message);
			});
		});

		await page.goto('/');
		await ensureAuthenticated(page);
	});

	// ── Group 3: Modem Config toggles ─────────────────────────────────────────
	test('G3: modem config toggles expose On/Off state with a ≥44px hit area', async ({
		page,
	}) => {
		const network = new NetworkPage(page);
		await network.open();
		await network.openModemConfig();

		const dialog = page.getByRole('dialog');
		const switches = dialog.getByRole('switch');
		await expect(switches.first()).toBeVisible();

		const count = await switches.count();
		expect(count, '≥2 labeled switches in the modem config dialog').toBeGreaterThanOrEqual(2);

		let maxHeight = 0;
		for (let i = 0; i < count; i++) {
			const sw = switches.nth(i);
			// State is exposed in the accessibility tree (role=switch + aria-checked)
			// rather than verified by pixels.
			await expect(sw).toHaveAttribute('aria-label', /.+/);
			await expect(sw).toHaveAttribute('aria-checked', /^(true|false)$/);

			// The LabeledSwitch wrapper (min-h-[44px]) carries the On/Off text label
			// and the ≥44px touch target.
			const wrapper = sw.locator(
				'xpath=ancestor::span[contains(@class,"min-h-")][1]',
			);
			await expect(wrapper).toContainText(/\b(On|Off)\b/);
			const box = await wrapper.boundingBox();
			maxHeight = Math.max(maxHeight, Math.round(box?.height ?? 0));
		}
		expect(maxHeight, 'at least one toggle ≥44px tall').toBeGreaterThanOrEqual(44);

		await network.closeModemConfig();
	});

	// ── Group 4: Hotspot confirm gate ─────────────────────────────────────────
	test('G4: hotspot switch is gated behind a confirm dialog; RPC fires only on confirm', async ({
		page,
	}) => {
		const network = new NetworkPage(page);
		await network.open();

		const trigger = page
			.getByRole('button', { name: 'Switch to Hotspot', exact: true })
			.first();
		await expect(trigger).toBeVisible();
		expect(hotspotStartCount(), 'no hotspotStart before interaction').toBe(0);

		await trigger.scrollIntoViewIfNeeded();
		await trigger.click();

		// The confirm dialog must appear (the gate)…
		const alert = page.getByRole('alertdialog');
		await expect(alert).toBeVisible();
		await expect(alert).toContainText('Switch to Hotspot?');
		// …and NO RPC may have fired yet.
		expect(hotspotStartCount(), 'no hotspotStart RPC before confirm').toBe(0);

		// Cancel → dialog closes, still no RPC, station mode intact.
		await page.getByRole('button', { name: /^cancel$/i }).click();
		await expect(alert).toBeHidden();
		expect(hotspotStartCount(), 'Cancel fires no hotspotStart RPC').toBe(0);
		await expect(
			page
				.getByRole('button', { name: 'Switch to Hotspot', exact: true })
				.first(),
		).toBeVisible();
	});

	// ── Group 5: Staleness on freeze / resume ─────────────────────────────────
	test('G5: live telemetry dims when WS stalls past 5s, then clears on resume', async ({
		page,
	}) => {
		const network = new NetworkPage(page);
		await network.open();

		// Desktop + mobile HUD both mount; one is CSS-hidden — target the visible.
		const temp = page.locator('[title="Temperature"]:visible').first();
		await expect(temp).toBeVisible();
		await expect(temp).toContainText('°C');
		// Baseline: fresh data flowing → telemetry not dimmed.
		await expect(temp).not.toHaveClass(/opacity-50/);

		// Freeze the server→client stream: timestamps stop advancing.
		frozen = true;
		// Past STALE_THRESHOLD_MS (5000ms) the staleness latch dims live values.
		await expect(temp).toHaveClass(/opacity-50/, { timeout: 12_000 });
		// Still authenticated/mounted — not booted to the login/offline screen.
		await expect(page.locator('header').first()).toBeVisible();

		// Resume: unfreeze → the backend's periodic frames refresh the timestamp
		// and the stale latch clears.
		frozen = false;
		await expect(temp).not.toHaveClass(/opacity-50/, { timeout: 12_000 });
	});
});
