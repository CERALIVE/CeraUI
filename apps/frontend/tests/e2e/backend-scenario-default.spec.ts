import { expect, test } from './fixtures/index.js';

import { ensureAuthenticated } from './helpers/index.js';
import { installModemCapture, modem0Present, readModem0Lock } from './helpers/modem-capture.js';

/**
 * Negative control for the per-worker `backendScenario` override
 * (see `backend-scenario-fixture.spec.ts`). This file sets NO override, so its
 * worker boots on the DEFAULT scenario (`multi-modem-wifi`) — the same scenario
 * every other spec uses. It proves the modem-pin-locked seeding is opt-in and
 * does NOT leak into a default-scenario worker: modem 0 never reports a PIN lock.
 *
 * Split from the positive proof because `backendScenario` is a worker-scoped
 * option whose `test.use` override must be set at file top level; a single file
 * cannot host two different worker scenarios.
 */

test('default worker: modem 0 does NOT report a PIN lock', async ({ page }) => {
	await page.addInitScript(installModemCapture);
	await page.goto('/');
	await ensureAuthenticated(page);

	// Wait until the modems snapshot has arrived so the absence of a PIN lock is a
	// real negative, not a not-yet-delivered read.
	await expect
		.poll(() => modem0Present(page), {
			timeout: 20_000,
			message: 'modems snapshot should include modem 0',
		})
		.toBe(true);

	expect(await readModem0Lock(page)).not.toBe('sim-pin');
});
