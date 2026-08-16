import path from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { persistPlugin } from 'svelte-persistent-runes/plugins';
import { defineConfig } from 'vitest/config';

// Federation ABI harness — a SEPARATE config because its subject is the built
// output under dist/federation, not the source tree the default suite compiles.
// Keeping it out of vitest.config.ts's `include` is what stops `bun run test`
// failing on a checkout that has never run `build:federation`.
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
		environment: 'jsdom',
		setupFiles: ['./vitest.setup.ts'],
		include: ['tests/federation/**/*.test.ts'],
		exclude: ['**/node_modules/**'],
		pool: 'threads',
		isolate: true,
	},
	resolve: {
		conditions: ['browser'],
		alias: {
			$lib: path.resolve('./src/lib'),
			$main: path.resolve('./src/main'),
		},
	},
});
