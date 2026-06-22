// Unit tests for the technical-debt register validator (Task 4).
// Run: node --test scripts/check-tech-debt.test.mjs
//
// Each test builds an isolated fixture tree (its own register + source dir) so
// the validator is exercised against controlled input, never the live repo.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

import { checkTechDebt } from './check-tech-debt.mjs';

const VALID_OPEN_ENTRY = [
	'```debt',
	'id: TD-001',
	'title: Live-audio switch UI gated, engine path stubbed',
	'track: 1',
	'status: open',
	'exit_criteria: `bun run --filter backend test -- audio-live-switch.test.ts`',
	'owner: andrescera',
	'registered_at: 2026-06-17',
	'resolved_at: null',
	'unblock: cerastream advertises audio_live_switch and the backend wires the RPC.',
	'```',
].join('\n');

const REGISTER_HEADER = '# CeraUI Technical-Debt Register\n\n';

let roots = [];

function makeFixture(registerBody, sourceFiles = {}) {
	const root = mkdtempSync(join(tmpdir(), 'td-fixture-'));
	roots.push(root);
	mkdirSync(join(root, 'docs'), { recursive: true });
	writeFileSync(join(root, 'docs', 'TECHNICAL_DEBT.md'), REGISTER_HEADER + registerBody);
	const srcDir = join(root, 'src');
	mkdirSync(srcDir, { recursive: true });
	for (const [name, content] of Object.entries(sourceFiles)) {
		writeFileSync(join(srcDir, name), content);
	}
	return root;
}

function run(root) {
	return checkTechDebt({ rootDir: root, scanDirs: ['src'] });
}

beforeEach(() => {
	roots = [];
});

after(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

test('clean tree (empty register, no markers) passes with exit-0 semantics', () => {
	const root = makeFixture('_None._\n', { 'App.svelte': '<div>hello</div>\n' });
	const result = run(root);
	assert.equal(result.ok, true, result.errors.join('; '));
	assert.equal(result.entryCount, 0);
	assert.equal(result.openIds.size, 0);
});

test('valid open entry + matching data-debt-id marker passes', () => {
	const root = makeFixture(VALID_OPEN_ENTRY, {
		'Live.svelte': '<button data-debt-id="TD-001">soon</button>\n',
	});
	const result = run(root);
	assert.equal(result.ok, true, result.errors.join('; '));
	assert.ok(result.openIds.has('TD-001'));
});

test('slug-form id (TD-<slug>) passes and binds a matching marker', () => {
	const slugEntry = VALID_OPEN_ENTRY.replace('id: TD-001', 'id: TD-live-audio-switch');
	const root = makeFixture(slugEntry, {
		'Live.svelte': '<div data-debt-id="TD-live-audio-switch">coming-soon</div>\n',
	});
	const result = run(root);
	assert.equal(result.ok, true, result.errors.join('; '));
	assert.ok(result.openIds.has('TD-live-audio-switch'));
});

test('id with illegal characters (uppercase / underscore) fails', () => {
	const bad = VALID_OPEN_ENTRY.replace('id: TD-001', 'id: TD-Live_Audio');
	const root = makeFixture(bad);
	const result = run(root);
	assert.equal(result.ok, false);
	assert.ok(
		result.errors.some((e) => e.includes('must match TD-NNN or TD-<slug>')),
		result.errors.join('; '),
	);
});

test('malformed entry (missing field) fails', () => {
	const malformed = [
		'```debt',
		'id: TD-002',
		'title: missing several fields',
		'status: open',
		'```',
	].join('\n');
	const root = makeFixture(malformed);
	const result = run(root);
	assert.equal(result.ok, false);
	assert.ok(
		result.errors.some((e) => e.includes('missing required field "track"')),
		result.errors.join('; '),
	);
	assert.ok(result.errors.some((e) => e.includes('missing required field "owner"')));
});

test('malformed entry (bad track value) fails', () => {
	const bad = VALID_OPEN_ENTRY.replace('track: 1', 'track: 9');
	const root = makeFixture(bad);
	const result = run(root);
	assert.equal(result.ok, false);
	assert.ok(result.errors.some((e) => e.includes('track must be 1 or 2')));
});

test('prose exit_criteria (not executable) fails', () => {
	const prose = VALID_OPEN_ENTRY.replace(
		'exit_criteria: `bun run --filter backend test -- audio-live-switch.test.ts`',
		'exit_criteria: when the backend eventually wires the live switch',
	);
	const root = makeFixture(prose);
	const result = run(root);
	assert.equal(result.ok, false);
	assert.ok(result.errors.some((e) => e.includes('exit_criteria must be')));
});

test('exit_criteria as capability: or PR # reference passes', () => {
	for (const crit of ['capability:audio_live_switch', 'PR #123']) {
		const entry = VALID_OPEN_ENTRY.replace(
			'exit_criteria: `bun run --filter backend test -- audio-live-switch.test.ts`',
			`exit_criteria: ${crit}`,
		);
		const root = makeFixture(entry);
		const result = run(root);
		assert.equal(result.ok, true, `crit=${crit}: ${result.errors.join('; ')}`);
	}
});

test('resolved entry with null resolved_at fails', () => {
	const badResolved = VALID_OPEN_ENTRY.replace('status: open', 'status: resolved');
	const root = makeFixture(badResolved);
	const result = run(root);
	assert.equal(result.ok, false);
	assert.ok(
		result.errors.some((e) => e.includes('resolved entry must have a real resolved_at date')),
	);
});

test('resolved entry with real date passes (and is not an open id)', () => {
	const resolved = VALID_OPEN_ENTRY.replace('status: open', 'status: resolved').replace(
		'resolved_at: null',
		'resolved_at: 2026-06-18',
	);
	const root = makeFixture(resolved);
	const result = run(root);
	assert.equal(result.ok, true, result.errors.join('; '));
	assert.equal(result.openIds.has('TD-001'), false);
});

test('dynamic data-debt-id template binding is skipped (not a static marker)', () => {
	const dynamicBinding = `<span data-debt-id="$\{debtId}">soon</span>\n`;
	const root = makeFixture(VALID_OPEN_ENTRY, { 'Dynamic.svelte': dynamicBinding });
	const result = run(root);
	assert.equal(result.ok, true, result.errors.join('; '));
});

test('orphan data-debt-id (no matching open entry) fails', () => {
	const root = makeFixture('_None._\n', {
		'Orphan.svelte': '<button data-debt-id="TD-404">soon</button>\n',
	});
	const result = run(root);
	assert.equal(result.ok, false);
	assert.ok(
		result.errors.some((e) => e.includes('orphan data-debt-id "TD-404"')),
		result.errors.join('; '),
	);
});

test('data-debt-id pointing at a resolved (non-open) entry is an orphan', () => {
	const resolved = VALID_OPEN_ENTRY.replace('status: open', 'status: resolved').replace(
		'resolved_at: null',
		'resolved_at: 2026-06-18',
	);
	const root = makeFixture(resolved, {
		'Stale.svelte': '<button data-debt-id="TD-001">soon</button>\n',
	});
	const result = run(root);
	assert.equal(result.ok, false);
	assert.ok(result.errors.some((e) => e.includes('orphan data-debt-id "TD-001"')));
});

test('coming-soon marker without a data-debt-id link fails', () => {
	const root = makeFixture(VALID_OPEN_ENTRY, {
		'ComingSoon.svelte': '<div class="coming-soon">later</div>\n',
	});
	const result = run(root);
	assert.equal(result.ok, false);
	assert.ok(
		result.errors.some((e) => e.includes('without an open data-debt-id')),
		result.errors.join('; '),
	);
});

test('markers inside test/spec files are ignored (not shipped source)', () => {
	const root = makeFixture(VALID_OPEN_ENTRY, {
		// A test file legitimately names markers in its descriptions/selectors and
		// references an unrelated data-debt-id — none of these are shipped debt.
		'InputPicker.test.ts':
			'it("gates the coming-soon affordance", () => {\n' +
			'\tcontainer.querySelector(\'[data-audio-coming-soon="x"]\');\n' +
			'\texpect(el.getAttribute("data-debt-id")).toBe("TD-404");\n' +
			'});\n',
		'live.spec.ts': '// coming-soon assertion, data-debt-id="TD-404"\n',
	});
	const result = run(root);
	assert.equal(result.ok, true, result.errors.join('; '));
});

test('[PARTIAL] source marker linked to an open entry passes', () => {
	const root = makeFixture(VALID_OPEN_ENTRY, {
		'partial.ts': '// [PARTIAL] data-debt-id="TD-001" engine path stubbed\n',
	});
	const result = run(root);
	assert.equal(result.ok, true, result.errors.join('; '));
});

test('duplicate ids fail', () => {
	const root = makeFixture(`${VALID_OPEN_ENTRY}\n\n${VALID_OPEN_ENTRY}`);
	const result = run(root);
	assert.equal(result.ok, false);
	assert.ok(result.errors.some((e) => e.includes('duplicate id "TD-001"')));
});

test('missing register file fails closed', () => {
	const root = mkdtempSync(join(tmpdir(), 'td-empty-'));
	roots.push(root);
	const result = checkTechDebt({ rootDir: root, scanDirs: ['src'] });
	assert.equal(result.ok, false);
	assert.ok(result.errors.some((e) => e.includes('Register not found')));
});
