import fs from 'node:fs';

import { expect, test } from './fixtures/index.js';
import { evidencePath } from './helpers/index.js';
import { NetworkPage } from './pages/network.js';

/**
 * Todo 47 — clipboard copy reports success but paste is empty (real fix).
 *
 * The device is served over plain HTTP by LAN IP, so `navigator.clipboard` is
 * absent and every copy button runs the `document.execCommand('copy')` fallback
 * in `lib/helpers/clipboard.ts`. Todo 41 (PR #162) added that fallback but it
 * copied via a hidden `<textarea>` + `textarea.focus()`/`select()`. All four
 * copy buttons live INSIDE a bits-ui/Radix dialog, whose focus trap synchronously
 * pulls focus back into the dialog the instant the transient textarea is focused —
 * so the textarea never owns a selection when `execCommand('copy')` runs. The
 * command still returns `true` (success toast shows), but the OS clipboard is
 * never written: paste is empty.
 *
 * This test drives the REAL Hotspot dialog (a real focus trap), forces the
 * plain-HTTP legacy path (writeText rejects; readText kept for verification),
 * clicks Copy, and reads the OS clipboard back. It is RED against the Todo-41
 * textarea+focus implementation (clipboard stays at the sentinel) and GREEN once
 * `legacyCopy` selects a detached node via Selection/Range without moving focus.
 *
 * Why the existing tests missed this:
 *  - `clipboard.test.ts` mocks `document.execCommand` (never a real copy) and
 *    never involves a focus trap.
 *  - `hotspot-credentials.spec.ts` runs on localhost (a secure context), so it
 *    exercises the `navigator.clipboard.writeText` path, never the fallback.
 *
 * Desktop/chromium only — clipboard read/write needs an explicit permission grant
 * and the evidence file is written once.
 */

const HOTSPOT_DIALOG = 'Configure Hotspot';
const TEST_SSID = 'CeraLive-LegacyCopy';
const TEST_PASSWORD = 'legacy-copy-9931';
// Written to the OS clipboard before the copy so a silently-failed copy (clipboard
// unchanged) is unambiguously distinguishable from a real hit.
const SENTINEL = '__cera_clipboard_precleared__';

test.describe('Clipboard legacy execCommand copy — focus-trap regression', () => {
	test('copy inside a focus-trapped dialog actually reaches the OS clipboard', async ({
		authedPage: page,
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'run once, on desktop');

		// Clipboard read/write must be explicitly granted to the context.
		await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

		// Pre-clear the OS clipboard to a sentinel using the real Clipboard API,
		// THEN force the plain-HTTP fallback: make writeText reject so
		// copyToClipboard() falls through to document.execCommand('copy'). readText
		// is left intact so we can read back what actually landed on the clipboard.
		await page.evaluate((sentinel) => navigator.clipboard.writeText(sentinel), SENTINEL);
		await page.evaluate(() => {
			navigator.clipboard.writeText = () =>
				Promise.reject(new Error('forced-legacy-path'));
		});

		const network = new NetworkPage(page);
		await network.open();
		await network.openHotspot();

		const dialog = page.getByRole('dialog', { name: HOTSPOT_DIALOG });
		await dialog.locator('#hotspot-name').fill(TEST_SSID);
		await dialog.locator('#hotspot-password').fill(TEST_PASSWORD);

		// Click Copy password — the button lives inside the dialog's focus trap.
		await dialog.getByRole('button', { name: 'Copy password' }).click();

		// The success toast shows regardless (execCommand returns true even when the
		// copy silently no-ops) — this is the exact "says success but paste empty"
		// symptom. The real assertion is the OS clipboard read-back below.
		await expect(page.getByText('Password copied')).toBeVisible();

		await expect
			.poll(() => page.evaluate(() => navigator.clipboard.readText()), {
				message:
					'legacy execCommand copy must place the password on the OS clipboard, not leave the sentinel',
			})
			.toBe(TEST_PASSWORD);

		const clipboardAfterPassword = await page.evaluate(() =>
			navigator.clipboard.readText(),
		);

		// Also cover the SSID copy button on the same dialog/trap.
		await dialog.getByRole('button', { name: 'Copy network name' }).click();
		await expect(page.getByText('Network name copied')).toBeVisible();
		await expect
			.poll(() => page.evaluate(() => navigator.clipboard.readText()), {
				message: 'legacy execCommand copy must place the SSID on the OS clipboard',
			})
			.toBe(TEST_SSID);
		const clipboardAfterName = await page.evaluate(() =>
			navigator.clipboard.readText(),
		);

		const pass =
			clipboardAfterPassword === TEST_PASSWORD && clipboardAfterName === TEST_SSID;

		fs.writeFileSync(
			evidencePath('todo-47-clipboard-legacy-copy.txt'),
			[
				'Todo 47 — clipboard execCommand fallback inside a focus trap',
				'',
				'Scenario: force the plain-HTTP legacy path (writeText rejects), open the',
				'Configure Hotspot dialog (a real bits-ui focus trap), click the copy',
				'buttons, then read the OS clipboard back via navigator.clipboard.readText.',
				`viewport: ${JSON.stringify(testInfo.project.use.viewport)}`,
				'',
				`  clipboard preclear sentinel = ${SENTINEL}`,
				`  typed password              = (${TEST_PASSWORD.length} chars)`,
				`  clipboard after copy pwd    = ${clipboardAfterPassword === TEST_PASSWORD ? 'MATCH' : `MISMATCH (${clipboardAfterPassword})`}`,
				`  typed SSID                  = ${TEST_SSID}`,
				`  clipboard after copy SSID   = ${clipboardAfterName} (expect: ${TEST_SSID})`,
				'',
				`RESULT: ${pass ? 'PASS' : 'FAIL'}`,
				`generated: ${new Date().toISOString()}`,
				'',
			].join('\n'),
			'utf8',
		);

		expect(pass).toBe(true);
	});
});
