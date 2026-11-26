import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { file, spawnSync, write, YAML } from 'bun';

const workflow = YAML.parse(
	await file(new URL('../../.github/workflows/publish-release.yml', import.meta.url)).text(),
);
const gate = 'calculate-version';
const steps = workflow.jobs[gate].steps;
const guardName = 'Verify approved commit';
const expression = (body) => `${'$' + '{{'} ${body} }}`;
const approvalInput = expression('inputs.approved_sha');
const eventCommit = expression('github.sha');

const preflight = 'prepare-release-body';
const preflightSteps = workflow.jobs[preflight].steps;
const bodyStep = preflightSteps.find((step) => step.name === 'Generate and validate release body');

test('release reads the validated artifact without generating notes again', () => {
	const checkout = preflightSteps.find((step) => step.uses?.startsWith('actions/checkout@'));
	const store = preflightSteps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
	const releaseSteps = workflow.jobs['create-release'].steps;
	const download = releaseSteps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
	const publish = releaseSteps.find((step) =>
		step.uses?.startsWith('softprops/action-gh-release@'),
	);
	expect(checkout.with).toMatchObject({ 'fetch-depth': 0, 'persist-credentials': false });
	expect(bodyStep.env.RELEASE_NOTES).toBe(expression('github.event.inputs.release_notes'));
	expect(bodyStep.env.GH_TOKEN).toBe(expression('github.token'));
	expect(preflightSteps.indexOf(store)).toBeGreaterThan(preflightSteps.indexOf(bodyStep));
	expect(requiresSuccess(bodyStep)).toBe(true);
	expect(requiresSuccess(store)).toBe(true);
	expect(store.with['if-no-files-found']).toBe('error');
	expect(releaseSteps.indexOf(download)).toBeLessThan(releaseSteps.indexOf(publish));
	expect(download.with['merge-multiple']).not.toBe(true);
	expect(publish.with.body_path).toBe(
		`${download.with.path}/${store.with.name}/${store.with.path}`,
	);
	expect(releaseSteps.some((step) => step.env?.RELEASE_NOTES)).toBe(false);
});

const maintainerNotes =
	'The audio meter now follows the running source.\n\n- Keeps idle HDMI quiet.';
const mergedPrs = [
	"## What's Changed",
	'* Keep the audio meter on its running source by @contributor in https://github.com/CERALIVE/CeraUI/pull/683',
	'* Keep idle HDMI quiet by @contributor in https://github.com/CERALIVE/CeraUI/pull/680',
].join('\n');
const noMergedPrs =
	'**Full Changelog**: https://github.com/CERALIVE/CeraUI/compare/v2026.11.3...v2026.11.4';
const dependencyTree = '```\nfixture-package\n└── Depends: fixture-library\n```\n';
const specialNotes = [
	'Literal `backticks`, $(touch must-not-run), "quotes", \'apostrophes\' and &lt;details>.',
	'',
	'````bash',
	'```',
	'`````',
	'',
	'~~~text',
	'code',
	'~~~~',
	'',
].join('\n');

async function runBody(input, { prNotes, firstRelease = false } = {}) {
	const work = mkdtempSync(join(tmpdir(), 'release-body-'));
	try {
		const env = {
			...process.env,
			GIT_MASTER: '1',
			GITHUB_REPOSITORY: 'CERALIVE/CeraUI',
			GIT_AUTHOR_NAME: 'Fixture',
			GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
			GIT_COMMITTER_NAME: 'Fixture',
			GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
			IS_BETA: 'false',
			RELEASE_NOTES: input,
			TAG: 'v2026.11.4',
			VERSION: '2026.11.4',
			PR_NOTES: prNotes ?? 'unexpected',
			PR_ENVELOPE: JSON.stringify({ name: 'v2026.11.4', body: prNotes }),
			FIRST_RELEASE: String(firstRelease),
		};
		const git = (...args) => {
			const result = spawnSync(['git', '-c', 'core.hooksPath=/dev/null', ...args], {
				cwd: work,
				env,
				stdin: 'ignore',
			});
			expect(result.exitCode, result.stderr.toString()).toBe(0);
			return result.stdout.toString().trim();
		};
		git('init', '-q');
		const commit = (message) =>
			git('commit', '--no-gpg-sign', '-q', '--allow-empty', '-m', message);
		commit('previous release');
		if (!firstRelease) git('tag', 'v2026.11.3');
		commit('non-release tags');
		git('tag', 'kernel/test');
		git('tag', 'v2026.11.keep');
		commit('release target');
		const sha = git('rev-parse', 'HEAD');
		commit('later checkout');
		git('tag', 'v2026.11.5');
		mkdirSync(join(work, 'scripts/ci'), { recursive: true });
		symlinkSync(
			fileURLToPath(new URL('./release-body.mjs', import.meta.url)),
			join(work, 'scripts/ci/release-body.mjs'),
		);
		await write(join(work, 'scripts/ci/release-dependencies.md'), dependencyTree);
		const gh = join(work, 'gh');
		await write(
			gh,
			`#!/usr/bin/env bash
set -eu
if [[ "$PR_NOTES" == unexpected ]]; then exit 1; fi
if [[ "$PR_NOTES" == unavailable ]]; then exit 22; fi
declare -A fields
endpoint=""
projected=false
[[ "$1" == api ]]
shift
while (( $# > 0 )); do
  case "$1" in
    -f) fields["\${2%%=*}"]="\${2#*=}"; shift 2 ;;
    --method) [[ "$2" == POST ]]; shift 2 ;;
    --jq) [[ "$2" == .body ]]; projected=true; shift 2 ;;
    *) endpoint="$1"; shift ;;
  esac
done
[[ "$endpoint" == repos/CERALIVE/CeraUI/releases/generate-notes ]]
[[ "\${fields[tag_name]}" == v2026.11.4 && "\${fields[target_commitish]}" == "$GITHUB_SHA" ]]
if [[ "$FIRST_RELEASE" == true ]]; then
  [[ ! -v "fields[previous_tag_name]" ]]
else
  [[ "\${fields[previous_tag_name]}" == v2026.11.3 ]]
fi
if [[ "$projected" == true ]]; then
  printf '%s\\n' "$PR_NOTES"
else
  printf '%s\\n' "$PR_ENVELOPE"
fi
`,
		);
		chmodSync(gh, 0o755);

		const result = spawnSync(['bash', '-e', '-c', bodyStep.run], {
			cwd: work,
			env: { ...env, GITHUB_SHA: sha, PATH: `${work}:${env.PATH}` },
			stdin: 'ignore',
		});
		const output = file(join(work, 'release-body.md'));
		expect(await file(join(work, 'must-not-run')).exists()).toBe(false);
		return {
			code: result.exitCode,
			error: result.stderr.toString(),
			body: (await output.exists()) ? await output.text() : null,
		};
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

test.each([
	['maintainer notes', maintainerNotes, {}, `## 📝 Release Notes\n\n${maintainerNotes}`],
	['special characters', specialNotes, {}, `## 📝 Release Notes\n\n${specialNotes}`],
	['empty input', '', { prNotes: mergedPrs }, mergedPrs],
	['blank input', ' \t\n', { prNotes: mergedPrs }, mergedPrs],
	['first release', '', { prNotes: mergedPrs, firstRelease: true }, mergedPrs],
	[
		'no merged PRs',
		'',
		{ prNotes: noMergedPrs },
		`## What's Changed\n\nNo merged pull requests in this release range.\n\n${noMergedPrs}`,
	],
])('release body with %s leads with changes', async (_label, input, options, description) => {
	const { body, code, error } = await runBody(input, options);
	expect(code, error).toBe(0);
	expect(body.startsWith(`# CeraUI v2026.11.4\n\n${description}\n\n`)).toBe(true);
	const [intro, inventory] = body.split('<details>\n<summary>Dependencies</summary>\n\n');
	expect(intro).not.toContain('## 📦 Downloads');
	expect(inventory).toContain('## 📦 Downloads\n\n');
	expect(inventory).toEndWith(`\n${dependencyTree}\n</details>\n`);
});

test.each([
	['an opening tag', '<details>', 1],
	['a closing tag', 'Intro\r\n\r\n</DETAILS >', 3],
	['a nonbreaking space before a fence', '<details\u00a0example>\n~~~html\n<DeTaIlS>\n~~~', 1],
	['a tag inside a fence', '~~~html\n<details>\n~~~', 2],
	['a tag inside inline code', 'Example `<details>`', 1],
])('preflight rejects %s and reports its notes line', async (_label, notes, line) => {
	const { body, code, error } = await runBody(notes);
	expect(code).toBe(1);
	expect(error).toContain(`release_notes line ${line}: <details> tags are reserved`);
	expect(body).toBeNull();
});

test.each([
	['three backticks', '```\nunterminated'],
	['four backticks with a shorter closer', '````\nunterminated\n```'],
	['tildes with a backtick closer', '~~~\nunterminated\n````'],
	['a closer with trailing text', '```\nunterminated\n``` not a closer'],
	['an open HTML comment', '<!-- unterminated'],
])('preflight refuses to write a body with %s', async (_label, notes) => {
	const { body, code, error } = await runBody(notes);
	expect(code).toBe(1);
	expect(error).toContain('unclosed code fence or HTML block');
	expect(body).toBeNull();
});

test('the complete Markdown is limited to 120000 UTF-16 code units, not bytes', async () => {
	const baseline = await runBody('x');
	expect(baseline.code, baseline.error).toBe(0);
	const notes = 'é'.repeat(5_000) + 'x'.repeat(115_001 - baseline.body.length);
	const exact = await runBody(notes);
	expect(exact.code, exact.error).toBe(0);
	expect(exact.body).toHaveLength(120_000);
	const tooLong = await runBody(`${notes}é`);
	expect(tooLong.code).toBe(1);
	expect(tooLong.error).toContain('exceeds 120000 UTF-16 code units');
	expect(tooLong.body).toBeNull();
});

test('astral characters count as two UTF-16 code units against the full body limit', async () => {
	const baseline = await runBody('x');
	expect(baseline.code, baseline.error).toBe(0);
	const notes = '🚀'.repeat(5_000) + 'x'.repeat(110_001 - baseline.body.length);
	const exact = await runBody(notes);
	expect(exact.code, exact.error).toBe(0);
	expect(exact.body).toHaveLength(120_000);
	expect(exact.body).toEndWith(`\n${dependencyTree}\n</details>\n`);
	const tooLong = await runBody(`${notes}x`);
	expect(tooLong.code).toBe(1);
	expect(tooLong.error).toContain('exceeds 120000');
	expect(tooLong.body).toBeNull();
});

test('a failed GitHub notes lookup produces no body', async () => {
	const { body, code, error } = await runBody('', { prNotes: 'unavailable' });
	expect(code).toBe(1);
	expect(error).toContain('Could not generate merged PR release notes from GitHub');
	expect(body).toBeNull();
});

test('dispatch accepts an optional approved commit', () => {
	expect(workflow.on.workflow_dispatch.inputs.approved_sha).toMatchObject({
		required: false,
		type: 'string',
	});
});

test('commit approval is checked unconditionally after branch admission and before checkout', () => {
	const branch = steps.findIndex((step) => step.name === 'Verify default-branch dispatch');
	const guard = steps.findIndex((step) => step.name === guardName);
	const checkout = steps.findIndex((step) => step.uses?.startsWith('actions/checkout@'));
	expect(branch).toBeGreaterThanOrEqual(0);
	expect(guard).toBe(branch + 1);
	expect(checkout).toBeGreaterThan(guard);
	expect(steps[guard].if).toBeUndefined();
	expect(steps[guard]['continue-on-error']).toBeUndefined();
	expect(workflow.jobs[gate]['continue-on-error']).toBeUndefined();
});

function requiresSuccess(node) {
	return !node['continue-on-error'] && !/\b(?:always|failure|cancelled)\s*\(/.test(node.if ?? '');
}

function waitsForSuccessfulJob(jobs, name, prerequisite, seen = new Set()) {
	if (seen.has(name)) return false;
	seen.add(name);
	const job = jobs[name];
	if (!job || !requiresSuccess(job)) return false;
	if (name === prerequisite) return true;
	return [job.needs ?? []]
		.flat()
		.some((need) => waitsForSuccessfulJob(jobs, need, prerequisite, seen));
}

function publishes(step) {
	return (
		/^(actions\/(?:upload-artifact|cache(?:\/save)?)|softprops\/action-gh-release|peter-evans\/repository-dispatch)@/.test(
			step.uses ?? '',
		) ||
		(step.uses?.startsWith('oven-sh/setup-bun@') && step.with?.['no-cache'] !== true) ||
		/\b(?:publish-federation-immutable\.sh|GITHUB_STEP_SUMMARY|git (?:push|tag -a)|gh release (?:create|upload))\b/.test(
			step.run ?? '',
		)
	);
}

test('release publishers and artifact uploads wait for successful commit approval', () => {
	const publishers = Object.entries(workflow.jobs).filter(([, job]) => job.steps.some(publishes));
	expect(publishers.map(([name]) => name)).toEqual(
		expect.arrayContaining(['publish-federation', 'create-release', 'dispatch-apt-reindex']),
	);
	for (const [name] of publishers) {
		expect(name).not.toBe(gate);
		expect(waitsForSuccessfulJob(workflow.jobs, name, gate), `${name} must wait for ${gate}`).toBe(
			true,
		);
	}
});

test('every publisher waits for validated notes before uploading or dispatching', () => {
	expect([workflow.jobs['release-package-contracts'].needs].flat()).toContain(gate);
	const publishers = Object.entries(workflow.jobs).filter(
		([name, job]) => name !== preflight && job.steps.some(publishes),
	);
	expect(publishers.map(([name]) => name)).toEqual(
		expect.arrayContaining([
			'build-debian-package',
			'build-ceraui-system',
			'publish-federation',
			'create-release',
			'dispatch-apt-reindex',
		]),
	);
	for (const [name] of publishers) {
		expect(waitsForSuccessfulJob(workflow.jobs, name, preflight), name).toBe(true);
	}
});

test('release tests built federation assets before signing', () => {
	const federation = workflow.jobs['publish-federation'].steps;
	const build = federation.findIndex((step) => step.run === 'bun run build:federation');
	const assets = federation.findIndex(
		(step) => step.run === 'bun test ./scripts/federation-assets.test.mjs',
	);
	const sign = federation.findIndex((step) => step.run === 'bun run sign:federation');
	expect(build).toBeGreaterThanOrEqual(0);
	expect(assets).toBeGreaterThan(build);
	expect(sign).toBeGreaterThan(assets);
	expect(federation[assets].if).toBeUndefined();
	expect(federation[assets]['continue-on-error']).toBeUndefined();
});

const releaseTestSteps = workflow.jobs['release-package-contracts'].steps;
const backendUnitIndex = releaseTestSteps.findIndex((step) =>
	step.run?.split('\n').includes('bun run --filter backend test'),
);

test('release enables unprivileged namespaces before package and backend contracts', () => {
	const enable = releaseTestSteps.findIndex(
		(step) => step.run === 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
	);
	const packages = releaseTestSteps.findIndex(
		(step) => step.run === 'bun run test:release-package-contracts',
	);
	expect(enable).toBeGreaterThanOrEqual(0);
	expect(packages).toBeGreaterThan(enable);
	expect(backendUnitIndex).toBeGreaterThan(enable);
	expect(releaseTestSteps[enable].if).toBeUndefined();
	expect(releaseTestSteps[enable]['continue-on-error']).toBeUndefined();
});

const buildCheck = YAML.parse(
	await file(new URL('../../.github/workflows/build-check.yml', import.meta.url)).text(),
);

test.each([
	['Prepare pinned srtla-send runtime', 'before'],
	['Export the live sender binary', 'before'],
	['netns-semantics (isolated — statistical assertions need CPU headroom)', 'after'],
	['update UID routing (rootful netns)', 'after'],
])('release runs %s %s bundled backend tests, as in Build Check', (name, order) => {
	const reference = buildCheck.jobs['test-be'].steps.find((step) => step.name === name);
	const index = releaseTestSteps.findIndex((step) => step.name === name);
	expect(reference).toBeDefined();
	expect(index).toBeGreaterThanOrEqual(0);
	expect(backendUnitIndex).toBeGreaterThanOrEqual(0);
	expect(releaseTestSteps[index]).toEqual(reference);
	expect(order === 'before' ? index < backendUnitIndex : index > backendUnitIndex).toBe(true);
});

const eventSha = 'a'.repeat(40);
test.each([
	['matching SHA', eventSha, 0],
	['empty approval', '', 0],
	['different SHA', 'b'.repeat(40), 1],
	['shell wildcard', '*', 1],
])('the dispatched guard handles %s', (_label, approvedSha, status) => {
	const guard = steps.find((step) => step.name === guardName);
	expect(guard?.env?.APPROVED_SHA).toBe(approvalInput);
	expect(guard.env.GITHUB_SHA).toBe(eventCommit);
	expect(guard.run).not.toMatch(/\$\{\{\s*inputs\.approved_sha\s*\}\}/);

	const contexts = {
		[approvalInput]: approvedSha,
		[eventCommit]: eventSha,
	};
	const env = Object.fromEntries(
		Object.entries(guard.env).map(([name, context]) => [name, contexts[context]]),
	);
	const result = spawnSync(['bash', '-e', '-c', guard.run], { env, stdin: 'ignore' });
	expect(result.exitCode, result.stderr.toString()).toBe(status);
	if (status === 1) {
		expect(result.stdout.toString().trimEnd()).toBe(
			`::error::release commit ${eventSha} is not the approved ${approvedSha}`,
		);
	}
});

const debJobId = 'build-debian-package';
const debJob = workflow.jobs[debJobId];
const buildStep = debJob.steps.find((step) => step.id === 'build-debs');
const floorStep = debJob.steps.find((step) => step.id === 'verify-debs');

test('no release publication can bypass the Debian verification job', () => {
	const ungatedPublishers = Object.entries(workflow.jobs)
		.filter(
			([name, job]) =>
				name !== debJobId &&
				job.steps.some(
					(step) =>
						publishes(step) &&
						!(
							name === preflight &&
							step.uses?.startsWith('actions/upload-artifact@') &&
							step.with?.path === 'release-body.md'
						),
				) &&
				!waitsForSuccessfulJob(workflow.jobs, name, debJobId),
		)
		.map(([name]) => name);
	expect(ungatedPublishers).toEqual([]);
});

test('the Debian job must build and verify both packages before any upload or cache save', () => {
	const build = debJob.steps.indexOf(buildStep);
	const verify = debJob.steps.indexOf(floorStep);
	const upload = debJob.steps.findIndex((step) =>
		step.uses?.startsWith('actions/upload-artifact@'),
	);
	expect(build).toBeGreaterThanOrEqual(0);
	expect(verify).toBeGreaterThan(build);
	expect(upload).toBeGreaterThan(verify);
	expect(debJob.strategy?.matrix).toBeUndefined();
	expect(floorStep['working-directory']).toBe(buildStep['working-directory']);
	expect(requiresSuccess(buildStep)).toBe(true);
	expect(floorStep.if).toBeUndefined();
	expect(floorStep['continue-on-error']).toBeUndefined();
	expect(debJob['continue-on-error']).toBeUndefined();
	for (const [index, step] of debJob.steps.entries()) {
		if (!publishes(step)) continue;
		expect(index).toBeGreaterThan(verify);
		expect(requiresSuccess(step), `${step.uses ?? step.id} must honor a failed floor check`).toBe(
			true,
		);
	}
	expect(workflow.jobs['create-release'].needs).toContain('build-debian-package');
	expect(workflow.jobs['dispatch-apt-reindex'].needs).toContain('create-release');
});

test.each([
	['both floors', 'udev, systemd (>= 257), gpgv', 'systemd (>= 257), udev', 0],
	['an unversioned arm64 dependency', 'systemd, udev', 'systemd (>= 257)', 1],
	['a lower amd64 floor', 'systemd (>= 257)', 'systemd (>= 256), udev', 1],
	['an optional amd64 alternative', 'systemd (>= 257)', 'systemd (>= 257) | sysvinit-core', 1],
	['a missing amd64 package', 'systemd (>= 257)', null, 1],
])('the pre-upload guard handles %s', async (_label, armDepends, amdDepends, status) => {
	const work = mkdtempSync(join(tmpdir(), 'release-deb-floor-'));
	try {
		const env = { ...process.env, RUNNER_TEMP: work };
		for (const [arch, depends] of Object.entries({ arm64: armDepends, amd64: amdDepends })) {
			if (depends === null) continue;
			const stage = status === 0 ? work : join(work, 'ceraui-debian', arch);
			mkdirSync(stage, { recursive: true });
			const controlDir = join(work, 'fixture/DEBIAN');
			mkdirSync(controlDir, { recursive: true });
			chmodSync(controlDir, 0o755);
			await write(
				join(controlDir, 'control'),
				`Package: ceralive-device\nVersion: 0.0.0\nArchitecture: ${arch}\nMaintainer: Contract <contract@ceralive.tv>\nDescription: Release contract fixture\nDepends: ${depends}\n`,
			);
			const build = spawnSync(
				['dpkg-deb', '--build', 'fixture', join(stage, `ceralive-device_${arch}.deb`)],
				{ cwd: work },
			);
			expect(build.exitCode, build.stderr.toString()).toBe(0);
		}

		if (status === 0) {
			// Simulate the real builder's dist cleanup on each architecture.
			const builder = join(work, 'scripts/build/build-debian-package.sh');
			mkdirSync(join(work, 'scripts/build'), { recursive: true });
			await write(
				builder,
				'#!/bin/bash\nset -eu\nrm -rf dist\nmkdir -p dist/debian\ncp "ceralive-device_$BUILD_ARCH.deb" dist/debian/\n',
			);
			chmodSync(builder, 0o755);
			const build = spawnSync(['bash', '-eo', 'pipefail', '-c', buildStep.run], {
				cwd: work,
				env,
			});
			expect(build.exitCode, build.stderr.toString()).toBe(0);
		}

		const verify = spawnSync(['bash', '-eo', 'pipefail', '-c', floorStep.run], {
			cwd: work,
			env,
		});
		expect(verify.exitCode, verify.stderr.toString()).toBe(status);
		if (amdDepends === null) {
			expect(verify.stdout.toString()).toContain('Expected exactly one amd64 Debian package');
		} else if (status !== 0) {
			expect(verify.stdout.toString()).toContain('must depend on systemd (>= 257)');
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});
