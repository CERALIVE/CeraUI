import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';
import { clearInputPickerHardwareArtifacts } from './tests/e2e/helpers/input-picker-hardware-preflight.js';

clearInputPickerHardwareArtifacts();

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

// Spec modules read the raw token during discovery, BEFORE globalSetup. Seed its
// value here; globalSetup admits the digest only after the real password flow.
// The sidecar cannot share auth_tokens.json, which stores digests alone.
const e2eTokenPath = path.resolve(import.meta.dirname, '../backend/.e2e-auth-token');
if (
	process.env.CI !== 'true' &&
	(!fs.existsSync(e2eTokenPath) || fs.readFileSync(e2eTokenPath, 'utf8').trim() === 'PLACEHOLDER_NO_TOKEN_YET')
) {
	fs.writeFileSync(e2eTokenPath, randomBytes(32).toString('base64'), { mode: 0o600 });
}

// Seed a server before the backend boots so the Live view leaves its empty state
// and renders the controls specs drive. Must be srtla_addr (manual), not
// relay_server, or ServerDialog defaults to Relay and breaks its method test.
// Overwrite in CI: the backend unit-test step runs first and leaves a server-less
// config.json, so a plain "if absent" would skip and the Live view stays empty.
// Locally, only seed when absent so a dev's real config.json survives.
const configPath = path.resolve(import.meta.dirname, '../backend/config.json');
if (process.env.CI || !fs.existsSync(configPath)) {
	const pendingConfigPath = `${configPath}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(
			pendingConfigPath,
			JSON.stringify({
				srtla_addr: '127.0.0.1',
				srtla_port: 5000,
				srt_streamid: 'e2e',
				max_br: 5000,
				remote_key: 'mock-pairing-key',
				remote_provider: 'ceralive',
			}),
			'utf8',
		);
		// Other workers may copy the seed while their own config module is loading.
		fs.renameSync(pendingConfigPath, configPath);
	} finally {
		fs.rmSync(pendingConfigPath, { force: true });
	}
}

const DEV_PORT = Number(process.env.E2E_PORT ?? 6173);
const DEV_URL = `http://localhost:${DEV_PORT}`;
const REFERENCE_BACKEND_PORT = 3003;

// Repo-local test-artifact dir. Playwright traces/screenshots AND human-readable
// evidence files land here; gitignored. Never write outside the repo — tests must
// not depend on the orchestration workspace that may sit above this checkout.
export const EVIDENCE_DIR = path.resolve(import.meta.dirname, 'test-results');
const ciManagesServers = Boolean(process.env.CI);

// @dev-only tests open views only the Vite dev build has: import.meta.env.DEV
// compiles the Identity and Dev Tools destinations out of production. CI serves
// the built preview on DEV_PORT, so they get a dev server of their own beside it;
// locally DEV_PORT already is the dev server.
const DEV_ONLY_PORT = ciManagesServers ? DEV_PORT + 1 : DEV_PORT;
const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } };
const mobile = { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } };

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: EVIDENCE_DIR,
  // Specs read auth_tokens.json at module-load time, so beforeEach is too late;
  // globalSetup runs after webServer and before spec collection. See that file.
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Local Vite transforms lazily while each test boots a fresh backend. Four
  // local workers timed out during cold mounts; the unchanged full suite passed
  // at one worker. CI serves the prebuilt bundle and retains its four-worker lanes.
  workers: process.env.CI ? 4 : 1,
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
  // A test that proves one layout only is tagged @desktop-only or @mobile-only;
  // the other project leaves it out instead of skipping it at run time. A test
  // tagged @dev-only runs only in the -dev projects, on the Vite dev server.
  projects: [
    { name: 'desktop', grepInvert: /@mobile-only|@dev-only/, use: desktop },
    { name: 'mobile', grepInvert: /@desktop-only|@dev-only/, use: mobile },
    {
      name: 'desktop-dev',
      grep: /@dev-only/,
      grepInvert: /@mobile-only/,
      use: { ...desktop, baseURL: `http://localhost:${DEV_ONLY_PORT}` },
    },
    {
      name: 'mobile-dev',
      grep: /@dev-only/,
      grepInvert: /@desktop-only/,
      use: { ...mobile, baseURL: `http://localhost:${DEV_ONLY_PORT}` },
    },
  ],
  webServer: ciManagesServers
    ? [
        {
          // The CI lane starts the preview and the backend itself.
          command: `bun run --filter frontend dev -- --port ${DEV_ONLY_PORT} --strictPort`,
          port: DEV_ONLY_PORT,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      ]
    : [
        {
          command: 'bun run --filter frontend dev',
          port: DEV_PORT,
          reuseExistingServer: false,
          timeout: 120_000,
          env: { VITE_SOCKET_PORT: String(REFERENCE_BACKEND_PORT) },
        },
        {
          // Reference backend for local global setup, not functional test pages;
          // those select worker-scoped 31xx backends in the page fixture. No
          // --watch because global setup mutates config.json/auth_tokens.json.
          command: 'bun run --filter backend dev:e2e',
          port: REFERENCE_BACKEND_PORT,
          reuseExistingServer: false,
          timeout: 120_000,
          env: { MOCK_SCENARIO: 'multi-modem-wifi', NODE_ENV: 'development', PORT: String(REFERENCE_BACKEND_PORT) },
        },
      ],
});
