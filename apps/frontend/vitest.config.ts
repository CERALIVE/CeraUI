import { availableParallelism } from 'node:os';
import path from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { persistPlugin } from 'svelte-persistent-runes/plugins';
import { defineConfig } from 'vitest/config';

import { classifyVitestFiles } from '../../scripts/ci/vitest-classify.mjs';

const { pure, components } = classifyVitestFiles();
const availableCpus = availableParallelism();

export function calculateMaxWorkers(availableCpus: number): number {
	return Math.min(16, availableCpus);
}

const maxWorkers = calculateMaxWorkers(availableCpus);

if (process.env.CI === 'true') {
	console.info('[vitest] worker budget', { availableCpus, maxWorkers });
}

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
		dangerouslyIgnoreUnhandledErrors: false,
		onUnhandledError(error) {
			throw error;
		},
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
		// Rendering and worker teardown compete with compilation for CPU and memory.
		// A fixed 16-worker pool starves small runners; respect their actual allocation
		// (including affinity/cgroup quotas) while retaining the measured local ceiling.
		pool: 'threads',
		fileParallelism: true,
		maxWorkers,
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
