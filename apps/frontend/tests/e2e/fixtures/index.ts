/**
 * CeraUI E2E base fixtures.
 * See PLAYBOOK.md for the assertion decision tree and usage examples.
 *
 * This module re-exports everything from @playwright/test so specs can import
 * { test, expect } exclusively from here.
 */
import { test as base, type Page } from '@playwright/test';

import { ensureAuthenticated } from '../helpers/index.js';
import { startWorkerBackend, type WorkerBackend } from './backend.js';

export { expect } from '@playwright/test';
export type { Download, Locator, Page } from '@playwright/test';

type WorkerFixtures = {
	workerBackend: WorkerBackend;
};

type Fixtures = {
	authedPage: Page;
};

export const test = base.extend<Fixtures, WorkerFixtures>({
	// One isolated mock backend per worker (own port + own CWD state dir), so
	// config.json mutation and dev.emit broadcasts never bleed across workers.
	workerBackend: [
		async ({}, use) => {
			const backend = await startWorkerBackend();
			await use(backend);
			await backend.stop();
		},
		{ scope: 'worker' },
	],

	// Override page to (1) route this worker's browser to its own backend and
	// (2) add the screenshot guard in non-@visual tests.
	page: async ({ page, workerBackend }, use, testInfo) => {
		// Inject BEFORE app boot so getSocketUrl() dials the worker's backend; any
		// spec WS harness (addInitScript) registers after this and wraps that URL.
		await page.addInitScript((port: number) => {
			(window as { __ceraSocketPort?: number }).__ceraSocketPort = port;
		}, workerBackend.port);

		const isVisual =
			testInfo.tags.includes('@visual') || testInfo.title.includes('@visual');
		if (!isVisual) {
			// Mechanically forbid screenshots in functional tests.
			const originalScreenshot = page.screenshot.bind(page);
			// biome-ignore lint/suspicious/noExplicitAny: intentional override for guard
			(page as any).screenshot = async (
				..._args: Parameters<typeof originalScreenshot>
			) => {
				throw new Error(
					'Screenshots are forbidden in functional tests. Tag the test @visual or assert via ARIA/role/web-first assertions.',
				);
			};
		}
		await use(page);
	},

	// authedPage: navigate to / and ensure the authenticated shell is visible.
	authedPage: async ({ page }, use) => {
		await page.goto('/');
		await ensureAuthenticated(page);
		await use(page);
	},
});
