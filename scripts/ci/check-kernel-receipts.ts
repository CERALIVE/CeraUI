import { resolve } from 'node:path';
import { file as bunFile, stdin, XML } from 'bun';
import suites from '../../apps/backend/src/tests/kernel-suites.json';

const root = resolve(import.meta.dir, '../..');
const files = Object.keys(suites);

export function checkInputs(input: string): void {
	const inputs = new Set(input.split(/\r?\n/).filter(Boolean));
	if (inputs.size === 0) throw new Error('kernel compiler input set is empty');
	for (const file of files) {
		if (!inputs.has(resolve(root, 'apps/backend/src/tests', file)))
			throw new Error(`kernel compiler input missing: ${file}`);
	}
}

function children(node: XML.Node, name: string): XML.Node[] {
	return node.children.filter(
		(child): child is XML.Node =>
			typeof child !== 'string' && 'name' in child && child.name === name,
	);
}

function testcases(suite: XML.Node): XML.Node[] {
	for (const status of ['skipped', 'failures', 'errors']) {
		if (suite.attributes[status] !== undefined && suite.attributes[status] !== '0')
			throw new Error(`kernel suite has ${status}: ${suite.attributes.name}`);
	}
	const cases = [
		...children(suite, 'testcase'),
		...children(suite, 'testsuite').flatMap(testcases),
	];
	if (Number(suite.attributes.tests) !== cases.length)
		throw new Error(`kernel suite declared count differs: ${suite.attributes.name}`);
	return cases;
}

export function checkReport(xml: string) {
	const document = XML.parse(xml, { compact: false });
	if (document.name !== 'testsuites') throw new Error('expected JUnit testsuites XML');
	let count = 0;
	let receipts = 0;
	for (const [file, scenarios] of Object.entries(suites)) {
		// Bun describe suites repeat the file attribute; only root children are file suites.
		const matches = children(document, 'testsuite').filter((suite) =>
			[suite.attributes.file, suite.attributes.name].includes(`src/tests/${file}`),
		);
		if (matches.length !== 1) throw new Error(`kernel file missing or duplicated: ${file}`);
		const suite = matches[0];
		if (suite === undefined) throw new Error(`kernel file missing: ${file}`);
		const cases = testcases(suite);
		const expected = [...scenarios, 'kernel scenario receipt set'].sort();
		if (
			cases.length !== expected.length ||
			cases
				.map((entry) => entry.attributes.name)
				.sort()
				.join('\n') !== expected.join('\n')
		)
			throw new Error(`kernel testcase set differs: ${file}`);
		for (const entry of cases) {
			if (['skipped', 'failure', 'error'].some((status) => children(entry, status).length > 0))
				throw new Error(`kernel testcase skipped or failed: ${entry.attributes.name}`);
		}
		count += cases.length;
		receipts += scenarios.length;
	}
	return { kernel_files: files.length, testcases: count, skips: 0, receipts };
}

export async function checkReportFile(path: string) {
	return checkReport(await bunFile(path).text());
}

if (import.meta.main) {
	switch (process.argv[2]) {
		case 'inputs':
			checkInputs(await stdin.text());
			break;
		case 'report':
			await checkReportFile(resolve(root, 'apps/backend/dist/backend-junit.xml'));
			break;
		default:
			throw new Error('usage: check-kernel-receipts.ts inputs|report');
	}
	// biome-ignore lint/suspicious/noConsole: CLI success receipt
	console.log('KERNEL_GATE_PASS');
}
