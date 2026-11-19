import { expect, test } from 'bun:test';
import { file, YAML } from 'bun';

const expression = (body) => `${'$' + '{{'} ${body} }}`;

test('journal conformance runs on code changes and its failures reach the required summary', async () => {
	const workflow = YAML.parse(
		await file(new URL('../../.github/workflows/build-check.yml', import.meta.url)).text(),
	);
	const job = workflow.jobs['journal-conformance'];
	expect(job).toBeDefined();
	expect(job.needs).toBe('changes');
	expect(job.if).toBe(expression("needs.changes.outputs.code == 'true'"));
	expect(job['runs-on']).toBe('ubuntu-latest');
	expect(job['timeout-minutes']).toBe(15);
	const run = job.steps.find((step) => step.name === 'Journal conformance');
	expect(run.run).toBe('bun run test:journal-conformance');
	expect(run['working-directory']).toBe('CeraUI');
	expect(run.if).toBeUndefined();
	expect(run['continue-on-error']).toBeUndefined();
	expect(workflow.jobs.test.needs).toContain('journal-conformance');
	expect(workflow.jobs.test.steps[0].env.RESULTS).toContain(
		`journal-conformance=${expression("needs['journal-conformance'].result")}`,
	);
});
