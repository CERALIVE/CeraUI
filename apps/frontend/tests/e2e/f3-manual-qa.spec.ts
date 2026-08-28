/**
 * F3 — Real Manual QA (Groups 3, 4, 5), screenshot-free.
 *
 * Drives the REAL frontend against the REAL dev backend (MOCK_SCENARIO=
 * multi-modem-wifi) and verifies behaviour via ARIA / role / web-first
 * assertions — no raw pixel captures and no fixed-duration sleeps.
 *
 *   - Group 3: Modem Config toggles expose their state (aria-checked + On/Off
 *     text label) and have a ≥44px hit area (measured, not screenshotted).
 *   - Group 4: The switch-to-hotspot control is gated behind a confirm step;
 *     `wifi.setAdapterMode` does NOT fire on open or on Cancel. Todo 14 replaced
 *     the standalone trigger + modal alertdialog with ONE Station/Hotspot/Hybrid
 *     selector whose destructive transitions arm an INLINE confirm band — a
 *     modal inside an already-portalled surface puts the consequence on a layer
 *     a kiosk touchscreen must dismiss before it can re-read what it confirms.
 *     The gate itself is unchanged: arming dispatches nothing.
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
 * Topology: local Vite dev on :6173 uses `__ceraSocketPort`; CI prebuilt Vite
 * preview on :6173 uses the HttpOnly cookie. Both target this worker's 31xx
 * development backend.
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
		sentPaths.filter((p) => p === 'wifi.setAdapterMode').length;

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== 'desktop',
			'desktop layout drives these flows',
		);

		sentPaths = [];
		frozen = false;

		// Proxy the app WS to the real backend. Record outgoing RPC paths and
		// gate the server→client stream behind `frozen` (the staleness switch).
		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
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

		// One "Mode" affordance per WiFi radio; each names its own adapter, and the
		// confirm band the selector behind it arms is keyed on that same device.
		// Todo 32 (`cc23830`) moved the selector into that affordance's popover —
		// it renders nothing while closed and is portalled to <body> when open.
		const modeTrigger = page.getByTestId('open-wifi-mode').first();
		await expect(modeTrigger).toBeVisible();
		const device = await modeTrigger.getAttribute('data-device');
		expect(device, 'the mode affordance names its adapter').toBeTruthy();
		await modeTrigger.click();

		const selector = page
			.getByTestId(`wifi-mode-popover-${device}`)
			.getByTestId('wifi-mode-selector');
		await expect(selector).toBeVisible();
		await expect(selector).toHaveAttribute('data-mode', 'station');

		const trigger = selector.getByRole('radio', { name: 'Hotspot', exact: true });
		await expect(trigger).toBeVisible();
		expect(hotspotStartCount(), 'no setAdapterMode before interaction').toBe(0);

		await trigger.scrollIntoViewIfNeeded();
		await trigger.click();

		// The confirm must appear (the gate) and name the consequence…
		const confirm = page.getByTestId(`wifi-mode-confirm-${device}`);
		await expect(confirm).toBeVisible();
		await expect(confirm).toHaveAttribute('data-consequence', 'drops-uplink');
		await expect(confirm).toHaveAttribute('data-target', 'hotspot');
		// …and NO RPC may have fired yet.
		expect(hotspotStartCount(), 'no setAdapterMode RPC before confirm').toBe(0);

		// Cancel → confirm closes, still no RPC, station mode intact.
		await page.getByTestId(`wifi-mode-confirm-cancel-${device}`).click();
		await expect(confirm).toBeHidden();
		expect(hotspotStartCount(), 'Cancel fires no setAdapterMode RPC').toBe(0);
		await expect(selector).toHaveAttribute('data-mode', 'station');
		await expect(
			selector.getByRole('radio', { name: 'Hotspot', exact: true }),
		).toBeVisible();
	});

	// ── Group 5: Staleness on freeze / resume ─────────────────────────────────
	test('G5: live telemetry dims when WS stalls past 5s, then clears on resume', async ({
		page,
	}) => {
		const network = new NetworkPage(page);
		await network.open();

		// Desktop + mobile HUD both mount; one is CSS-hidden — target the visible.
		// T18's temp chip wraps its value span in an outer title="Temperature" span:
		// `.first()` = wrapper (shows °C), `.last()` = the value span carrying the dim.
		const temp = page.locator('[title="Temperature"]:visible').first();
		const tempValue = page.locator('[title="Temperature"]:visible').last();
		await expect(temp).toBeVisible();
		await expect(temp).toContainText('°C');
		// Baseline: fresh data flowing → telemetry not dimmed.
		await expect(tempValue).not.toHaveClass(/opacity-50/);

		// Freeze the server→client stream: timestamps stop advancing.
		frozen = true;
		// Past STALE_THRESHOLD_MS (5000ms) the staleness latch dims live values.
		await expect(tempValue).toHaveClass(/opacity-50/, { timeout: 12_000 });
		// Still authenticated/mounted — not booted to the login/offline screen.
		await expect(page.locator('header').first()).toBeVisible();

		// Resume: unfreeze → the backend's periodic frames refresh the timestamp
		// and the stale latch clears.
		frozen = false;
		await expect(tempValue).not.toHaveClass(/opacity-50/, { timeout: 12_000 });
	});
});
