import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { YAML } from 'bun';

const root = new URL('../../', import.meta.url);
const workflow = YAML.parse(
	fs.readFileSync(new URL('.github/workflows/build-check.yml', root), 'utf8'),
);

function runWrapper(mutate, options = {}) {
	const temporary = fs.mkdtempSync(path.join(tmpdir(), 'visual-wrapper-'));
	const repository = path.join(temporary, 'repo');
	const bin = path.join(temporary, 'bin');
	fs.mkdirSync(bin);
	fs.mkdirSync(path.join(repository, 'scripts/ci'), { recursive: true });
	fs.mkdirSync(path.join(repository, '.github/workflows'), { recursive: true });
	fs.mkdirSync(path.join(repository, 'dist/public'), { recursive: true });
	fs.mkdirSync(path.join(repository, 'dist/ci-runtime/usr/bin'), { recursive: true });
	try {
		const fixture = structuredClone(workflow);
		fixture.jobs['test-visual'].steps.find(
			(step) => step.name === 'Visual container bootstrap',
		).run = ':';
		fixture.jobs['test-visual'].steps.find(
			(step) => step.name === 'Visual rendering identity',
		).run = 'printf "identity passed\\n"';
		mutate?.(fixture);
		fs.writeFileSync(
			path.join(repository, '.github/workflows/build-check.yml'),
			YAML.stringify(fixture),
		);
		fs.writeFileSync(path.join(repository, '.gitignore'), 'node_modules/\ndist/\n');
		fs.writeFileSync(path.join(repository, '.bun-version'), '1.4.5\n');
		fs.writeFileSync(path.join(repository, 'package.json'), '{"type":"module"}\n');
		fs.writeFileSync(path.join(repository, 'gone.txt'), 'tracked input\n');
		fs.writeFileSync(path.join(repository, 'dist/public/index.html'), 'fixture\n');
		fs.writeFileSync(path.join(repository, 'dist/ci-runtime/usr/bin/srtla_send'), '');
		const files = [
			'.gitignore',
			'.bun-version',
			'package.json',
			'gone.txt',
			'.github/workflows/build-check.yml',
			'scripts/ci/run-visual-container.sh',
			'scripts/ci/run-visual-pr.sh',
		];
		fs.copyFileSync(
			new URL('scripts/ci/run-visual-container.sh', root),
			path.join(repository, files[5]),
		);
		const extractor = new URL('scripts/ci/visual-container.mjs', root);
		if (fs.existsSync(extractor)) {
			fs.copyFileSync(extractor, path.join(repository, 'scripts/ci/visual-container.mjs'));
			files.push('scripts/ci/visual-container.mjs');
		}
		fs.writeFileSync(
			path.join(repository, 'scripts/ci/run-visual-pr.sh'),
			'#!/bin/bash\nset -euo pipefail\nprintf compared > dist/compared\n',
		);
		fs.writeFileSync(
			path.join(bin, 'bun'),
			`#!/bin/bash\nif [[ "$1" = install ]]; then exit 0; fi\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
			{ mode: 0o755 },
		);
		fs.writeFileSync(
			path.join(bin, 'node'),
			`#!/bin/bash\nif [[ "$1" != -p || "$2" != 'process.versions.node.split(".")[0]' ]]; then exit 99; fi\nprintf '%s\\n' ${JSON.stringify(workflow.env.NODE_VERSION)}\n`,
			{ mode: 0o755 },
		);
		fs.writeFileSync(
			path.join(bin, 'docker'),
			`#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.writeFileSync(process.env.DOCKER_RECEIPT, JSON.stringify(args));
const userIndex = args.indexOf('--user');
if (process.env.REQUIRE_CALLER_USER === '1' &&
    (userIndex < 0 || args[userIndex + 1] !== process.getuid() + ':' + process.getgid())) {
  console.error('Docker ownership contract: payload would run as another user');
  process.exit(91);
}
const mount = args.find(arg => arg.includes('dst=/workspace/CeraUI'));
const work = /src=([^,]+)/.exec(mount)[1];
const env = { ...process.env };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--env') {
    const value = args[++i]; const equal = value.indexOf('=');
    env[value.slice(0, equal)] = value.slice(equal + 1)
      .replaceAll('/workspace/CeraUI', work).replaceAll('/github/home', work + '/.visual-home');
  }
}
env.PATH = process.env.FIXTURE_BIN + ':' + process.env.PATH;
fs.mkdirSync(env.HOME, {recursive:true});
const bash = args.indexOf('bash');
const child = Bun.spawn(['bash', ...args.slice(bash + 1)], {cwd:work,env,stdin:'ignore',stdout:'inherit',stderr:'inherit'});
process.exit(await child.exited);
`,
			{ mode: 0o755 },
		);
		for (const args of [
			['init', '-q'],
			['add', '--', ...files],
		]) {
			const result = spawnSync('git', args, {
				cwd: repository,
				env: { ...process.env, GIT_MASTER: '1' },
			});
			expect(result.status).toBe(0);
		}
		if (options.deleted) fs.unlinkSync(path.join(repository, 'gone.txt'));
		if (options.unreadable) fs.chmodSync(path.join(repository, 'gone.txt'), 0);
		const receipt = path.join(temporary, 'docker.json');
		const result = spawnSync('bash', ['scripts/ci/run-visual-container.sh'], {
			cwd: repository,
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				FIXTURE_BIN: bin,
				DOCKER_RECEIPT: receipt,
				REQUIRE_CALLER_USER: options.user ? '1' : '0',
			},
			encoding: 'utf8',
		});
		return {
			status: result.status,
			output: result.stdout + result.stderr,
			docker: fs.existsSync(receipt),
		};
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

for (const [name, mutate] of [
	[
		'missing Node version',
		(value) => {
			value.env.NODE_VERSION = undefined;
		},
	],
	[
		'malformed Node version',
		(value) => {
			value.env.NODE_VERSION = {};
		},
	],
	[
		'missing digest',
		(value) => {
			value.jobs['test-visual'].container.image = undefined;
		},
	],
	[
		'malformed digest',
		(value) => {
			value.jobs['test-visual'].container.image = 'untrusted:latest';
		},
	],
	[
		'missing identity step',
		(value) => {
			value.jobs['test-visual'].steps = value.jobs['test-visual'].steps.filter(
				(step) => step.name !== 'Visual rendering identity',
			);
		},
	],
	[
		'empty identity body',
		(value) => {
			value.jobs['test-visual'].steps.find(
				(step) => step.name === 'Visual rendering identity',
			).run = '';
		},
	],
]) {
	test(`wrapper rejects ${name} before Docker executes`, () => {
		const result = runWrapper(mutate);
		expect(result.status, result.output).not.toBe(0);
		expect(result.docker).toBe(false);
	}, 15_000);
}

for (const command of ['false', 'false | true']) {
	test(`wrapper stops on an intermediate identity failure: ${command}`, () => {
		const result = runWrapper((value) => {
			value.jobs['test-visual'].steps.find(
				(step) => step.name === 'Visual rendering identity',
			).run = `${command}\nprintf "IDENTITY_ASSERTION_WAS_SWALLOWED\\n"\n`;
		});
		expect(result.status, result.output).not.toBe(0);
		expect(result.output).not.toContain('IDENTITY_ASSERTION_WAS_SWALLOWED');
	}, 15_000);
}

test('wrapper selects the invoking user for all retained output', () => {
	const result = runWrapper(undefined, { user: true });
	expect(result.status, result.output).toBe(0);
}, 15_000);

test('wrapper copies a working tree with tracked deletions', () => {
	const result = runWrapper(undefined, { deleted: true });
	expect(result.status, result.output).toBe(0);
}, 15_000);

test('wrapper preserves genuine source copy errors', () => {
	const result = runWrapper(undefined, { unreadable: true });
	expect(result.status, result.output).not.toBe(0);
	expect(result.docker).toBe(false);
}, 15_000);
