import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

import { expect, test } from './fixtures/index.js';
import { navigateTo } from './helpers/index.js';

test.describe('System Logs browser downloads', { tag: '@desktop-only' }, () => {
	test('saves the filtered export as text', async ({ authedPage: page, backendRpc }, testInfo) => {
		const marker = 'browser-export;invalid-service';
		const excluded = 'browser-excluded;invalid-service';
		for (const service of [marker, excluded]) {
			await expect(backendRpc.call(['system', 'getLog'], { service })).rejects.toThrow('Input validation failed');
		}
		await navigateTo(page, 'settings');
		await page.getByTestId('settings-entry-logs').click();
		const logs = page.getByRole('dialog', { name: 'System Logs' });
		await logs.getByRole('tab', { name: 'Raw logs' }).click();
		await logs.getByRole('radio', { name: 'Everything', exact: true }).click();
		await logs.getByTestId('raw-search').fill(marker);
		await logs.getByTestId('raw-search').press('Enter');
		await expect(logs.getByTestId('raw-row').filter({ hasText: marker }).first()).toBeVisible();
		await logs.getByTestId('sharing-open-export').click();

		const [download] = await Promise.all([
			page.waitForEvent('download'),
			page.getByRole('button', { name: 'Download export' }).click(),
		]);
		const file = testInfo.outputPath('export.txt');
		await download.saveAs(file);

		const text = await readFile(file, 'utf8');
		expect(text.slice(0, 15).toLowerCase()).not.toBe('<!doctype html>');
		expect(text.split('\n').some((line) => !line.startsWith('#') && line.includes(marker))).toBe(true);
		expect(text).not.toContain(excluded);
		expect(download.suggestedFilename()).toMatch(/\.txt$/);
	});

	test('saves the support bundle as complete gzip NDJSON', async ({ authedPage: page }, testInfo) => {
		await navigateTo(page, 'settings');
		await page.getByTestId('settings-entry-logs').click();
		await page.getByTestId('sharing-open-bundle').click();

		const [download] = await Promise.all([
			page.waitForEvent('download'),
			page.getByRole('button', { name: 'Download bundle' }).click(),
		]);
		const file = testInfo.outputPath('support-bundle.ndjson.gz');
		await download.saveAs(file);

		const bytes = await readFile(file);
		expect([...bytes.subarray(0, 2)], 'gzip signature').toEqual([0x1f, 0x8b]);
		const records: unknown[] = gunzipSync(bytes).toString('utf8').trimEnd().split('\n').map(
			(line) => JSON.parse(line),
		);
		expect(records).toContainEqual(expect.objectContaining({ section: 'versions' }));
		expect(records.at(-1)).toEqual({ section: 'end', complete: true });
		expect(download.suggestedFilename()).toMatch(/\.ndjson\.gz$/);
	});
});
