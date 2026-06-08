/**
 * Relay endpoint validation — multi-stage result + Save gating (Task 14).
 *
 * Drives the real dev backend (MOCK_SCENARIO=multi-modem-wifi) through the
 * manual custom-relay path of ServerDialog:
 *
 *   1. Reachable endpoint → the Validate button goes in-flight (disabled, with a
 *      spinner), the multi-stage chip row shows progress, the stages reach the
 *      terminal "ok" (data-status="done"), and Save becomes enabled.
 *   2. Unresolvable host → validation fails at the `dns` stage: that chip is
 *      marked failed, the inline alert names the stage, and Save stays disabled.
 *
 * A loopback UDP echo answers the backend's post-connection reachability probe.
 * It replies on a short delay so the in-flight (validating) state is observable
 * via web-first auto-retry — no fixed sleeps (PLAYBOOK.md). Evidence is written
 * to .omo/evidence per the task contract.
 */
import { createSocket } from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from './fixtures/index.js';
import { evidencePath, navigateTo } from './helpers/index.js';

test.beforeEach(({ browserName }, testInfo) => {
	test.skip(browserName !== 'chromium', 'single-browser integration proof');
	test.skip(testInfo.project.name !== 'desktop', 'desktop layout drives the relay dialog');
});

async function openServerDialog(page: import('@playwright/test').Page) {
	await navigateTo(page, 'live');
	const byTestId = page.getByTestId('open-server-dialog');
	if ((await byTestId.count()) > 0) {
		await byTestId.click();
	} else {
		await page.getByRole('button', { name: 'Edit Settings' }).first().click();
	}
	const dialog = page.getByRole('dialog', { name: 'Receiver Server' });
	await expect(dialog).toBeVisible();
	return dialog;
}

function writeEvidence(fileName: string, lines: string[]): void {
	const file = evidencePath(fileName);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

test.describe('Relay endpoint validation', () => {
	test('reachable endpoint → spinner → stages reach ok → Save enabled', async ({
		authedPage: page,
	}) => {
		// Loopback UDP echo answers the backend `probe` stage. The reply is
		// delayed so the in-flight (validating) state is reliably observable.
		const echo = createSocket('udp4');
		const port = await new Promise<number>((resolve) => {
			echo.on('message', (msg, rinfo) => {
				setTimeout(() => echo.send(msg, rinfo.port, rinfo.address), 600);
			});
			echo.bind(0, '127.0.0.1', () => resolve(echo.address().port));
		});

		try {
			const dialog = await openServerDialog(page);

			await dialog.locator('#srtla-addr').fill('127.0.0.1');
			await dialog.locator('#srtla-port').fill(String(port));
			await dialog.locator('#srt-streamid').fill('e2e-stream');

			const validateBtn = dialog.locator('#relay-validate');
			const stages = dialog.getByTestId('validate-stages');
			const okChip = stages.locator('[data-stage="ok"]');

			await validateBtn.click();

			// In-flight: the button is disabled and the stage row shows active
			// (spinner) chips while the probe is outstanding.
			await expect(validateBtn).toBeDisabled();
			await expect(stages).toBeVisible();
			await expect(stages.locator('[data-status="active"]').first()).toBeVisible();

			// Resolution: every stage reaches done, including the terminal ok.
			await expect(okChip).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
			await expect(dialog.getByText('Endpoint reachable')).toBeVisible();

			// A passing validation re-enables Validate and enables Save.
			await expect(validateBtn).toBeEnabled();
			const saveBtn = dialog.getByRole('button', { name: 'Save' });
			await expect(saveBtn).toBeEnabled();

			const snapshot = await stages.ariaSnapshot();
			writeEvidence('task-14-validate-ok.txt', [
				'Task 14 — Relay endpoint validation: REACHABLE endpoint',
				'',
				`probe target: 127.0.0.1:${port} (loopback UDP echo, 600ms reply delay)`,
				'',
				'In-flight observed: Validate button disabled + stage row active (spinner).',
				'Stages reached terminal "ok" with data-status="done".',
				'Inline status: "Endpoint reachable".',
				`Save button enabled: ${await saveBtn.isEnabled()}`,
				`ok chip data-status: ${await okChip.getAttribute('data-status')}`,
				'',
				'Stage row ARIA snapshot:',
				snapshot,
			]);
		} finally {
			echo.close();
		}
	});

	test('unresolvable host → failing stage shown → Save stays disabled', async ({
		authedPage: page,
	}) => {
		const dialog = await openServerDialog(page);

		// `.invalid` is RFC-2606 reserved: it never resolves, so DNS is the first
		// failing stage (input/protocol/endpoint all pass).
		await dialog.locator('#srtla-addr').fill('nonexistent.invalid');
		await dialog.locator('#srtla-port').fill('5000');

		const stages = dialog.getByTestId('validate-stages');
		const dnsChip = stages.locator('[data-stage="dns"]');
		const okChip = stages.locator('[data-stage="ok"]');

		await dialog.locator('#relay-validate').click();

		// The dns chip is marked failed; the terminal ok stays pending.
		await expect(dnsChip).toHaveAttribute('data-status', 'failed', { timeout: 15_000 });
		await expect(okChip).toHaveAttribute('data-status', 'pending');

		const failure = dialog.getByRole('alert');
		await expect(failure).toContainText('Validation failed');
		await expect(failure).toContainText('dns');

		// A failed validation blocks Save until the endpoint is corrected.
		const saveBtn = dialog.getByRole('button', { name: 'Save' });
		await expect(saveBtn).toBeDisabled();

		const snapshot = await stages.ariaSnapshot();
		writeEvidence('task-14-validate-fail.txt', [
			'Task 14 — Relay endpoint validation: UNRESOLVABLE host',
			'',
			'probe target: nonexistent.invalid:5000 (RFC-2606 reserved, never resolves)',
			'',
			'Failing stage: dns (data-status="failed").',
			`ok chip data-status: ${await okChip.getAttribute('data-status')}`,
			`Inline alert: ${(await failure.textContent())?.trim()}`,
			`Save button disabled: ${!(await saveBtn.isEnabled())}`,
			'',
			'Stage row ARIA snapshot:',
			snapshot,
		]);
	});
});
