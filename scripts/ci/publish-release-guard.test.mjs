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

function waitsForCommitApproval(name, seen = new Set()) {
	if (name === gate) return true;
	if (seen.has(name)) return false;
	seen.add(name);
	const job = workflow.jobs[name];
	if (!job || /\b(?:always|failure|cancelled)\s*\(/.test(job.if ?? '')) return false;
	return [job.needs ?? []].flat().some((need) => waitsForCommitApproval(need, seen));
}

test('release publishers and artifact uploads wait for successful commit approval', () => {
	const publishers = Object.entries(workflow.jobs).filter(([, job]) =>
		job.steps.some(
			(step) =>
				/^(actions\/upload-artifact|softprops\/action-gh-release|peter-evans\/repository-dispatch)@/.test(
					step.uses ?? '',
				) || step.run?.includes('publish-federation-immutable.sh'),
		),
	);
	expect(publishers.map(([name]) => name)).toEqual(
		expect.arrayContaining(['publish-federation', 'create-release', 'dispatch-apt-reindex']),
	);
	for (const [name] of publishers) {
		expect(name).not.toBe(gate);
		expect(waitsForCommitApproval(name), `${name} must wait for ${gate}`).toBe(true);
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

const debJob = workflow.jobs['build-debian-package'];
const floorStep = debJob.steps.find((step) => step.name === 'Verify Debian package systemd floor');

test('both Debian release builds must verify the package before upload', () => {
	const build = debJob.steps.findIndex(
		(step) => step.run === './scripts/build/build-debian-package.sh',
	);
	const verify = debJob.steps.indexOf(floorStep);
	const upload = debJob.steps.findIndex((step) =>
		step.uses?.startsWith('actions/upload-artifact@'),
	);
	expect(build).toBeGreaterThanOrEqual(0);
	expect(verify).toBeGreaterThan(build);
	expect(upload).toBeGreaterThan(verify);
	expect(debJob.strategy.matrix.architecture).toEqual(['arm64', 'amd64']);
	expect(floorStep['working-directory']).toBe(debJob.steps[build]['working-directory']);
	expect(floorStep.if).toBeUndefined();
	expect(floorStep['continue-on-error']).toBeUndefined();
	expect(debJob['continue-on-error']).toBeUndefined();
	expect(workflow.jobs['create-release'].needs).toContain('build-debian-package');
	expect(workflow.jobs['dispatch-apt-reindex'].needs).toContain('create-release');
});

test.each([
	['the required floor', 'udev, systemd (>= 257), gpgv', 0],
	['an unversioned dependency', 'systemd, udev', 1],
	['a lower floor', 'systemd (>= 256), udev', 1],
	['an optional alternative', 'systemd (>= 257) | sysvinit-core, udev', 1],
	['no package', null, 1],
])('the pre-upload guard handles %s', async (_label, depends, status) => {
	expect(floorStep).toBeDefined();
	const work = mkdtempSync(join(tmpdir(), 'release-deb-floor-'));
	try {
		mkdirSync(join(work, 'dist/debian'), { recursive: true });
		if (depends !== null) {
			const controlDir = join(work, 'fixture/DEBIAN');
			mkdirSync(controlDir, { recursive: true });
			chmodSync(controlDir, 0o755);
			await write(
				join(controlDir, 'control'),
				`Package: ceralive-device\nVersion: 0.0.0\nArchitecture: all\nMaintainer: Contract <contract@ceralive.tv>\nDescription: Release contract fixture\nDepends: ${depends}\n`,
			);
			const build = spawnSync(
				['dpkg-deb', '--build', 'fixture', 'dist/debian/ceralive-device.deb'],
				{ cwd: work },
			);
			expect(build.exitCode, build.stderr.toString()).toBe(0);
		}

		const verify = spawnSync(['bash', '-e', '-c', floorStep.run], { cwd: work });
		expect(verify.exitCode, verify.stderr.toString()).toBe(status);
		if (depends !== null && status !== 0) {
			expect(verify.stdout.toString()).toContain('must depend on systemd (>= 257)');
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});
