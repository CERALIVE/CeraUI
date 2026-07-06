import { expect, test } from './fixtures/index.js';

import { ensureAuthenticated } from './helpers/index.js';
import { installModemCapture, readModem0Lock } from './helpers/modem-capture.js';

/**
 * Fixture self-test for the per-worker `backendScenario` override
 * (fixtures/backend.ts + fixtures/index.ts). Proves that
 * `test.use({ backendScenario: 'modem-pin-locked' })` actually boots THIS
 * worker's backend on that MOCK_SCENARIO — the seeded PIN-locked modem surfaces
 * as `sim_lock.required === 'sim-pin'` in the modems broadcast. This is the
 * prerequisite infrastructure Todo 16's PIN-unlock e2e walk depends on: WS-proxy
 * state injection cannot fake RPC-handler-owned SIM state, so the walk needs a
 * backend genuinely booted on the modem-pin-locked scenario.
 *
 * `backendScenario` is a WORKER-scoped option (fixtures/index.ts), so the
 * override MUST be set at file top level — Playwright forbids a worker-option
 * `test.use` inside a `describe` ("forces a new worker"). The matching negative
 * control (a default-scenario worker does NOT report a PIN lock) therefore lives
 * in its own file, `backend-scenario-default.spec.ts`, so it runs in a separate
 * worker keyed on the default scenario.
 */
test.use({ backendScenario: 'modem-pin-locked' });

test('override worker: modem 0 SIM PIN-locked (sim_lock.required === "sim-pin")', async ({
	page,
}) => {
	await page.addInitScript(installModemCapture);
	await page.goto('/');
	await ensureAuthenticated(page);

	await expect
		.poll(() => readModem0Lock(page), {
			timeout: 20_000,
			message:
				'modem 0 should report sim_lock.required === "sim-pin" under the modem-pin-locked override',
		})
		.toBe('sim-pin');
});
