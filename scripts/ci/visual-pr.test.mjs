import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { file, Glob, YAML } from 'bun';
import { assertBuildCheckContract } from './build-check-contract.mjs';
import { visualSpecs } from './visual-pr.mjs';

const expression = (body) => `${'$' + '{{'} ${body} }}`;
const workflow = YAML.parse(
	await file(new URL('../../.github/workflows/build-check.yml', import.meta.url)).text(),
);

test('the PR comparison command forbids retries and snapshot writes with the locked browser version', async () => {
	const root = new URL('../../', import.meta.url);
	const pkg = await file(new URL('package.json', root)).json();
	const lock = await file(new URL('bun.lock', root)).text();
	const version = /"@playwright\/test": \["@playwright\/test@([^"]+)"/u.exec(lock)[1];
	expect(workflow.jobs['test-visual'].container.image).toMatch(
		new RegExp(
			`^mcr\\.microsoft\\.com/playwright:v${version.replaceAll('.', '\\.')}-noble@sha256:[a-f0-9]{64}$`,
			'u',
		),
	);
	expect(pkg.scripts['test:e2e:visual:pr']).toBe(
		'bun scripts/ci/visual-pr.mjs --grep @visual --workers=2 --retries=0 --update-snapshots=none --output=test-results/visual-pr --reporter=line,json,blob',
	);
});

for (const [name, mutate, error] of [
	[
		'missing visual output',
		(jobs) => {
			jobs.changes.outputs.visual = undefined;
		},
		'changes visual output',
	],
	[
		'AND visual filter',
		(jobs) => {
			jobs.changes.steps.find((step) => step.id === 'visual').with['predicate-quantifier'] =
				'every';
		},
		'visual OR quantifier',
	],
	[
		'missing image digest',
		(jobs) => {
			jobs['test-visual'].container.image = 'mcr.microsoft.com/playwright:v1.65.0-noble';
		},
		'digest-pinned',
	],
	[
		'excluded visual lane',
		(jobs) => {
			jobs['test-visual'].if = expression('false');
		},
		'test-visual scope',
	],
	[
		'auto-update override',
		(jobs) => {
			jobs['test-visual'].steps.find((step) => step.name === 'Visual comparisons').run +=
				' bun run test:e2e:visual -- --update-snapshots';
		},
		'comparison command',
	],
	[
		'missing summary dependency',
		(jobs) => {
			jobs.test.needs = jobs.test.needs.filter((id) => id !== 'test-visual');
		},
		'test.needs',
	],
	[
		'missing container bootstrap',
		(jobs) => {
			jobs['test-visual'].steps = jobs['test-visual'].steps.filter(
				(step) => step.name !== 'Visual container bootstrap',
			);
		},
		'Visual container bootstrap',
	],
	[
		'browsers outside the image',
		(jobs) => {
			jobs['test-visual'].env.PLAYWRIGHT_BROWSERS_PATH = undefined;
		},
		'test-visual image browsers',
	],
]) {
	test(`workflow rejects ${name}`, () => {
		const mutated = structuredClone(workflow);
		mutate(mutated.jobs);
		expect(() => assertBuildCheckContract(YAML.stringify(mutated))).toThrow(error);
	});
}

test('visual selection keeps the six files and adds changed snapshot owners once', () => {
	const subset = visualSpecs([]);
	expect(subset).toEqual([
		'tests/e2e/visual/audio-mixer.visual.spec.ts',
		'tests/e2e/visual/layout-designer.visual.spec.ts',
		'tests/e2e/visual/live.visual.spec.ts',
		'tests/e2e/visual/network.visual.spec.ts',
		'tests/e2e/visual/settings.visual.spec.ts',
		'tests/e2e/visual/signal-indicator.visual.spec.ts',
	]);
	const outside =
		'apps/frontend/tests/e2e/visual/preview-toggle.visual.spec.ts-snapshots/preview-desktop-linux.png';
	expect(
		visualSpecs([
			outside,
			outside,
			'apps/frontend/tests/e2e/visual/live.visual.spec.ts-snapshots/live-desktop-desktop-linux.png',
			'apps/frontend/tests/e2e/visual/deleted.visual.spec.ts-snapshots/old.png',
		]),
	).toEqual([...subset, 'tests/e2e/visual/preview-toggle.visual.spec.ts']);
});

test('the host command discovers exactly the visual cases outside the CI-owned subset', () => {
	const temporary = mkdtempSync(join(tmpdir(), 'visual-selection-'));
	try {
		const discover = (command, name) => {
			const report = join(temporary, `${name}.json`);
			const run = spawnSync('bun', ['run', ...command, '--list', '--reporter=json'], {
				cwd: new URL('../../', import.meta.url),
				env: {
					...process.env,
					CI: '',
					E2E_VISUAL_HOST: '',
					PLAYWRIGHT_JSON_OUTPUT_NAME: report,
				},
				encoding: 'utf8',
			});
			expect(run.status, run.stdout + run.stderr).toBe(0);
			const collect = (suite, parents = []) => [
				...(suite.specs ?? []).flatMap((spec) =>
					spec.tests.map((entry) => ({
						file: `tests/e2e/${spec.file}`,
						case: JSON.stringify([
							entry.projectName,
							spec.file,
							spec.line,
							spec.column,
							...parents,
							suite.title ?? '',
							spec.title,
						]),
					})),
				),
				...(suite.suites ?? []).flatMap((child) => collect(child, [...parents, suite.title ?? ''])),
			];
			return collect(JSON.parse(readFileSync(report, 'utf8')));
		};
		const all = discover(['--filter', 'frontend', 'test:e2e', '--', '--grep', '@visual'], 'all');
		const host = discover(['test:e2e:visual', '--'], 'host');
		const owned = visualSpecs([]);
		expect(new Set(all.map((entry) => entry.case)).size).toBe(all.length);
		expect(
			[
				...new Set(all.filter((entry) => owned.includes(entry.file)).map((entry) => entry.file)),
			].sort(),
		).toEqual([...owned].sort());
		expect(host.map((entry) => entry.case).sort()).toEqual(
			all
				.filter((entry) => !owned.includes(entry.file))
				.map((entry) => entry.case)
				.sort(),
		);
	} finally {
		rmSync(temporary, { recursive: true });
	}
}, 30_000);

for (const input of [null, ['../outside.png'], [1]]) {
	test(`visual selection rejects invalid snapshot input ${JSON.stringify(input)}`, () => {
		expect(() => visualSpecs(input)).toThrow();
	});
}

test('visual scope selects frontend and snapshot inputs, leaving backend and docs alone', () => {
	const changes = workflow.jobs.changes;
	expect(changes.outputs.visual).toBe(
		expression("steps.filter.outputs.code == 'true' && steps.visual.outputs.visual == 'true'"),
	);
	expect(changes.outputs.snapshots).toBe(expression('steps.visual.outputs.snapshots_files'));
	const step = changes.steps.find((entry) => entry.id === 'visual');
	expect(step.with['predicate-quantifier'] ?? 'some').toBe('some');
	const filters = YAML.parse(step.with.filters);
	const code = YAML.parse(changes.steps.find((entry) => entry.id === 'filter').with.filters).code;
	for (const [path, expected] of [
		['apps/frontend/src/main/LiveView.svelte', true],
		['apps/frontend/public/icon.svg', true],
		['apps/frontend/playwright.config.ts', true],
		['apps/frontend/tests/e2e/fixtures/index.ts', true],
		['apps/frontend/tests/e2e/visual/live.visual.spec.ts-snapshots/live.png', true],
		['apps/frontend/tests/e2e/visual/preview.visual.spec.ts-snapshots/preview.png', true],
		['packages/i18n/src/index.ts', true],
		['packages/rpc/src/index.ts', true],
		['package.json', true],
		['bun.lock', true],
		['scripts/ci/visual-pr.mjs', true],
		['.github/workflows/build-check.yml', true],
		['apps/backend/src/main.ts', false],
		['README.md', false],
		['apps/frontend/AGENTS.md', false],
		['apps/frontend/src/README.md', false],
		['apps/frontend/public/README.md', false],
		['apps/frontend/tests/e2e/PLAYBOOK.md', false],
		['docs/agents/release-ci-rules.md', false],
	]) {
		const isCode = code.every((pattern) =>
			pattern.startsWith('!')
				? !new Glob(pattern.slice(1)).match(path)
				: new Glob(pattern).match(path),
		);
		expect(isCode && filters.visual.some((pattern) => new Glob(pattern).match(path)), path).toBe(
			expected,
		);
	}
});

const resultEnv = workflow.jobs.test.steps[0].env.RESULTS;
const jobIds = [...resultEnv.matchAll(/([\w-]+)=\$\{\{/gu)].map((match) => match[1]);
for (const [code, visual, overrides, expected] of [
	['true', 'true', {}, 0],
	['true', 'false', { 'test-visual': 'skipped' }, 0],
	[
		'false',
		'false',
		Object.fromEntries(jobIds.filter((id) => id !== 'changes').map((id) => [id, 'skipped'])),
		0,
	],
	['true', 'true', { 'test-visual': 'failure' }, 1],
	['true', 'false', { 'test-visual': 'cancelled' }, 1],
	['true', 'true', { 'test-visual': 'skipped' }, 1],
	['true', 'false', { 'test-be': 'skipped', 'test-visual': 'skipped' }, 1],
	['true', '', { 'test-visual': 'skipped' }, 1],
	['true', 'true', { 'setup-e2e': 'failure', 'test-visual': 'skipped' }, 1],
]) {
	test(`summary enforces code=${code} visual=${visual} results=${JSON.stringify(overrides)}`, () => {
		expect(workflow.jobs.test.needs).toContain('test-visual');
		const results = jobIds.map((id) => `${id}=${overrides[id] ?? 'success'}`).join(' ');
		const run = spawnSync('bash', ['-c', workflow.jobs.test.steps[0].run], {
			env: { ...process.env, CODE_CHANGED: code, VISUAL_CHANGED: visual, RESULTS: results },
			encoding: 'utf8',
		});
		expect(run.status, run.stdout + run.stderr).toBe(expected);
	});
}
