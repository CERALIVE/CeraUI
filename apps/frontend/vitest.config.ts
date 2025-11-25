import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		include: ['src/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**'],
	},
	resolve: {
		alias: {
			$lib: path.resolve('./src/lib'),
			$main: path.resolve('./src/main'),
		},
	},
});
