import { describe, expect, test } from 'bun:test';
import { file, YAML } from 'bun';

import { assertBuildCheckContract } from './build-check-contract.mjs';

const workflowUrl = new URL('../../.github/workflows/build-check.yml', import.meta.url);
const workflowSource = await file(workflowUrl).text();
const expression = (body) => `${'$' + '{{'} ${body} }}`;
const matrixProject = expression('matrix.project');
const matrixShard = expression('matrix.shard');
const uniqueBlobName = `blob-report-${matrixProject}-${matrixShard}`;
const browserCacheKey = `${expression('runner.os')}-ms-playwright-${expression(
	'steps.playwright-version.outputs.version',
)}`;

function replaceExactly(source, before, after, expectedCount = 1) {
	const count = source.split(before).length - 1;
	expect(count).toBe(expectedCount);
	return source.split(before).join(after);
}

const mutations = [
	{
		name: 'single-project matrix even when the old matrix survives in a comment',
		expectedError: 'test-e2e matrix.project must equal',
		apply: (source) =>
			replaceExactly(
				source,
				'        project: [desktop, mobile]',
				'        # project: [desktop, mobile]\n        project: [desktop]',
			),
	},
	{
		name: 'wrong setup dependency even when the old dependency survives in a comment',
		expectedError: 'test-e2e.needs must be "setup-e2e"',
		apply: (source) =>
			replaceExactly(source, '    needs: setup-e2e', '    # needs: setup-e2e\n    needs: test-fe'),
	},
	{
		name: 'colliding static blob artifact even when the unique name survives in a comment',
		expectedError: 'functional blob artifact name must be',
		apply: (source) =>
			replaceExactly(
				source,
				`          name: ${uniqueBlobName}`,
				`          # name: ${uniqueBlobName}\n          name: blob-report-e2e`,
			),
	},
	{
		name: 'static browser cache keys even when exact-version keys survive in comments',
		expectedError: 'setup-e2e browser cache key must be',
		apply: (source) =>
			replaceExactly(
				source,
				`          key: ${browserCacheKey}`,
				`          # key: ${browserCacheKey}\n          key: Linux-ms-playwright-static`,
				2,
			),
	},
	{
		name: 'stale download-artifact major',
		expectedError: 'test-e2e frontend download action must be',
		apply: (source) =>
			replaceExactly(
				source,
				'        uses: actions/download-artifact@v8',
				'        uses: actions/download-artifact@v7',
				2,
			),
	},
];

describe('Build Check semantic workflow contract', () => {
	test('accepts the committed workflow', () => {
		expect(() => assertBuildCheckContract(workflowSource)).not.toThrow();
	});

	for (const mutation of mutations) {
		test(`rejects an actionlint-valid ${mutation.name}`, () => {
			const mutated = mutation.apply(workflowSource);
			expect(() => YAML.parse(mutated)).not.toThrow();
			expect(() => assertBuildCheckContract(mutated)).toThrow(mutation.expectedError);
		});
	}
});
