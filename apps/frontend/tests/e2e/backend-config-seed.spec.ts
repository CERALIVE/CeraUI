import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { expect, test } from './fixtures/index.js';

test('configuration bootstrap keeps the shared seed complete during publication', () => {
	const configPath = path.resolve(import.meta.dirname, '../../../backend/config.json');
	const configModule = path.resolve(import.meta.dirname, '../../playwright.config.ts');
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
		console.log('complete seed remained readable');
	`], {
		env: { ...process.env, CI: 'true' },
		encoding: 'utf8',
		timeout: 10_000,
	});
	expect(output.trim()).toBe('complete seed remained readable');
});
