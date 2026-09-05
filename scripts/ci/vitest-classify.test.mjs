import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';

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
