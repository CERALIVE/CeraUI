import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { EVIDENCE_DIR, navigateTo } from './helpers/index.js';

/**
 * Task 13 — observable logs end-to-end (S8).
 *
 * Proves the getLog/getSyslog → `log` push → LogsDialog download path feeds the
 * UI with REAL data (the handler previously returned `{ log: "" }`, so no push
 * fired and nothing downloaded):
 *
 *   1. trigger a known backend failure — a command-injection-shaped
 *      `system.getLog` request the backend REJECTS and traces as `err`;
 *   2. open the Logs dialog and download the device (CeraLive) log;
 *   3. assert the downloaded file is non-empty, is the ceralive.service-scoped
 *      journal, and contains the just-triggered failure line — i.e. the failure
 *      is observable through the dialog;
 *   4. download the full system log and assert it too carries real content.
 *
 * Auth mirrors notifications-panel.spec.ts: a persistent token (read from the
 * backend's auth_tokens.json) is injected via addInitScript so the socket
 * authenticates without the device password.
 */

const TOKEN: string = (() => {
	const tokensPath = path.resolve(import.meta.dirname, '../../../backend/auth_tokens.json');
	const tokens = Object.keys(
		JSON.parse(fs.readFileSync(tokensPath, 'utf8')) as Record<string, true>,
	);
	if (tokens.length === 0) {
		throw new Error(`No persistent auth tokens in ${tokensPath}; cannot authenticate e2e socket.`);
	}
	return tokens[0];
})();

// A command-injection-shaped unit name the backend rejects (SERVICE_RE) and
// traces as `RPC system.getLog err` — our "known backend failure" marker.
const INJECTION_MARKER = 'task13-observable-logs;rm -rf /';

function installWsHarness(opts: { token: string }): void {
	const Native = window.WebSocket;
	class HookedWebSocket extends Native {
		send(data: string | Blob | BufferSource): void {
			if (typeof data === 'string') {
				try {
					const msg = JSON.parse(data);
					if (Array.isArray(msg.path) && msg.path.join('.') === 'auth.login') {
						msg.input = { token: opts.token, persistent_token: true };
						super.send(JSON.stringify(msg));
						return;
					}
				} catch {
					/* not an RPC frame (e.g. keepalive) */
				}
			}
			super.send(data);
		}
	}
	window.WebSocket = HookedWebSocket as typeof WebSocket;
	try {
		localStorage.setItem('auth', 'e2e-token-marker');
	} catch {
		/* localStorage unavailable */
	}
}

/** Fire a backend `system.getLog` request the backend rejects + traces as err. */
function triggerRejectedLogRequest(page: import('@playwright/test').Page, service: string) {
	return page.evaluate(async (svc) => {
		const mod = await import(/* @vite-ignore */ '/src/lib/rpc/client.ts');
		try {
			await (mod.rpc.system.getLog as (i: unknown) => Promise<unknown>)({ service: svc });
		} catch {
			/* expected: the backend rejects the malformed unit name */
		}
	}, service);
}

async function readDownload(download: import('@playwright/test').Download): Promise<string> {
	const file = await download.path();
	if (!file) throw new Error('download produced no file');
	return fs.readFileSync(file, 'utf8');
}

test.beforeEach(async ({ page, browserName }, testInfo) => {
	test.skip(browserName !== 'chromium', 'single-browser integration proof');
	test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the settings list');
	await page.addInitScript(installWsHarness, { token: TOKEN });
	await page.goto('/');
	await navigateTo(page, 'settings');
});

test('LogsDialog downloads a real, observable backend journal', async ({ page }) => {
	// 1. Trigger a known backend failure: the backend rejects this unit name and
	//    records `RPC system.getLog err` (+ the marker in its args) in the journal.
	await triggerRejectedLogRequest(page, INJECTION_MARKER);

	// 2. Open the Logs dialog from the Settings list.
	await page.getByRole('button', { name: 'System Logs' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'System Logs' });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId('log-row-device')).toBeVisible();

	// 3. Download the device (CeraLive) log and read it back.
	const deviceDownloadPromise = page.waitForEvent('download');
	await dialog.getByTestId('log-download-device').click();
	const deviceDownload = await deviceDownloadPromise;
	const deviceLog = await readDownload(deviceDownload);

	// The wired RPC returns the ceralive.service-scoped journal — NOT the former
	// empty `{ log: "" }` stub (which would have produced no download at all).
	expect(deviceDownload.suggestedFilename()).toBe('ceralive.service_log.txt');
	expect(deviceLog.length).toBeGreaterThan(0);
	expect(deviceLog).toContain('ceralive.service');
	expect(deviceLog).toContain('CeraUI mock journal');

	// The known backend failure we triggered is observable in the downloaded log.
	expect(deviceLog).toContain('system.getLog');
	expect(deviceLog).toContain('task13-observable-logs');

	// 4. Download the full system log and confirm it too carries real content.
	const systemDownloadPromise = page.waitForEvent('download');
	await dialog.getByTestId('log-download-system').click();
	const systemDownload = await systemDownloadPromise;
	const systemLog = await readDownload(systemDownload);
	expect(systemDownload.suggestedFilename()).toBe('ceralive_system_log.txt');
	expect(systemLog.length).toBeGreaterThan(0);

	fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-13-logs-dialog.png') });
	fs.writeFileSync(
		path.join(EVIDENCE_DIR, 'task-13-logs-dialog.txt'),
		[
			'Task 13 — observable logs E2E',
			'Driver: real frontend + real dev backend (mock multi-modem-wifi).',
			`Generated: ${new Date().toISOString()}`,
			'',
			`device log: ${deviceDownload.suggestedFilename()} (${deviceLog.length} bytes)`,
			`  contains "CeraUI mock journal": ${deviceLog.includes('CeraUI mock journal')}`,
			`  contains triggered failure "system.getLog": ${deviceLog.includes('system.getLog')}`,
			`system log: ${systemDownload.suggestedFilename()} (${systemLog.length} bytes)`,
			'',
		].join('\n'),
		'utf8',
	);
});
