#!/usr/bin/env node
// Technical-debt register validator (Task 4, ceraui-source-experience).
//
// Enforces docs/TECHNICAL_DEBT.md as a machine-checkable ledger and binds source
// debt markers to it. Fails (exit 1) — never advisory (G6) — when:
//   (a) any ```debt entry is malformed / missing a field / out-of-contract value,
//   (b) a `resolved` entry has a null resolved_at (or an `open` entry has a date),
//   (c) a source `data-debt-id="TD-NNN"` references no `open` entry (orphan),
//   (d) a source `coming-soon` / `[PARTIAL]` marker carries no open `data-debt-id`.
//
// Self-contained (Rule D): reads nothing above the CeraUI checkout root.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');

const REQUIRED_FIELDS = [
	'id',
	'title',
	'track',
	'status',
	'exit_criteria',
	'owner',
	'registered_at',
	'resolved_at',
	'unblock',
];

// Register ids are either a numeric form (`TD-001`) or a descriptive slug
// (`TD-live-audio-switch` — lowercase alphanumeric words joined by hyphens).
const ID_RE = /^TD-(?:\d{3,}|[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATA_DEBT_ID_RE = /data-debt-id="([^"]*)"/g;
const MARKER_RE = /coming-soon|\[PARTIAL\]/;
// Test/spec files are not shipped source: their assertion strings and selectors
// legitimately mention "coming-soon" / "data-debt-id" without being debt markers,
// so scanning them only yields false positives. Real debt markers live on shipped
// UI source, never in a `*.test.*` / `*.spec.*` file.
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SCAN_EXTENSIONS = new Set([
	'.ts',
	'.tsx',
	'.js',
	'.mjs',
	'.cjs',
	'.svelte',
	'.html',
	'.css',
	'.json',
]);
const SKIP_DIRS = new Set([
	'node_modules',
	'dist',
	'build',
	'coverage',
	'test-results',
	'.git',
	'.svelte-kit',
]);
const DEFAULT_SCAN_DIRS = [
	'apps/frontend/src',
	'apps/backend/src',
	'packages/rpc/src',
	'packages/i18n/src',
];

// exit_criteria must be executable, not prose: a backticked command, or a
// capability/PR reference — never a free-text sentence.
function isExecutableExitCriteria(value) {
	if (value.length > 2 && value.startsWith('`') && value.endsWith('`')) return true;
	if (/^capability:\S+$/.test(value)) return true;
	if (/^PR #\d+$/.test(value)) return true;
	if (/^#\d+$/.test(value)) return true;
	return false;
}

// Parse every literal ```debt fenced block. Returns { blocks: [{fields, line}], errors }.
function parseDebtBlocks(text) {
	const lines = text.split('\n');
	const blocks = [];
	const errors = [];
	let i = 0;
	while (i < lines.length) {
		if (lines[i].trim() === '```debt') {
			const start = i + 1;
			let j = i + 1;
			while (j < lines.length && lines[j].trim() !== '```') j++;
			if (j >= lines.length) {
				errors.push(`Unterminated \`\`\`debt block starting at line ${start}`);
				break;
			}
			const fields = {};
			const seen = new Set();
			for (let k = start; k < j; k++) {
				const raw = lines[k];
				if (raw.trim() === '') continue;
				const colon = raw.indexOf(':');
				if (colon === -1) {
					errors.push(`Entry at line ${start}: non "key: value" line: "${raw.trim()}"`);
					continue;
				}
				const key = raw.slice(0, colon).trim();
				const value = raw.slice(colon + 1).trim();
				if (seen.has(key)) errors.push(`Entry at line ${start}: duplicate field "${key}"`);
				seen.add(key);
				fields[key] = value;
			}
			blocks.push({ fields, line: start });
			i = j + 1;
		} else {
			i++;
		}
	}
	return { blocks, errors };
}

function validateEntry(fields, line, errors, seenIds) {
	const where = `Entry "${fields.id ?? '?'}" (line ${line})`;
	for (const f of REQUIRED_FIELDS) {
		if (!(f in fields)) errors.push(`${where}: missing required field "${f}"`);
	}
	for (const f of Object.keys(fields)) {
		if (!REQUIRED_FIELDS.includes(f)) errors.push(`${where}: unknown field "${f}"`);
	}
	const { id, title, track, status, exit_criteria, owner, registered_at, resolved_at, unblock } =
		fields;

	if (id !== undefined) {
		if (!ID_RE.test(id)) errors.push(`${where}: id "${id}" must match TD-NNN or TD-<slug>`);
		if (seenIds.has(id)) errors.push(`${where}: duplicate id "${id}"`);
		seenIds.add(id);
	}
	if (title !== undefined && title === '') errors.push(`${where}: title must be non-empty`);
	if (track !== undefined && track !== '1' && track !== '2')
		errors.push(`${where}: track must be 1 or 2 (got "${track}")`);
	if (status !== undefined && status !== 'open' && status !== 'resolved') {
		errors.push(`${where}: status must be open|resolved (got "${status}")`);
	}
	if (exit_criteria !== undefined && !isExecutableExitCriteria(exit_criteria)) {
		errors.push(
			`${where}: exit_criteria must be a \`command\`, capability:<x>, or PR #<n> — not prose (got "${exit_criteria}")`,
		);
	}
	if (owner !== undefined && owner === '') errors.push(`${where}: owner must be non-empty`);
	if (registered_at !== undefined && !DATE_RE.test(registered_at)) {
		errors.push(`${where}: registered_at must be YYYY-MM-DD (got "${registered_at}")`);
	}
	if (status === 'resolved') {
		if (resolved_at === 'null' || resolved_at === undefined) {
			errors.push(`${where}: resolved entry must have a real resolved_at date, not null`);
		} else if (!DATE_RE.test(resolved_at)) {
			errors.push(`${where}: resolved_at must be YYYY-MM-DD (got "${resolved_at}")`);
		}
	} else if (status === 'open' && resolved_at !== undefined && resolved_at !== 'null') {
		errors.push(`${where}: open entry must have resolved_at: null (got "${resolved_at}")`);
	}
	if (unblock !== undefined && unblock === '') errors.push(`${where}: unblock must be non-empty`);

	return status === 'open' && id !== undefined ? id : null;
}

function* walk(dir) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name)) continue;
			yield* walk(join(dir, e.name));
		} else if (e.isFile()) {
			if (TEST_FILE_RE.test(e.name)) continue;
			const dot = e.name.lastIndexOf('.');
			if (dot !== -1 && SCAN_EXTENSIONS.has(e.name.slice(dot))) yield join(dir, e.name);
		}
	}
}

function scanMarkers(scanDirs, openIds, errors) {
	for (const dir of scanDirs) {
		if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
		for (const file of walk(dir)) {
			const lines = readFileSync(file, 'utf8').split('\n');
			lines.forEach((lineText, idx) => {
				const at = `${file}:${idx + 1}`;
				const idsOnLine = [];
				for (const m of lineText.matchAll(DATA_DEBT_ID_RE)) {
					const id = m[1];
					// A `${...}` template interpolation is a dynamic runtime binding
					// (e.g. data-debt-id="${debtId}" in a component/test), never a
					// static marker — the real id is verified at the call site.
					if (id.includes('${')) continue;
					idsOnLine.push(id);
					if (!ID_RE.test(id)) {
						errors.push(`${at}: data-debt-id "${id}" must match TD-NNN or TD-<slug>`);
					} else if (!openIds.has(id)) {
						errors.push(
							`${at}: orphan data-debt-id "${id}" — no matching OPEN entry in docs/TECHNICAL_DEBT.md`,
						);
					}
				}
				if (MARKER_RE.test(lineText)) {
					const linked = idsOnLine.some((id) => openIds.has(id));
					if (!linked) {
						errors.push(
							`${at}: coming-soon/[PARTIAL] marker without an open data-debt-id="TD-NNN" link`,
						);
					}
				}
			});
		}
	}
}

export function checkTechDebt(options = {}) {
	const rootDir = options.rootDir ? resolve(options.rootDir) : DEFAULT_ROOT;
	const registerPath = options.registerPath ?? join(rootDir, 'docs', 'TECHNICAL_DEBT.md');
	const scanDirs = (options.scanDirs ?? DEFAULT_SCAN_DIRS).map((d) => resolve(rootDir, d));
	const errors = [];

	if (!existsSync(registerPath)) {
		return { ok: false, errors: [`Register not found: ${registerPath}`], openIds: new Set() };
	}

	const { blocks, errors: parseErrors } = parseDebtBlocks(readFileSync(registerPath, 'utf8'));
	errors.push(...parseErrors);

	const seenIds = new Set();
	const openIds = new Set();
	for (const { fields, line } of blocks) {
		const openId = validateEntry(fields, line, errors, seenIds);
		if (openId) openIds.add(openId);
	}

	scanMarkers(scanDirs, openIds, errors);

	return { ok: errors.length === 0, errors, openIds, entryCount: blocks.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const rootArg = process.argv[2];
	const result = checkTechDebt(rootArg ? { rootDir: rootArg } : {});
	if (result.ok) {
		// biome-ignore lint/suspicious/noConsole: CLI tool stdout is its result output
		console.log(
			`tech-debt OK — ${result.entryCount} register entr${result.entryCount === 1 ? 'y' : 'ies'}, ${result.openIds.size} open, no orphan markers.`,
		);
		process.exit(0);
	}
	console.error('tech-debt FAILED:');
	for (const e of result.errors) console.error(`  - ${e}`);
	process.exit(1);
}
