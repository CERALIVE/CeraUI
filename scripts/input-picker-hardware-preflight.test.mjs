import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUBPROCESS_TIMEOUT_MS = 60_000;
// Let the helper report a killed subprocess before Bun kills the test itself.
const TEST_TIMEOUT_MS = SUBPROCESS_TIMEOUT_MS + 10_000;
const PASS_ARTIFACT = path.join(
	REPO_ROOT,
	'apps/frontend/test-results/input-picker-rock5b-hardware.json',
);
const HARDWARE_ENV_NAMES = [
	'CERAUI_INPUT_HARDWARE',
	'CERAUI_INPUT_HARDWARE_URL',
	'CERAUI_INPUT_HARDWARE_PASSWORD',
	'CERAUI_INPUT_PRIMARY_ID',
	'CERAUI_INPUT_TARGET_ID',
];

let tempDir;
let previousPassArtifact;

function runDedicatedHardwareConfig(reportPath, hardwareEnv = {}) {
	const env = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath };
	for (const name of HARDWARE_ENV_NAMES) delete env[name];
	Object.assign(env, hardwareEnv);

	const result = spawnSync(
		'bun',
		[
			'run',
			'--filter',
			'frontend',
			'test:e2e',
			'--',
			'--config=tests/e2e/playwright.hardware.config.ts',
			'--reporter=line,json',
		],
		{ cwd: REPO_ROOT, encoding: 'utf8', env, timeout: SUBPROCESS_TIMEOUT_MS },
	);
	assert.ifError(result.error);
	assert.equal(result.signal, null, 'Hardware preflight subprocess terminated by signal');

	return {
		exitCode: result.status,
		output: `${result.stdout}\n${result.stderr}`,
	};
}

function runOrdinaryHardwareInventory(reportPath) {
	const env = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath };
	for (const name of HARDWARE_ENV_NAMES) delete env[name];
	env.CI = undefined;

	const result = spawnSync(
		'bun',
		[
			'run',
			'--filter',
			'frontend',
			'test:e2e',
			'--',
			'input-picker.spec.ts',
			'--project=desktop',
			'--list',
			'--reporter=line',
		],
		{ cwd: REPO_ROOT, encoding: 'utf8', env, timeout: SUBPROCESS_TIMEOUT_MS },
	);
	assert.ifError(result.error);
	assert.equal(result.signal, null, 'Hardware preflight subprocess terminated by signal');
	return result;
}

before(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceraui-input-picker-gate-'));
	if (fs.existsSync(PASS_ARTIFACT)) {
		previousPassArtifact = fs.readFileSync(PASS_ARTIFACT);
	}
});

after(() => {
	fs.rmSync(tempDir, { force: true, recursive: true });
	if (previousPassArtifact === undefined) {
		fs.rmSync(PASS_ARTIFACT, { force: true });
		return;
	}
	fs.mkdirSync(path.dirname(PASS_ARTIFACT), { recursive: true });
	fs.writeFileSync(PASS_ARTIFACT, previousPassArtifact);
});

describe('input-picker dedicated hardware preflight', () => {
	it('exits nonzero when all hardware prerequisites are absent', {
		timeout: TEST_TIMEOUT_MS,
	}, () => {
		const reportPath = path.join(tempDir, 'no-env-report.json');
		const result = runDedicatedHardwareConfig(reportPath);

		assert.notEqual(result.exitCode, 0);
		assert.match(result.output, /HardwareInputPrerequisiteError/);
	});

	it('exits nonzero when any one hardware prerequisite is absent', {
		timeout: HARDWARE_ENV_NAMES.length * SUBPROCESS_TIMEOUT_MS + 10_000,
	}, () => {
		const validEnv = {
			CERAUI_INPUT_HARDWARE: '1',
			CERAUI_INPUT_HARDWARE_PASSWORD: '12345678',
			CERAUI_INPUT_HARDWARE_URL: 'http://192.0.2.1/',
			CERAUI_INPUT_PRIMARY_ID: 'video0',
			CERAUI_INPUT_TARGET_ID: 'video1',
		};

		for (const missing of HARDWARE_ENV_NAMES) {
			const hardwareEnv = { ...validEnv };
			delete hardwareEnv[missing];
			const reportPath = path.join(tempDir, `missing-${missing}.json`);
			const result = runDedicatedHardwareConfig(reportPath, hardwareEnv);

			assert.notEqual(result.exitCode, 0, `${missing} unexpectedly passed`);
			assert.match(result.output, /HardwareInputPrerequisiteError/);
		}
	});

	it('removes stale pass and report artifacts before prerequisite failure', {
		timeout: TEST_TIMEOUT_MS,
	}, () => {
		const reportPath = path.join(tempDir, 'stale-report.json');
		fs.mkdirSync(path.dirname(PASS_ARTIFACT), { recursive: true });
		fs.writeFileSync(PASS_ARTIFACT, '{"status":"stale"}\n', 'utf8');
		fs.writeFileSync(reportPath, '{"status":"stale"}\n', 'utf8');

		const result = runDedicatedHardwareConfig(reportPath);

		assert.notEqual(result.exitCode, 0);
		assert.equal(fs.existsSync(PASS_ARTIFACT), false);
		assert.equal(fs.existsSync(reportPath), false);
	});

	it('ordinary inventory removes stale artifacts without requiring hardware', {
		timeout: TEST_TIMEOUT_MS,
	}, () => {
		const reportPath = path.join(tempDir, 'ordinary-stale-report.json');
		fs.mkdirSync(path.dirname(PASS_ARTIFACT), { recursive: true });
		fs.writeFileSync(PASS_ARTIFACT, '{"status":"stale"}\n', 'utf8');
		fs.writeFileSync(reportPath, '{"status":"stale"}\n', 'utf8');

		const result = runOrdinaryHardwareInventory(reportPath);

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.equal(fs.existsSync(PASS_ARTIFACT), false);
		assert.equal(fs.existsSync(reportPath), false);
	});
});
