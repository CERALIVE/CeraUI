/**
 * CeraUI E2E base fixtures.
 * See PLAYBOOK.md for the assertion decision tree and usage examples.
 *
 * This module re-exports everything from @playwright/test so specs can import
 * { test, expect } exclusively from here.
 */
import { test as base, type Page } from '@playwright/test';

import { ensureAuthenticated } from '../helpers/index.js';
import { BackendRpc } from './backend-rpc.js';
import { startWorkerBackend, type WorkerBackend } from './backend.js';
import { PageRpc } from './page-rpc.js';

export { expect } from '@playwright/test';
export type { Download, Locator, Page } from '@playwright/test';
export type { BackendRpc } from './backend-rpc.js';
export { PageRpc } from './page-rpc.js';

const CI_PREVIEW_ROUTING_COOKIE = 'ceraui_e2e_backend_port';

function ciPreviewOrigin(): string {
	return `http://localhost:${process.env.E2E_PORT ?? '6173'}`;
}

type WorkerFixtures = {
	backendScenario: string;
	workerBackend: WorkerBackend;
	backendRpc: BackendRpc;
};

type Fixtures = {
	authedPage: Page;
	pageRpc: PageRpc;
};

export const test = base.extend<Fixtures, WorkerFixtures>({
	// Per-worker MOCK_SCENARIO override. A spec opts in with
	// `test.use({ backendScenario: 'modem-pin-locked' })`; because it is a
	// worker-scoped option, Playwright allocates a SEPARATE worker for that value,
	// so the scenario is part of the worker key and parallel workers never share a
	// mismatched backend. Default keeps every existing spec on multi-modem-wifi.
	backendScenario: ['multi-modem-wifi', { scope: 'worker', option: true }],

	// One isolated mock backend per worker (own port + own CWD state dir), so
	// config.json mutation and dev.emit broadcasts never bleed across workers.
	workerBackend: [
		async ({ backendScenario }, use) => {
			const backend = await startWorkerBackend({ scenario: backendScenario });
			await use(backend);
			await backend.stop();
		},
		{ scope: 'worker' },
	],
	backendRpc: [
		async ({ workerBackend }, use) => {
			const rpc = await BackendRpc.connect(workerBackend.port, {
				proxySecret: workerBackend.proxySecret,
			});
			await use(rpc);
			rpc.close();
		},
		{ scope: 'worker' },
	],

	// Override page to (1) route this worker's browser to its own backend and
	// (2) add the screenshot guard in non-@visual tests.
	page: async ({ page, workerBackend }, use, testInfo) => {
		const usesCiPreviewRouting = process.env.CI === 'true';
		if (usesCiPreviewRouting) {
			await page.context().addCookies([
				{
					name: CI_PREVIEW_ROUTING_COOKIE,
					value: `${workerBackend.port}.${workerBackend.proxySecret}`,
					url: ciPreviewOrigin(),
					httpOnly: true,
					secure: false,
					sameSite: 'Strict',
				},
			]);
		} else {
			await page.addInitScript((port: number) => {
				(window as { __ceraSocketPort?: number }).__ceraSocketPort = port;
			}, workerBackend.port);
		}

		// Screenshots are permitted only in @visual (visual-regression baselines)
		// and @gallery (docs screenshot gallery) tests; every other test gets a
		// throwing stub. Mirror this allowlist in PLAYBOOK.md and build-check.yml.
		const screenshotAllowed =
			testInfo.tags.includes('@visual') ||
			testInfo.title.includes('@visual') ||
			testInfo.tags.includes('@gallery') ||
			testInfo.title.includes('@gallery');
		if (!screenshotAllowed) {
			// Mechanically forbid screenshots in functional tests.
			const originalScreenshot = page.screenshot.bind(page);
			// biome-ignore lint/suspicious/noExplicitAny: intentional override for guard
			(page as any).screenshot = async (
				..._args: Parameters<typeof originalScreenshot>
			) => {
				throw new Error(
					'Screenshots are forbidden in functional tests. Tag the test @visual (or @gallery for the docs gallery) or assert via ARIA/role/web-first assertions.',
				);
			};
		}
		try {
			await use(page);
		} finally {
			if (usesCiPreviewRouting) {
				await page.context().clearCookies({ name: CI_PREVIEW_ROUTING_COOKIE });
			}
		}
	},
	pageRpc: async ({ page }, use) => {
		const rpc = new PageRpc();
		await rpc.install(page);
		await use(rpc);
		rpc.close();
	},

	// authedPage: navigate to / and ensure the authenticated shell is visible.
	authedPage: async ({ page }, use) => {
		await page.goto('/');
		await ensureAuthenticated(page);
		await use(page);
	},
});

export const hardwareTest = test.extend({
	page: async ({ context }, use) => {
		const page = await context.newPage();
		Object.defineProperty(page, 'screenshot', {
			configurable: true,
			value: (): Promise<never> =>
				Promise.reject(
					new Error(
						'Screenshots are forbidden in functional hardware tests; capture required operator evidence separately.',
					),
				),
		});
		try {
			await use(page);
		} finally {
			await page.close();
		}
	},
});
