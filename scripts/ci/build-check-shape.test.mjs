import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { file, YAML } from 'bun';
import { globSync } from 'glob';
import ts from 'typescript';

import { assertBuildCheckContract } from './build-check-contract.mjs';

const workflowUrl = new URL('../../.github/workflows/build-check.yml', import.meta.url);
const workflowSource = await file(workflowUrl).text();
const repoRoot = new URL('../../', import.meta.url).pathname;
function staticStringValue(node) {
	if (ts.isStringLiteralLike(node)) return node.text;
	if (ts.isParenthesizedExpression(node)) return staticStringValue(node.expression);
	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const left = staticStringValue(node.left);
		const right = staticStringValue(node.right);
		return left === undefined || right === undefined ? undefined : left + right;
	}
	if (ts.isTemplateExpression(node)) {
		let value = node.head.text;
		for (const span of node.templateSpans) {
			const expression = staticStringValue(span.expression);
			if (expression === undefined) return undefined;
			value += expression + span.literal.text;
		}
		return value;
	}
	return undefined;
}

function runtimeSourceReferenceLines(path, source) {
	const sourceFile = ts.createSourceFile(
		path,
		source,
		ts.ScriptTarget.Latest,
		true,
		path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const lines = new Set();
	function visit(node) {
		const value = staticStringValue(node);
		const dynamicTemplatePrefix =
			ts.isTemplateExpression(node) && node.head.text.startsWith('/src/');
		if (value?.startsWith('/src/') || dynamicTemplatePrefix) {
			lines.add(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return [...lines].sort((left, right) => left - right);
}

const e2eSourceDependencies = globSync('apps/frontend/tests/e2e/**/*.{ts,tsx}', {
	cwd: repoRoot,
	absolute: true,
}).flatMap((path) =>
	runtimeSourceReferenceLines(path, readFileSync(path, 'utf8')).map(
		(lineNumber) => `${path.slice(repoRoot.length)}:${lineNumber}`,
	),
);
const expression = (body) => `${'$' + '{{'} ${body} }}`;
const matrixProject = expression('matrix.project');
const matrixShard = expression('matrix.shard');
const uniqueBlobName = `blob-report-${matrixProject}-${matrixShard}`;
const browserCacheKey = `${expression('runner.os')}-ms-playwright-${expression(
	'steps.playwright-version.outputs.version',
)}`;
const srtlaRuntimeUrl =
	'https://github.com/CERALIVE/srtla-send-rs/releases/download/v3.2.0/srtla-send-rs_3.2.0_amd64.deb';
const srtlaRuntimeSha256 = 'cfd2cc6a0bcb3716c25861daffca9b67e5a56b1c8cf9cb519093588496a928ae';

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
				'      - name: Download frontend dist\n        uses: actions/download-artifact@v8',
				'      - name: Download frontend dist\n        uses: actions/download-artifact@v7',
			),
	},
	{
		name: 'E2E startup without the pinned srtla-send-rs runtime',
		expectedError: 'setup-e2e srtla command plan must equal',
		apply: (source) =>
			replaceExactly(
				source,
				'https://github.com/CERALIVE/srtla-send-rs/releases/download/v3.2.0/srtla-send-rs_3.2.0_amd64.deb',
				'https://github.com/CERALIVE/srtla-send-rs/releases/latest/download/srtla-send-rs_amd64.deb',
			),
	},
	{
		name: 'functional E2E startup using the Vite dev server',
		expectedError: 'test-e2e frontend production preview command must include',
		apply: (source) =>
			replaceExactly(
				source,
				'bun run --filter frontend preview -- --host 127.0.0.1 --port 6173',
				'bun run --filter frontend dev -- --host 127.0.0.1 --port 6173',
			),
	},
	{
		name: 'reference backend auth seeding removed',
		expectedError: 'test-e2e must contain exactly one "Seed E2E auth state" step',
		apply: (source) =>
			replaceExactly(
				source,
				'      - name: Seed E2E auth state\n        working-directory: CeraUI\n        run: E2E_PASSWORD=12345678 bun run scripts/ci/seed-e2e-auth.ts\n\n      - name: Start E2E servers',
				'      - name: Start E2E servers',
			),
	},
];

const staticOnlyFalseGreenMutations = [
	{
		name: 'drifted runtime URL retained only in a comment',
		expectedError: 'setup-e2e srtla command plan must equal',
		apply: (source) =>
			replaceExactly(
				source,
				`            ${srtlaRuntimeUrl}`,
				`            https://github.com/CERALIVE/srtla-send-rs/releases/latest/download/srtla-send-rs_amd64.deb # ${srtlaRuntimeUrl}`,
			),
	},
	{
		name: 'drifted runtime digest retained only in a comment',
		expectedError: 'setup-e2e srtla command plan must equal',
		apply: (source) =>
			replaceExactly(
				source,
				`            ${srtlaRuntimeSha256} \\`,
				`            ${'0'.repeat(64)} \\ # ${srtlaRuntimeSha256}`,
			),
	},
	{
		name: 'Package metadata check hidden in a false branch',
		expectedError: 'setup-e2e srtla command plan must equal',
		apply: (source) =>
			replaceExactly(
				source,
				'          test "$(dpkg-deb --field "$package_path" Package)" = srtla-send-rs',
				'          if false; then\n            test "$(dpkg-deb --field "$package_path" Package)" = srtla-send-rs\n          fi',
			),
	},
	{
		name: 'chmod hidden in a false branch',
		expectedError: 'test-e2e srtla command plan must equal',
		apply: (source) =>
			replaceExactly(
				source,
				'          chmod +x "$runtime_bin"',
				'          if false; then\n            chmod +x "$runtime_bin"\n          fi',
			),
	},
	{
		name: 'GITHUB_PATH update hidden in a false branch',
		expectedError: 'test-e2e srtla command plan must equal',
		apply: (source) =>
			replaceExactly(
				source,
				'          echo "$runtime_dir" >> "$GITHUB_PATH"',
				'          if false; then\n            echo "$runtime_dir" >> "$GITHUB_PATH"\n          fi',
			),
	},
	{
		name: 'setup path assignment hidden in dead JavaScript',
		expectedError: 'test-e2e srtla command plan must equal',
		apply: (source) =>
			replaceExactly(
				source,
				'            setup.srtla_path = runtime_dir;',
				'            if (false) {\n              setup.srtla_path = runtime_dir;\n            }',
			),
	},
	{
		name: 'runtime assertions hidden in a false branch',
		expectedError: 'test-e2e srtla command plan must equal',
		apply: (source) =>
			replaceExactly(
				source,
				'          test -x "$runtime_bin"\n          test "$(command -v srtla_send)" = "$runtime_bin"',
				'          if false; then\n            test -x "$runtime_bin"\n            test "$(command -v srtla_send)" = "$runtime_bin"\n          fi',
			),
	},
	{
		name: 'chmod retained only as quoted output',
		expectedError: 'test-e2e srtla command plan must equal',
		apply: (source) =>
			replaceExactly(
				source,
				'          chmod +x "$runtime_bin"',
				"          printf '%s\\n' 'chmod +x \"$runtime_bin\"'",
			),
	},
	{
		name: 'runtime URL retained only in a here-document',
		expectedError: 'setup-e2e srtla command plan must equal',
		apply: (source) =>
			replaceExactly(
				source,
				`            ${srtlaRuntimeUrl}`,
				`            https://github.com/CERALIVE/srtla-send-rs/releases/latest/download/srtla-send-rs_amd64.deb\n          cat <<'PINNED_URL'\n          ${srtlaRuntimeUrl}\n          PINNED_URL`,
			),
	},
	{
		name: 'Package metadata check retained only in an uncalled function',
		expectedError: 'setup-e2e srtla command plan must equal',
		apply: (source) =>
			replaceExactly(
				source,
				'          test "$(dpkg-deb --field "$package_path" Package)" = srtla-send-rs',
				'          verify_package() {\n            test "$(dpkg-deb --field "$package_path" Package)" = srtla-send-rs\n          }',
			),
	},
	{
		name: 'same-shell PATH export removed',
		expectedError: 'test-e2e srtla command plan must equal',
		apply: (source) => replaceExactly(source, '          export PATH="$runtime_dir:$PATH"', ''),
	},
	{
		name: 'same-shell PATH export retained only in a comment',
		expectedError: 'test-e2e srtla command plan must equal',
		apply: (source) =>
			replaceExactly(
				source,
				'          export PATH="$runtime_dir:$PATH"',
				'          # export PATH="$runtime_dir:$PATH"',
			),
	},
	{
		name: 'same-shell PATH export hidden in a false branch',
		expectedError: 'test-e2e srtla command plan must equal',
		apply: (source) =>
			replaceExactly(
				source,
				'          export PATH="$runtime_dir:$PATH"',
				'          if false; then\n            export PATH="$runtime_dir:$PATH"\n          fi',
			),
	},
	{
		name: 'same-shell PATH export ordered after command lookup',
		expectedError: 'test-e2e srtla command plan must equal',
		apply: (source) => {
			const withoutExport = replaceExactly(
				source,
				'          export PATH="$runtime_dir:$PATH"',
				'',
			);
			return replaceExactly(
				withoutExport,
				'          test "$(command -v srtla_send)" = "$runtime_bin"',
				'          test "$(command -v srtla_send)" = "$runtime_bin"\n          export PATH="$runtime_dir:$PATH"',
			);
		},
	},
];

describe('Build Check semantic workflow contract', () => {
	test('the /src guard detects import, request, template, and concatenated forms', () => {
		const probe = [
			'import value from "/src/direct.ts";',
			`fetch(\`/src/${String.fromCharCode(36)}{name}.ts\`);`,
			'new Request("/src/request.ts");',
			'const route = "/src" + "/concatenated.ts";',
		].join('\n');
		expect(runtimeSourceReferenceLines('probe.ts', probe)).toEqual([1, 2, 3, 4]);
	});

	test('production-preview E2E sources do not import Vite-served /src modules', () => {
		expect(e2eSourceDependencies).toEqual([]);
	});

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

	for (const mutation of staticOnlyFalseGreenMutations) {
		test(`rejects static-only false-green: ${mutation.name}`, () => {
			const mutated = mutation.apply(workflowSource);
			expect(() => YAML.parse(mutated)).not.toThrow();
			expect(() => assertBuildCheckContract(mutated)).toThrow(mutation.expectedError);
		});
	}
});
