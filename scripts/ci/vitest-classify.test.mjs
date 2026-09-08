import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';
import config from '../../apps/frontend/vitest.config.ts';
import { classifyVitestFiles } from './vitest-classify.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const frontendRoot = path.join(repoRoot, 'apps/frontend');

describe('frontend Vitest classifier', () => {
	test('puts every source test in exactly one project', () => {
		// Given the source tests Vitest can collect
		const sourceTests = globSync('src/**/*.test.ts', {
			cwd: frontendRoot,
			nodir: true,
		}).sort();

		// When the import graph is classified
		const { pure, components } = classifyVitestFiles(frontendRoot);

		// Then the projects are disjoint and their union is the source glob
		expect(pure.filter((file) => components.includes(file))).toEqual([]);
		expect([...pure, ...components].sort()).toEqual(sourceTests);
	});

	test('routes a test that reaches a Svelte store to components', () => {
		// Given the current frontend graph
		const { components } = classifyVitestFiles(frontendRoot);

		// When a test imports the hud.svelte store
		// Then it receives the jsdom/component setup
		expect(components).toContain('src/lib/stores/hud.test.ts');
	});

	test('keeps a rune-free helper test in pure', () => {
		// Given the current frontend graph
		const { pure } = classifyVitestFiles(frontendRoot);

		// When a test reaches only pure helper modules
		// Then it receives the node/storage-only setup
		expect(pure).toContain('src/lib/streaming/go-live-readiness.test.ts');
	});

	test('preserves the two mixed-topology tests in compatible environments', () => {
		// Given one Svelte-reaching test that imports browser code and one that
		// explicitly proves the production Node fallback
		const { pure, components } = classifyVitestFiles(frontendRoot);

		// When the topology requirements take precedence over a blind Svelte split
		// Then Navigation gets jsdom while the TTL fallback keeps window absent
		expect(components).toContain('src/lib/helpers/NavigationHelper.test.ts');
		expect(pure).toContain('src/lib/rpc/ttl-seam.test.ts');
	});
});

describe('compiled i18n native import boundary', () => {
	test('loads every part of the compiled catalog through one native module graph', () => {
		// Given the ordinary config, without experimental environment switches
		const external = config.test.server?.deps?.external ?? [];
		// When resolving the catalog entry, registry, namespaces and locale runtime
		const modules = [
			'generated/eager.js',
			'generated/registry.js',
			'generated/runtime.js',
			'generated/namespaces/network.js',
			'src/paraglide/runtime.js',
			'src/paraglide/messages/live_setup_title.js',
		];
		// Then every entry reaches the same native graph, not a second Vite registry
		for (const module of modules) {
			expect(external.some((pattern) => pattern.test(`${repoRoot}/packages/i18n/${module}`))).toBe(
				true,
			);
		}
	});

	test('keeps rune modules, application code and temporary registries transformed', () => {
		// Given the native import rule
		const external = config.test.server?.deps?.external ?? [];
		// When resolving source or a test-generated independent registry
		const modules = [
			'packages/i18n/src/svelte.svelte.ts',
			'packages/i18n/src/locale-lifecycle.ts',
			'packages/i18n/scripts/generate-registry.ts',
			'packages/i18n/generated/registry.d.ts',
			'packages/i18n/test-results/independent/generated/registry.js',
			'packages/rpc/src/index.ts',
			'apps/frontend/src/main/LiveView.svelte',
			'node_modules/svelte/src/internal/client/index.js',
		];
		// Then none escapes Vitest's transform and isolation boundary
		for (const module of modules) {
			expect(external.some((pattern) => pattern.test(`${repoRoot}/${module}`))).toBe(false);
		}
	});
});
