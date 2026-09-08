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
	backendHost: { start(): Promise<WorkerBackend> };
};

type Fixtures = {
	workerBackend: WorkerBackend;
	backendRpc: BackendRpc;
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

	// Keep the process until the next test acquires a backend: auth.spec.ts has
	// an explicit serial flow that retains its own page without requesting fixtures.
	backendHost: [
		async ({ backendScenario }, use) => {
			let backend: WorkerBackend | undefined;
			try {
				await use({
					async start() {
						await backend?.stop();
						backend = await startWorkerBackend({ scenario: backendScenario });
						return backend;
					},
				});
			} finally {
				await backend?.stop();
			}
		},
		{ scope: 'worker' },
	],
	// Test-scoped acquisition resets process globals, timers AND CWD state through
	// the existing stop/seed/start path before either a page or an RPC client uses it.
	workerBackend: async ({ backendHost }, use) => {
		await use(await backendHost.start());
	},
	backendRpc: async ({ workerBackend }, use) => {
		const rpc = await BackendRpc.connect(workerBackend.port, {
			proxySecret: workerBackend.proxySecret,
		});
		try {
			await use(rpc);
		} finally {
			rpc.close();
		}
	},

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
