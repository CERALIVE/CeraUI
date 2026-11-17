import { lstatSync } from 'node:fs';
import { file, stdin, YAML } from 'bun';

const mode = process.argv[2];
if (mode === 'existing-files') {
	for (const path of (await stdin.text()).split('\0').filter(Boolean)) {
		try {
			lstatSync(path);
		} catch (error) {
			if (
				error instanceof Error &&
				'code' in error &&
				(error.code === 'ENOENT' || error.code === 'ENOTDIR')
			) {
				continue;
			}
			throw error;
		}
		process.stdout.write(`${path}\0`);
	}
} else {
	const workflow = YAML.parse(
		await file(new URL('../../.github/workflows/build-check.yml', import.meta.url)).text(),
	);
	let value;
	switch (mode) {
		case 'image':
			value = workflow?.jobs?.['test-visual']?.container?.image;
			break;
		case 'node':
			value = workflow?.env?.NODE_VERSION;
			break;
		case 'identity':
		case 'sender': {
			const job = mode === 'identity' ? 'test-visual' : 'setup-e2e';
			const name =
				mode === 'identity' ? 'Visual rendering identity' : 'Prepare pinned srtla-send runtime';
			const matches = workflow?.jobs?.[job]?.steps?.filter((step) => step.name === name);
			if (matches?.length !== 1) throw new TypeError(`Expected exactly one workflow step: ${name}`);
			value = matches[0].run;
			break;
		}
		default:
			throw new TypeError(`Unknown visual workflow field: ${mode}`);
	}
	if (typeof value !== 'string' || value.trim() === '') {
		throw new TypeError(`Missing or malformed visual workflow field: ${mode}`);
	}
	if (
		(mode === 'image' &&
			!/^mcr\.microsoft\.com\/playwright:v\d+\.\d+\.\d+-noble@sha256:[a-f0-9]{64}$/u.test(value)) ||
		(mode === 'node' && !/^\d+$/u.test(value))
	) {
		throw new TypeError(`Malformed visual workflow field: ${mode}`);
	}
	process.stdout.write(`${value}\n`);
}
