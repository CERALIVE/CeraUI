import { expect, test } from 'bun:test';
import { file, spawnSync, YAML } from 'bun';

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
