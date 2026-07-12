import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: import.meta.dirname,
	testMatch: 'input-picker.spec.ts',
	grep: /@hardware/,
	outputDir: path.resolve(import.meta.dirname, '../../test-results'),
	fullyParallel: false,
	forbidOnly: true,
	workers: 1,
	retries: 0,
	reporter: [['line']],
	use: {
		screenshot: 'off',
		trace: 'off',
		video: 'off',
	},
	projects: [
		{
			name: 'desktop',
			use: {
				...devices['Desktop Chrome'],
				viewport: { width: 1280, height: 800 },
			},
		},
	],
});
