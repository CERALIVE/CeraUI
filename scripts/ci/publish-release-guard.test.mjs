import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
				job.steps.some(publishes) &&
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
				'#!/bin/bash\nset -eu\nrm -rf dist\nmkdir -p dist/debian\ncp "ceralive-device_${BUILD_ARCH}.deb" dist/debian/\n',
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
