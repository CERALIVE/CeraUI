import path from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { persistPlugin } from 'svelte-persistent-runes/plugins';
import { defineConfig } from 'vitest/config';

import { classifyVitestFiles } from '../../scripts/ci/vitest-classify.mjs';

const { pure, components } = classifyVitestFiles();
const threadWorkerBounds = { maxWorkers: 16, minWorkers: 4 } as const;

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
		server: {
			deps: {
				// Already-compiled ESM: keep its registry and locale runtime in ONE
				// native graph. The Svelte facade and test-generated registries stay isolated.
				external: [/\/packages\/i18n\/(?:generated|src\/paraglide)\/.*\.js$/],
			},
		},
		globals: true,
		exclude: ['**/node_modules/**', '**/dist/**'],
		// CI compiles ~355 Svelte-heavy files for 20+ minutes; three unrelated
		// async rendering tests have each exhausted Vitest's 5 s default under load.
		// Four times that budget absorbs scheduler pressure while keeping hangs bounded.
		testTimeout: 20_000,
		// The suite is transform/import-bound (Svelte compile), not CPU-bound on the
		// assertions, so wall-clock scales with how many files compile in parallel.
		// Threads start far cheaper than forks for this workload; fan out across
		// more workers than the default to compile files concurrently.
		pool: 'threads',
		fileParallelism: true,
		...threadWorkerBounds,
		projects: [
			{
				extends: true,
				test: {
					name: 'pure',
					environment: 'node',
					isolate: false,
					include: pure,
					setupFiles: ['./vitest.storage.setup.ts'],
				},
			},
			{
				extends: true,
				test: {
					name: 'components',
					environment: 'jsdom',
					isolate: true,
					include: components,
					setupFiles: [
						'./vitest.storage.setup.ts',
						'./vitest.components.setup.ts',
					],
				},
			},
		],
	},
	resolve: {
		conditions: ['browser'],
		alias: {
			$lib: path.resolve('./src/lib'),
			$main: path.resolve('./src/main'),
		},
	},
});
