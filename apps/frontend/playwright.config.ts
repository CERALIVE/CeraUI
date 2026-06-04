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

const DEV_PORT = Number(process.env.E2E_PORT ?? 6173);
const DEV_URL = `http://localhost:${DEV_PORT}`;

export const EVIDENCE_DIR = path.resolve(import.meta.dirname, '../../../.omo/evidence');

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: EVIDENCE_DIR,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
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
      command: 'pnpm --filter backend run dev',
      port: 3002,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { MOCK_SCENARIO: 'multi-modem-wifi', NODE_ENV: 'development' },
    },
  ],
});
