import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { defineConfig, devices } from '@playwright/test';

// Ensure auth_tokens.json exists before test discovery
const tokensPath = path.resolve(import.meta.dirname, '../backend/auth_tokens.json');
if (!fs.existsSync(tokensPath)) {
	try {
		// Try to restore the committed seed from git
		execSync('git checkout -- apps/backend/auth_tokens.json', {
			cwd: path.resolve(import.meta.dirname, '../../'),
			stdio: 'pipe',
		});
	} catch {
		// Not committed — create a minimal valid placeholder so field-lock can load
		fs.writeFileSync(tokensPath, JSON.stringify({ placeholder: true }), 'utf8');
	}
}

// Seed a server before the backend boots so the Live view leaves its empty state
// and renders the controls specs drive. Must be srtla_addr (manual), not
// relay_server, or ServerDialog defaults to Relay and breaks its method test.
// Overwrite in CI: the backend unit-test step runs first and leaves a server-less
// config.json, so a plain "if absent" would skip and the Live view stays empty.
// Locally, only seed when absent so a dev's real config.json survives.
const configPath = path.resolve(import.meta.dirname, '../backend/config.json');
if (process.env.CI || !fs.existsSync(configPath)) {
	fs.writeFileSync(
		configPath,
		JSON.stringify({
			srtla_addr: '127.0.0.1',
			srtla_port: 5000,
			srt_streamid: 'e2e',
			max_br: 5000,
		}),
		'utf8',
	);
}

const DEV_PORT = Number(process.env.E2E_PORT ?? 6173);
const DEV_URL = `http://localhost:${DEV_PORT}`;

export const EVIDENCE_DIR = path.resolve(import.meta.dirname, '../../../.omo/evidence');

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: EVIDENCE_DIR,
  // Specs read auth_tokens.json at module-load time, so beforeEach is too late;
  // globalSetup runs after webServer and before spec collection. See that file.
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Every worker shares ONE single-threaded mock backend; over-parallelism lets a
  // dev.emit-heavy spec starve the relay-catalog push to a concurrent relay page.
  // Pin CI to 2 workers (GitHub's default core count) so beefier runners don't
  // swamp the backend, and retry any residual contention rather than mask a bug.
  workers: process.env.CI ? 2 : undefined,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['line']] : [['list']],
  expect: {
    toHaveScreenshot: { maxDiffPixels: 100 },
  },
  use: {
    baseURL: DEV_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: [
    {
      command: 'pnpm --filter frontend run dev',
      port: DEV_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // No --watch: tests write config.json/auth_tokens.json, which would
      // otherwise restart the backend mid-run and drop live WS connections.
      command: 'pnpm --filter backend run dev:e2e',
      port: 3002,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { MOCK_SCENARIO: 'multi-modem-wifi', NODE_ENV: 'development' },
    },
  ],
});
