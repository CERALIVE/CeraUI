import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright harness for CeraUI frontend — AGENT QA ONLY.
 *
 * Intentionally NOT wired into CI hard-gates (CI = bun test + vitest + lint +
 * svelte-check). It exists so agents can drive the real UI in a browser, assert
 * visual/structural invariants, and drop evidence screenshots.
 *
 * PORT: this project's Vite dev server listens on 6173 (see vite.config.ts
 * `server.port`), and the Bun backend on 3002 proxies to it. The default below
 * matches that reality; override with E2E_PORT if you run Vite elsewhere.
 *
 * Evidence (screenshots, traces, failure artifacts) lands under the workspace
 * `.omo/evidence/` directory via an absolute path, stable regardless of cwd.
 */
const DEV_PORT = Number(process.env.E2E_PORT ?? 6173);
const DEV_URL = `http://localhost:${DEV_PORT}`;

export const EVIDENCE_DIR = path.resolve(import.meta.dirname, '../../../.omo/evidence');

export default defineConfig({
	testDir: 'tests/e2e',
	outputDir: EVIDENCE_DIR,
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: 0,
	reporter: [['list']],
	use: {
		baseURL: DEV_URL,
		screenshot: 'only-on-failure',
		trace: 'retain-on-failure',
		video: 'off',
	},
	projects: [
		{
			name: 'desktop',
			use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
		},
		{
			name: 'mobile',
			use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } },
		},
	],
	// Reuse an already-running dev stack (the typical agent-QA flow: a full
	// `pnpm dev` — Vite + backend — is already up). If nothing is on DEV_PORT,
	// Playwright starts the frontend dev server.
	webServer: {
		command: 'pnpm dev',
		port: DEV_PORT,
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
