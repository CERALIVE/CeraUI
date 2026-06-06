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
	},
	resolve: {
		conditions: ['browser'],
		alias: {
			$lib: path.resolve('./src/lib'),
			$main: path.resolve('./src/main'),
		},
	},
});
