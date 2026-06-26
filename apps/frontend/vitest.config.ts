import path from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { persistPlugin } from 'svelte-persistent-runes/plugins';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [persistPlugin(), svelte({ compilerOptions: { hmr: false } })],
	define: {
		__APP_VERSION__: JSON.stringify('0.0.0-test'),
		__BRAND_CONFIG__: JSON.stringify({
			siteName: 'CeraUI for CERALIVE©',
			description: 'test',
			deviceName: 'CERALIVE',
		}),
	},
	test: {
		globals: true,
		environment: 'node',
		setupFiles: ['./vitest.setup.ts'],
		include: ['src/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**'],
		// The suite is transform/import-bound (Svelte compile), not CPU-bound on the
		// assertions, so wall-clock scales with how many files compile in parallel.
		// Threads start far cheaper than forks for this workload; keep per-file
		// isolation (store singletons + the bits-ui teardown guard rely on it) and
		// fan out across more workers than the default to compile files concurrently.
		pool: 'threads',
		fileParallelism: true,
		isolate: true,
		maxWorkers: 16,
		minWorkers: 4,
	},
	resolve: {
		conditions: ['browser'],
		alias: {
			$lib: path.resolve('./src/lib'),
			$main: path.resolve('./src/main'),
		},
	},
});
