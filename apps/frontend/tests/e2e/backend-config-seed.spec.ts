import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from './fixtures/index.js';

test('configuration bootstrap keeps the shared seed complete during publication', ({}, testInfo) => {
	const frontend = path.resolve(import.meta.dirname, '../..');
	const sandboxFrontend = testInfo.outputPath('bootstrap', 'apps', 'frontend');
	const sandboxBackend = testInfo.outputPath('bootstrap', 'apps', 'backend');
	fs.mkdirSync(path.join(sandboxFrontend, 'tests/e2e/helpers'), { recursive: true });
	fs.mkdirSync(sandboxBackend, { recursive: true });
	for (const file of [
		'playwright.config.ts',
		'tests/e2e/helpers/input-picker-hardware-preflight.ts',
		'tests/e2e/helpers/input-picker-hardware-config.ts',
		'tests/e2e/helpers/index.ts',
	]) {
		fs.copyFileSync(path.join(frontend, file), path.join(sandboxFrontend, file));
	}
	fs.symlinkSync(path.join(frontend, 'node_modules'), path.join(sandboxFrontend, 'node_modules'), 'dir');
	const configPath = path.join(sandboxBackend, 'config.json');
	const configModule = path.join(sandboxFrontend, 'playwright.config.ts');
	fs.writeFileSync(configPath, JSON.stringify({ existing: 'local configuration' }));
	fs.writeFileSync(path.join(sandboxBackend, 'auth_tokens.json'), JSON.stringify({ seed: true }));
	const output = execFileSync('bun', ['-e', `
		import assert from 'node:assert/strict';
		import fs from 'node:fs';

		const configPath = ${JSON.stringify(configPath)};
		const write = fs.writeFileSync;
		let checked = false;
		fs.writeFileSync = (file, contents, options) => {
			if (typeof file !== 'string' || !file.startsWith(configPath)) {
				return write(file, contents, options);
			}
			// Expose the truncation boundary to a reader before completing the write.
			write(file, '', options);
			try {
				JSON.parse(fs.readFileSync(configPath, 'utf8'));
				checked = true;
			} finally {
				write(file, contents, options);
			}
		};
		await import(${JSON.stringify(configModule)});
		assert(checked, 'the configuration seed write must be exercised');
		const published = fs.readFileSync(configPath, 'utf8');
		fs.renameSync = () => { throw new Error('forced seed rename failure'); };
		await assert.rejects(
			import(${JSON.stringify(configModule)} + '?failed-publication'),
			/forced seed rename failure/,
		);
		assert.equal(fs.readFileSync(configPath, 'utf8'), published);
		assert.deepEqual(
			fs.readdirSync(${JSON.stringify(sandboxBackend)})
				.filter((file) => file.startsWith('config.json.') && file.endsWith('.tmp')),
			[],
		);
		console.log('complete seed remained readable');
	`], {
		cwd: sandboxFrontend,
		env: {
			...process.env,
			CI: 'true',
			PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(sandboxFrontend, 'child-report.json'),
		},
		encoding: 'utf8',
		timeout: 10_000,
	});
	expect(output.trim()).toBe('complete seed remained readable');
});
