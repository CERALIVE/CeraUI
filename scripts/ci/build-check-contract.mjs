import { file, YAML } from 'bun';

const expression = (body) => `${'$' + '{{'} ${body} }}`;
const shellVar = (name) => `${'$' + '{'}${name}}`;
const matrixProject = expression('matrix.project');
const matrixShard = expression('matrix.shard');
const totalShards = expression('env.TOTAL_SHARDS');
// The FE unit lane is sharded STATICALLY. The workspace CI manifest models each
// leg by literal id, so the shard list is a contract, not a tuning knob.
const FE_SHARDS = [1, 2, 3, 4];
const FE_SHARD_SPEC = `${matrixShard}/${FE_SHARDS.length}`;
const FE_BLOB_ARTIFACT = `vitest-blob-${matrixShard}`;
const FE_BLOB_DIR = 'apps/frontend/.vitest/blob';
// `-v2-` retires a cache entry that was missing chromium_headless_shell. Bumping
// the namespace is what abandons a poisoned entry — actions/cache cannot
// overwrite one, because it never re-saves on an exact-key hit.
const PLAYWRIGHT_CACHE_KEY = `${expression('runner.os')}-ms-playwright-v2-${expression(
	'steps.playwright-version.outputs.version',
)}`;
const PLAYWRIGHT_RESTORE_KEY = `${expression('runner.os')}-ms-playwright-v2-`;
// Docs-only gating. `predicate-quantifier: 'every'` is what makes the exclusion
// list able to yield `code=false` at all; under the action's default `some` the
// leading `**` matches on its own and a README-only PR still reports `true`.
const CODE_FILTER_PATTERNS = [
	'**',
	'!**/*.md',
	'!docs/**',
	'!LICENSE*',
	'!.github/PULL_REQUEST_TEMPLATE.md',
	'!.github/ISSUE_TEMPLATE/**',
	'!inspiration/**',
];
const CODE_GATE = expression("needs.changes.outputs.code == 'true'");
const MERGE_GATE = expression("!cancelled() && needs.changes.outputs.code == 'true'");
const GATED_JOBS = [
	'test-fe',
	'merge-fe-reports',
	'guardrails',
	'test-be',
	'setup-e2e',
	'test-e2e',
	'merge-e2e-reports',
	'build',
];
const SUMMARY_NEEDS = ['changes', ...GATED_JOBS];
const SRTLA_RUNTIME_ARTIFACT = 'srtla-send-runtime-amd64-v3.2.0';
const SRTLA_RUNTIME_URL =
	'https://github.com/CERALIVE/srtla-send-rs/releases/download/v3.2.0/srtla-send-rs_3.2.0_amd64.deb';
const SRTLA_RUNTIME_SHA256 = 'cfd2cc6a0bcb3716c25861daffca9b67e5a56b1c8cf9cb519093588496a928ae';
const SRTLA_PREPARE_COMMANDS = [
	'set -euo pipefail',
	'package_dir="dist/ci-packages"',
	'package_path="$package_dir/srtla-send-rs_3.2.0_amd64.deb"',
	'runtime_root="dist/ci-runtime"',
	'mkdir -p "$package_dir" "$runtime_root"',
	`curl --fail --location --silent --show-error --output "$package_path" ${SRTLA_RUNTIME_URL}`,
	`printf '%s  %s\\n' ${SRTLA_RUNTIME_SHA256} "$package_path" | sha256sum --check`,
	'test "$(dpkg-deb --field "$package_path" Package)" = srtla-send-rs',
	'test "$(dpkg-deb --field "$package_path" Version)" = 3.2.0',
	'test "$(dpkg-deb --field "$package_path" Architecture)" = amd64',
	'dpkg-deb --extract "$package_path" "$runtime_root"',
	'test -f "$runtime_root/usr/bin/srtla_send"',
];
const SRTLA_ACTIVATE_COMMANDS = [
	'set -euo pipefail',
	'runtime_dir="$GITHUB_WORKSPACE/CeraUI/dist/ci-runtime/usr/bin"',
	'runtime_bin="$runtime_dir/srtla_send"',
	'chmod +x "$runtime_bin"',
	'echo "$runtime_dir" >> "$GITHUB_PATH"',
	'export PATH="$runtime_dir:$PATH"',
	`RUNTIME_DIR="$runtime_dir" bun -e '
const path = "apps/backend/setup.json";
const setup = await Bun.file(path).json();
const runtime_dir = process.env.RUNTIME_DIR;
if (!runtime_dir) throw new Error("RUNTIME_DIR is required");
setup.srtla_path = runtime_dir;
await Bun.write(path, JSON.stringify(setup, null, 2) + "\\n");
'`,
	'test -x "$runtime_bin"',
	'test "$(command -v srtla_send)" = "$runtime_bin"',
];

function fail(message) {
	throw new Error(message);
}

function asRecord(value, label) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		fail(`${label} must be an object`);
	}
	return value;
}

function asList(value, label) {
	if (!Array.isArray(value)) fail(`${label} must be a list`);
	return value;
}

function assertExact(actual, expected, label) {
	if (!Object.is(actual, expected)) {
		fail(`${label} must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

function assertList(actual, expected, label) {
	const list = asList(actual, label);
	if (JSON.stringify(list) !== JSON.stringify(expected)) {
		fail(`${label} must equal ${JSON.stringify(expected)}, got ${JSON.stringify(list)}`);
	}
}

function assertIncludes(actual, expected, label) {
	if (typeof actual !== 'string' || !actual.includes(expected)) {
		fail(`${label} must include ${JSON.stringify(expected)}`);
	}
}

function stepsOf(job, label) {
	return asList(job.steps, `${label}.steps`).map((step, index) =>
		asRecord(step, `${label}.steps[${index}]`),
	);
}

function findStep(steps, name, label) {
	const matches = steps.filter((step) => step.name === name);
	if (matches.length !== 1) {
		fail(`${label} must contain exactly one ${JSON.stringify(name)} step`);
	}
	return matches[0];
}

function withValues(step, label) {
	return asRecord(step.with, `${label}.with`);
}

function assertBrowserCache(steps, label) {
	const version = findStep(steps, 'Resolve Playwright browser version', label);
	assertExact(version.id, 'playwright-version', `${label} version step id`);
	assertIncludes(version.run, 'bunx --bun playwright --version', `${label} version command`);

	const cache = findStep(steps, 'Cache Playwright browsers', label);
	assertExact(cache.id, 'playwright-cache', `${label} browser cache id`);
	assertExact(cache.uses, 'actions/cache@v6', `${label} browser cache action`);
	const cacheWith = withValues(cache, `${label} browser cache`);
	assertExact(cacheWith.path, '~/.cache/ms-playwright', `${label} browser cache path`);
	assertExact(cacheWith.key, PLAYWRIGHT_CACHE_KEY, `${label} browser cache key`);
	assertExact(
		String(cacheWith['restore-keys']).trim(),
		PLAYWRIGHT_RESTORE_KEY,
		`${label} browser restore key`,
	);

	// The install MUST stay unconditional. Guarding it on the cache hit is what
	// made a cache missing a browser permanently unrepairable: the guard skipped
	// the only step that could restore it, and the exact-key hit stopped the cache
	// being re-saved, so all four E2E shards failed at `browserType.launch`.
	const install = findStep(steps, 'Install Playwright browsers', label);
	assertExact(install.if, undefined, `${label} browser install condition`);
	assertExact(
		install.run,
		'bun run --filter frontend test:e2e:install-browser',
		`${label} browser install command`,
	);
}

function assertStepOrder(steps, beforeName, afterName, label) {
	const beforeIndex = steps.findIndex((step) => step.name === beforeName);
	const afterIndex = steps.findIndex((step) => step.name === afterName);
	if (beforeIndex === -1 || afterIndex === -1 || beforeIndex >= afterIndex) {
		fail(`${label} must place ${JSON.stringify(beforeName)} before ${JSON.stringify(afterName)}`);
	}
}

// These two workflow steps deliberately use straight-line shell. Parse only
// continuations and the existing multiline single-quoted `bun -e` payload;
// anything more expressive must fail the exact command plan below.
function straightLineShellCommands(run, label) {
	if (typeof run !== 'string') fail(`${label} must be a shell script`);
	const commands = [];
	let fragments = [];
	let inSingleQuote = false;

	for (const rawLine of run.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (line.length === 0) continue;

		fragments.push(line.endsWith('\\') && !inSingleQuote ? line.slice(0, -1).trimEnd() : line);
		const quoteCount = [...line].filter((character) => character === "'").length;
		if (quoteCount % 2 === 1) inSingleQuote = !inSingleQuote;
		if (inSingleQuote || line.endsWith('\\')) continue;

		commands.push(fragments.join(fragments[0]?.includes("bun -e '") ? '\n' : ' '));
		fragments = [];
	}

	if (inSingleQuote || fragments.length > 0) fail(`${label} must have balanced commands`);
	return commands;
}

function assertSrtlaRuntime(setupSteps, e2eSteps) {
	const prepare = findStep(setupSteps, 'Prepare pinned srtla-send runtime', 'setup-e2e');
	assertExact(prepare['working-directory'], 'CeraUI', 'setup-e2e srtla working directory');
	assertList(
		straightLineShellCommands(prepare.run, 'setup-e2e srtla commands'),
		SRTLA_PREPARE_COMMANDS,
		'setup-e2e srtla command plan',
	);

	const upload = findStep(setupSteps, 'Upload srtla-send runtime', 'setup-e2e');
	assertExact(upload.uses, 'actions/upload-artifact@v7', 'setup-e2e srtla upload action');
	const uploadWith = withValues(upload, 'setup-e2e srtla upload');
	assertExact(uploadWith.name, SRTLA_RUNTIME_ARTIFACT, 'setup-e2e srtla artifact name');
	assertExact(uploadWith.path, 'CeraUI/dist/ci-runtime/', 'setup-e2e srtla artifact path');
	assertExact(uploadWith['if-no-files-found'], 'error', 'setup-e2e srtla missing-file policy');
	assertExact(uploadWith['retention-days'], 1, 'setup-e2e srtla artifact retention');

	const download = findStep(e2eSteps, 'Download srtla-send runtime', 'test-e2e');
	assertExact(download.uses, 'actions/download-artifact@v8', 'test-e2e srtla download action');
	const downloadWith = withValues(download, 'test-e2e srtla download');
	assertExact(downloadWith.name, SRTLA_RUNTIME_ARTIFACT, 'test-e2e srtla artifact name');
	assertExact(downloadWith.path, 'CeraUI/dist/ci-runtime', 'test-e2e srtla artifact path');

	const activate = findStep(e2eSteps, 'Activate srtla-send runtime', 'test-e2e');
	assertExact(activate['working-directory'], 'CeraUI', 'test-e2e srtla working directory');
	assertList(
		straightLineShellCommands(activate.run, 'test-e2e srtla commands'),
		SRTLA_ACTIVATE_COMMANDS,
		'test-e2e srtla command plan',
	);
	assertStepOrder(
		e2eSteps,
		'Download srtla-send runtime',
		'Activate srtla-send runtime',
		'test-e2e',
	);
	assertStepOrder(e2eSteps, 'Activate srtla-send runtime', 'Start E2E servers', 'test-e2e');
}

function assertChangesGate(jobs) {
	const changes = asRecord(jobs.changes, 'changes');
	const permissions = asRecord(changes.permissions, 'changes.permissions');
	assertExact(permissions.contents, 'read', 'changes contents permission');
	assertExact(permissions['pull-requests'], 'read', 'changes pull-requests permission');
	// Without the explicit job-level mapping every `needs.changes.outputs.code`
	// below resolves to the empty string and the whole gate skips silently.
	assertExact(
		asRecord(changes.outputs, 'changes.outputs').code,
		expression('steps.filter.outputs.code'),
		'changes code output',
	);

	const steps = stepsOf(changes, 'changes');
	const checkout = findStep(steps, 'Checkout', 'changes');
	assertExact(checkout.uses, 'actions/checkout@v7', 'changes checkout action');
	assertExact(withValues(checkout, 'changes checkout')['fetch-depth'], 0, 'changes fetch depth');

	const filter = findStep(steps, 'Detect code changes', 'changes');
	assertExact(filter.uses, 'dorny/paths-filter@v4', 'changes filter action');
	assertExact(filter.id, 'filter', 'changes filter step id');
	const filterWith = withValues(filter, 'changes filter');
	assertExact(filterWith['predicate-quantifier'], 'every', 'changes predicate quantifier');
	const filters = asRecord(YAML.parse(String(filterWith.filters)), 'changes filters');
	assertList(filters.code, CODE_FILTER_PATTERNS, 'changes code filter');
	// A second positive filter sharing this step would be ANDed by `every` and
	// could never match a file; the `code` exclusion list must stand alone.
	assertList(Object.keys(filters), ['code'], 'changes filter names');
}

function assertGatedJobs(jobs) {
	for (const jobId of GATED_JOBS) {
		const job = asRecord(jobs[jobId], jobId);
		const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
		if (!needs.includes('changes')) {
			fail(`${jobId}.needs must include "changes", got ${JSON.stringify(job.needs)}`);
		}
		// The two report mergers keep `!cancelled()` so a FAILING lane's blob still
		// reaches the merged report; every other gated job carries the bare gate.
		const expected = jobId.startsWith('merge-') ? MERGE_GATE : CODE_GATE;
		assertExact(job.if, expected, `${jobId} change gate`);
	}
}

function assertSummary(finalTest) {
	assertExact(finalTest.if, expression('always()'), 'test summary condition');
	assertList(finalTest.needs, SUMMARY_NEEDS, 'test.needs');
	const steps = stepsOf(finalTest, 'test');
	assertExact(steps.length, 1, 'test summary step count');
	const verify = findStep(steps, 'Verify every gated job reported', 'test');
	const env = asRecord(verify.env, 'test summary env');
	assertExact(
		env.CODE_CHANGED,
		expression('needs.changes.outputs.code'),
		'test summary code input',
	);
	// A result this step never reads is a job whose failure it cannot see.
	for (const jobId of SUMMARY_NEEDS) {
		const reference = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(jobId)
			? `needs.${jobId}.result`
			: `needs['${jobId}'].result`;
		assertIncludes(
			String(env.RESULTS),
			`${jobId}=${expression(reference)}`,
			'test summary results',
		);
	}
	assertIncludes(
		String(verify.run),
		`if [ -n "${shellVar('failed')}" ]; then`,
		'test summary failure branch',
	);
	assertIncludes(
		String(verify.run),
		`if [ "${shellVar('CODE_CHANGED')}" = "true" ]; then`,
		'test summary code branch',
	);
	assertIncludes(
		String(verify.run),
		`echo "::error::code changed but these jobs skipped:${shellVar('skipped')}"`,
		'test summary unexplained-skip branch',
	);
}

function assertFrontendShards(frontendTest, mergeFe, guardrails) {
	assertExact(frontendTest.name, `FE unit shard ${FE_SHARD_SPEC}`, 'test-fe job name');
	assertExact(frontendTest['timeout-minutes'], 15, 'test-fe timeout');
	const strategy = asRecord(frontendTest.strategy, 'test-fe.strategy');
	assertExact(strategy['fail-fast'], false, 'test-fe fail-fast');
	assertList(
		asRecord(strategy.matrix, 'test-fe.strategy.matrix').shard,
		FE_SHARDS,
		'test-fe matrix.shard',
	);
	assertExact(
		asRecord(frontendTest.env, 'test-fe.env').VITEST_SHARD,
		FE_SHARD_SPEC,
		'test-fe VITEST_SHARD',
	);

	const feSteps = stepsOf(frontendTest, 'test-fe');
	const unit = findStep(feSteps, 'Unit tests (vitest shard)', 'test-fe');
	assertExact(unit.run, 'bun run --filter frontend test:ci-shard', 'test-fe shard command');

	// A blob written under a dot-directory is invisible to upload-artifact without
	// `include-hidden-files`, and a silently empty upload would shrink the merged
	// report while every job stayed green — so both flags are asserted, not assumed.
	const upload = findStep(feSteps, 'Upload vitest blob report', 'test-fe');
	assertExact(upload.uses, 'actions/upload-artifact@v7', 'test-fe blob upload action');
	assertExact(upload.if, expression('!cancelled()'), 'test-fe blob upload condition');
	const uploadWith = withValues(upload, 'test-fe blob upload');
	assertExact(uploadWith.name, FE_BLOB_ARTIFACT, 'test-fe blob artifact name');
	assertExact(uploadWith.path, `CeraUI/${FE_BLOB_DIR}`, 'test-fe blob artifact path');
	assertExact(uploadWith['include-hidden-files'], true, 'test-fe blob hidden files');
	assertExact(uploadWith['if-no-files-found'], 'error', 'test-fe blob missing-file policy');
	assertExact(uploadWith['retention-days'], 1, 'test-fe blob artifact retention');

	assertList(mergeFe.needs, ['changes', 'test-fe'], 'merge-fe-reports.needs');
	const mergeSteps = stepsOf(mergeFe, 'merge-fe-reports');
	const download = findStep(mergeSteps, 'Download vitest blob reports', 'merge-fe-reports');
	assertExact(download.uses, 'actions/download-artifact@v8', 'merge-fe-reports download action');
	const downloadWith = withValues(download, 'merge-fe-reports download');
	assertExact(downloadWith.pattern, 'vitest-blob-*', 'merge-fe-reports download pattern');
	assertExact(downloadWith['merge-multiple'], true, 'merge-fe-reports merge-multiple');
	assertExact(downloadWith.path, `CeraUI/${FE_BLOB_DIR}`, 'merge-fe-reports download path');
	assertExact(
		findStep(mergeSteps, 'Merge vitest reports', 'merge-fe-reports').run,
		'bun run --filter frontend test:ci-merge',
		'merge-fe-reports merge command',
	);

	// Every guardrail the pre-shard `test-fe` owned has to survive the split; the
	// preflight in particular is no longer chained by any command CI runs.
	const guardSteps = stepsOf(guardrails, 'guardrails');
	assertExact(
		findStep(guardSteps, 'Build Check workflow shape gate', 'guardrails').run,
		'bun run test:build-check-shape',
		'shape gate command',
	);
	assertExact(
		findStep(guardSteps, 'Input-picker hardware preflight', 'guardrails').run,
		'bun run --filter frontend test:hardware-preflight',
		'guardrails hardware preflight command',
	);
	assertExact(
		findStep(
			guardSteps,
			'Tech-debt register gate (validator unit tests + live register check)',
			'guardrails',
		)['working-directory'],
		'CeraUI',
		'guardrails tech-debt working directory',
	);
	// Matched on the grep they run, not on their step names: the `#nav-tab-` step's
	// unquoted name is truncated at the `#` by YAML, so a name match would encode
	// that accident as the contract.
	for (const [pattern, label] of [
		['page\\.screenshot\\(|toHaveScreenshot\\(', 'screenshot'],
		['waitForTimeout|page\\.waitFor\\(', 'waitForTimeout'],
		['#nav-tab-', 'nav-tab selector'],
	]) {
		const matches = guardSteps.filter((step) => String(step.run ?? '').includes(pattern));
		assertExact(matches.length, 1, `guardrails ${label} guard step count`);
	}
}

export function assertBuildCheckContract(source) {
	let document;
	try {
		document = YAML.parse(source);
	} catch (error) {
		fail(`build-check workflow must be valid YAML: ${String(error)}`);
	}

	const root = asRecord(document, 'workflow');
	const jobs = asRecord(root.jobs, 'workflow.jobs');
	const setup = asRecord(jobs['setup-e2e'], 'setup-e2e');
	const e2e = asRecord(jobs['test-e2e'], 'test-e2e');
	const merge = asRecord(jobs['merge-e2e-reports'], 'merge-e2e-reports');
	const finalTest = asRecord(jobs.test, 'test');
	const frontendTest = asRecord(jobs['test-fe'], 'test-fe');
	const mergeFrontend = asRecord(jobs['merge-fe-reports'], 'merge-fe-reports');
	const guardrails = asRecord(jobs.guardrails, 'guardrails');
	const backendTest = asRecord(jobs['test-be'], 'test-be');
	const setupSteps = stepsOf(setup, 'setup-e2e');
	const e2eSteps = stepsOf(e2e, 'test-e2e');
	const backendSteps = stepsOf(backendTest, 'test-be');

	assertList(e2e.needs, ['changes', 'setup-e2e'], 'test-e2e.needs');
	const matrix = asRecord(
		asRecord(e2e.strategy, 'test-e2e.strategy').matrix,
		'test-e2e.strategy.matrix',
	);
	assertList(matrix.project, ['desktop', 'mobile'], 'test-e2e matrix.project');
	assertList(matrix.shard, [1, 2], 'test-e2e matrix.shard');

	const setupDeps = setupSteps.filter((step) =>
		String(step.run ?? '').includes('test:e2e:install-deps'),
	);
	assertExact(setupDeps.length, 0, 'setup-e2e install-deps step count');
	const laneDeps = e2eSteps.filter((step) =>
		String(step.run ?? '').includes('test:e2e:install-deps'),
	);
	assertExact(laneDeps.length, 1, 'test-e2e install-deps step count');
	assertExact(laneDeps[0].if, undefined, 'test-e2e install-deps condition');
	assertBrowserCache(setupSteps, 'setup-e2e');
	assertBrowserCache(e2eSteps, 'test-e2e');
	assertSrtlaRuntime(setupSteps, e2eSteps);
	const startServers = findStep(e2eSteps, 'Start E2E servers', 'test-e2e');
	const seedAuth = findStep(e2eSteps, 'Seed E2E auth state', 'test-e2e');
	assertExact(
		seedAuth.run,
		'E2E_PASSWORD=12345678 bun run scripts/ci/seed-e2e-auth.ts',
		'test-e2e auth seed command',
	);
	assertStepOrder(e2eSteps, 'Seed E2E auth state', 'Start E2E servers', 'test-e2e');
	assertIncludes(
		startServers.run,
		'bun run --filter frontend preview -- --host 127.0.0.1 --port 6173',
		'test-e2e frontend production preview command',
	);
	if (String(startServers.run).includes('bun run --filter frontend dev')) {
		fail('test-e2e frontend startup must not use the Vite dev server');
	}

	const frontendDownload = findStep(e2eSteps, 'Download frontend dist', 'test-e2e');
	assertExact(
		frontendDownload.uses,
		'actions/download-artifact@v8',
		'test-e2e frontend download action',
	);
	const serviceContract = findStep(backendSteps, 'Mock device attach service contract', 'test-be');
	assertExact(
		serviceContract.run,
		'bun run test:service-contract',
		'test-be service contract command',
	);

	const functional = findStep(
		e2eSteps,
		'Functional E2E (screenshot-free, no @visual, a11y gated separately)',
		'test-e2e',
	);
	assertIncludes(functional.run, `--project=${matrixProject}`, 'functional project');
	assertIncludes(functional.run, `--shard=${matrixShard}/${totalShards}`, 'functional shard');
	assertIncludes(functional.run, '--reporter=line,json,blob', 'functional reporters');
	const functionalEnv = asRecord(functional.env, 'functional env');
	assertExact(
		functionalEnv.PLAYWRIGHT_BLOB_OUTPUT_DIR,
		`test-results/blob-report-e2e-${matrixProject}-${matrixShard}`,
		'functional blob output directory',
	);

	const blobUpload = findStep(e2eSteps, 'Upload E2E blob report', 'test-e2e');
	assertExact(blobUpload.uses, 'actions/upload-artifact@v7', 'blob upload action');
	const blobWith = withValues(blobUpload, 'blob upload');
	assertExact(
		blobWith.name,
		`blob-report-${matrixProject}-${matrixShard}`,
		'functional blob artifact name',
	);
	assertExact(
		blobWith.path,
		`CeraUI/apps/frontend/test-results/blob-report-e2e-${matrixProject}-${matrixShard}`,
		'functional blob artifact path',
	);

	assertList(merge.needs, ['changes', 'test-e2e'], 'merge-e2e-reports.needs');
	const download = findStep(
		stepsOf(merge, 'merge-e2e-reports'),
		'Download blob reports',
		'merge-e2e-reports',
	);
	assertExact(download.uses, 'actions/download-artifact@v8', 'blob download action');
	const downloadWith = withValues(download, 'blob download');
	assertExact(downloadWith.pattern, 'blob-report-*', 'blob download pattern');
	assertExact(downloadWith['merge-multiple'], true, 'blob download merge-multiple');

	assertChangesGate(jobs);
	assertGatedJobs(jobs);
	assertSummary(finalTest);
	assertFrontendShards(frontendTest, mergeFrontend, guardrails);
	return root;
}

if (import.meta.main) {
	const target =
		process.argv[2] ?? new URL('../../.github/workflows/build-check.yml', import.meta.url);
	assertBuildCheckContract(await file(target).text());
	process.stdout.write(`PASS: semantic Build Check contract (${String(target)})\n`);
}
