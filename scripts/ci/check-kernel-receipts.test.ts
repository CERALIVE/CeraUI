import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import suites from '../../apps/backend/src/tests/kernel-suites.json';
import { checkInputs, checkReport, checkReportFile } from './check-kernel-receipts';

const file = 'uplink-steering-route-kernel.test.ts';
const scenarios = suites[file];
const testcase = (name: string, status = '') => `<testcase name="${name}">${status}</testcase>`;
const nested = `<testsuite name="describe" file="src/tests/${file}" tests="7">${scenarios.map((name) => testcase(name)).join('')}</testsuite>`;
const suite = `<testsuite name="src/tests/${file}" file="src/tests/${file}" tests="8" skipped="0" failures="0">${nested}${testcase('kernel scenario receipt set')}</testsuite>`;
const additionalSuites = Object.entries(suites)
	.filter(([name]) => name !== file)
	.map(
		([name, scenarios]) =>
			`<testsuite name="src/tests/${name}" file="src/tests/${name}" tests="${scenarios.length + 1}" skipped="0" failures="0">${scenarios.map((name) => testcase(name)).join('')}${testcase('kernel scenario receipt set')}</testsuite>`,
	)
	.join('');
const report = `<testsuites>${suite}${additionalSuites}</testsuites>`;

test('counts descendant cases once in Bun nested suites', () => {
	expect(checkReport(report)).toEqual({
		kernel_files: 3,
		testcases: 24,
		skips: 0,
		receipts: 21,
	});
});

test.each([
	['missing file', '<testsuites/>'],
	['duplicate file', `<testsuites>${suite}${suite}</testsuites>`],
	['skipped case', report.replace('</testcase>', '<skipped/></testcase>')],
	['failed case', report.replace('</testcase>', '<failure/></testcase>')],
	['error case', report.replace('</testcase>', '<error/></testcase>')],
	['missing receipt set', report.replace(testcase('kernel scenario receipt set'), '')],
	['wrong scenario', report.replace(scenarios[0] ?? '', 'unexpected scenario')],
	['declared skip', report.replace('skipped="0"', 'skipped="1"')],
	['declared count', report.replace('tests="8"', 'tests="9"')],
	['corrupt XML', '<testsuites>'],
	['empty report', ''],
	['non XML', 'not a report'],
])('rejects %s', (_name, xml) => {
	expect(() => checkReport(xml)).toThrow();
});

test('permits deliberate skips outside the kernel manifest', () => {
	expect(
		checkReport(
			report.replace(
				'</testsuites>',
				'<testsuite name="statistics" skipped="1"><testcase><skipped/></testcase></testsuite></testsuites>',
			),
		).skips,
	).toBe(0);
});

test('accepts compiler input containing every manifest file', () => {
	expect(() =>
		checkInputs(
			Object.keys(suites)
				.map((file) => resolve(import.meta.dir, '../../apps/backend/src/tests', file))
				.join('\n'),
		),
	).not.toThrow();
});

test.each(['', '/unrelated/input.ts'])('rejects absent compiler inputs: %s', (input) => {
	expect(() => checkInputs(input)).toThrow();
});

test('missing report file fails the report gate', async () => {
	await expect(checkReportFile('/nonexistent/kernel-junit.xml')).rejects.toThrow('ENOENT');
});
