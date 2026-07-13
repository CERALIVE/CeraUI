#!/usr/bin/env node
// RPC / broadcast / i18n contract-parity audit (live-correctness-pass Todo #18, Audit A4).
//
// Repo-local, CI-runnable but deliberately NOT wired into CI in this plan. Runs
// three independent checks and writes a machine-readable report to
// `test-results/reports/live-correctness-audit-A4.md`:
//
//   (1) RPC PARITY  — every frontend TypedRPC method (`apps/frontend/src/lib/rpc/
//       client.ts`) resolves to BOTH a backend procedure registration
//       (`apps/backend/src/rpc/router.ts`) AND, for its named I/O types, a matching
//       export from `@ceraui/rpc/schemas`. A miss is a HARD FAILURE (exit 1).
//   (2) BROADCAST PARITY — every backend broadcast event type (`broadcast(` /
//       `broadcastMsg(` literal or resolved const first-arg) is consumed by a
//       `subscriptions.svelte.ts` `case`, OR covered by an open TD shim entry
//       (`TD-legacy-source-broadcasts` → pipelines/devices), OR a documented
//       transport/relay-exempt frame. An unmatched type is a HARD FAILURE (exit 1).
//   (3) I18N ORPHANS — every leaf key in `packages/i18n/src/en/index.ts` is
//       reference-checked across `apps/frontend/src` + `packages`. Zero-reference
//       leaves are REPORTED (never auto-removed). Dynamically-constructed key
//       namespaces (`t(...)` / bracket-index resolvers in SourceSection / LiveView /
//       StreamSetupChain) are EXEMPT from the removable set. Informational only —
//       never fails the run.
//
// Self-contained (Rule D): reads nothing above the CeraUI checkout root.
// Self-test: `node scripts/audit-contract-parity.mjs --self-test` drives the pure
// matchers against synthetic fixtures (a fake unmatched method + a fake unmatched
// broadcast) and asserts each is flagged — proving the hard-fail path without
// mutating any shipped source.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');

// ── Paths (relative to the checkout root) ───────────────────────────────────
const CLIENT_TS = 'apps/frontend/src/lib/rpc/client.ts';
const ROUTER_TS = 'apps/backend/src/rpc/router.ts';
const SCHEMAS_DIR = 'packages/rpc/src/schemas';
const SUBSCRIPTIONS_TS = 'apps/frontend/src/lib/rpc/subscriptions.svelte.ts';
const BACKEND_SRC = 'apps/backend/src';
const EN_LOCALE = 'packages/i18n/src/en/index.ts';
const TD_REGISTER = 'docs/TECHNICAL_DEBT.md';
const REPORT_OUT = 'test-results/reports/live-correctness-audit-A4.md';

// Reference corpus roots. Spec calls for `apps/frontend/src` + `packages`;
// `apps/backend/src` is added deliberately because several i18n keys are referenced
// ONLY as key strings pushed from the backend notification path (e.g.
// `notifications.hdmiError` / `notifications.bootconfigUpdating` in
// `modules/system/sensors.ts`). Omitting it would flag those live keys as
// false-positive orphans — a superset corpus can only make the removable set SAFER.
const I18N_REFERENCE_ROOTS = [
	'apps/frontend/src',
	'apps/backend/src',
	'packages/rpc/src',
	'packages/i18n/src',
];
const I18N_SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.svelte']);
const SKIP_DIRS = new Set([
	'node_modules',
	'dist',
	'build',
	'coverage',
	'test-results',
	'.git',
	'.svelte-kit',
]);

// Broadcast event types that legitimately have NO subscriptions.svelte.ts consumer,
// with the reason each is exempt. These are NOT UI-subscription targets.
const BROADCAST_EXEMPT = new Map([
	// Transport heartbeat: handled in client.ts (acked with `pong`), never forwarded
	// to the subscription layer.
	['ping', 'transport heartbeat — handled in client.ts (pong ack), never reaches subscriptions'],
	// Remote-control status-relay frame (protocol.ts STATUS_TYPES/RELAYABLE_TYPES).
	// Emitted via broadcastMsg by the active-profile reporter; consumed by the
	// platform hub (ceralive-platform internal-gate.ts), not the device UI.
	[
		'device.activeProfile',
		'remote-control status-relay frame (protocol.ts) — consumed by the platform hub, not the device UI',
	],
]);

// Open TD shim entries that cover a still-produced-but-unconsumed broadcast. Only
// used when the type has NO direct subscriptions consumer; both `pipelines` and
// `devices` also happen to keep a live consumer, so this is a belt-and-braces map.
const BROADCAST_TD_SHIM = new Map([
	['pipelines', 'TD-legacy-source-broadcasts'],
	['devices', 'TD-legacy-source-broadcasts'],
]);

// i18n leaf-key namespaces resolved dynamically (a runtime-built dot-path never
// appears as a literal accessor), so a zero-reference leaf under one of these is
// EXEMPT from the removable set — reported, never removed. Sourced from the
// `t(key)` / `resolveReason(key)` resolvers in SourceSection.svelte,
// LiveView.svelte, StreamSetupChain.svelte and the bracket-index Tier-2 lookup.
const I18N_DYNAMIC_EXEMPT_PREFIXES = [
	'live.education.', // reason keys + education copy (pipelineAvailability / ValidationAdapter / go-live-readiness)
	'live.startFailed.', // Tier-2 code keys accessed via $LL.live.startFailed[reason]()
	'live.server.kind.', // kindBadgeLabelKey(kind) → dotted labelKey
	'audio.sources.', // audio labelKeys (noAudio / auto / pipelineDefault)
	'live.comingSoon.', // ComingSoon roadmap copy (debtId-driven)
];

// ── Small fs helpers ────────────────────────────────────────────────────────
function read(root, rel) {
	return readFileSync(join(root, rel), 'utf8');
}

function* walk(dir) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name)) continue;
			yield* walk(join(dir, e.name));
		} else if (e.isFile()) {
			yield join(dir, e.name);
		}
	}
}

const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

// ── Section 1: RPC parity ───────────────────────────────────────────────────

/** Extract the type names imported from `@ceraui/rpc/schemas` at the top of client.ts. */
export function parseSchemaImports(clientSource) {
	const m = clientSource.match(
		/import\s+type\s*\{([\s\S]*?)\}\s*from\s*["']@ceraui\/rpc\/schemas["']/,
	);
	if (!m) return [];
	return m[1]
		.split(',')
		.map((s) => s.trim())
		.filter((s) => /^[A-Za-z_]\w*$/.test(s));
}

/**
 * Parse `export interface TypedRPC { ... }` into `{ domain, method, optional }`
 * rows. The file is tab-formatted: a domain sits at one tab and opens `{`; a method
 * sits at two tabs and its signature opens `(`. Inline object I/O types nest deeper,
 * so a two-tab `name: (` line is unambiguously a method.
 */
export function parseTypedRpcMethods(clientSource) {
	const start = clientSource.indexOf('export interface TypedRPC');
	if (start === -1) return [];
	// Walk braces from the first `{` after the interface name to its match.
	const open = clientSource.indexOf('{', start);
	let depth = 0;
	let end = open;
	for (let i = open; i < clientSource.length; i++) {
		const c = clientSource[i];
		if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	const body = clientSource.slice(open + 1, end);
	const lines = body.split('\n');
	const methods = [];
	let domain = null;
	const domainRe = /^\t([A-Za-z_]\w*)(\??):\s*\{/;
	const methodRe = /^\t\t([A-Za-z_]\w*)(\??):\s*\(/;
	const domainCloseRe = /^\t\}/;
	for (const line of lines) {
		const dm = domainRe.exec(line);
		if (dm) {
			domain = dm[1];
			continue;
		}
		if (domainCloseRe.test(line)) {
			domain = null;
			continue;
		}
		const mm = methodRe.exec(line);
		if (mm && domain) {
			methods.push({ domain, method: mm[1], optional: mm[2] === '?' });
		}
	}
	return methods;
}

/**
 * Parse `router.ts` into a `Map<domain, Set<method>>`. Domains open with
 * `<name>: base.router({`; methods are the `<key>:` lines inside. The dev namespace
 * is registered inline (`dev: base.router({ emit: devEmitProcedure })`).
 */
export function parseRouterRegistrations(routerSource) {
	const registrations = new Map();
	const lines = routerSource.split('\n');
	let domain = null;
	const domainOpenRe = /^\t([A-Za-z_]\w*):\s*base\.router\(\{/;
	const methodRe = /^\t\t([A-Za-z_]\w*):/;
	const domainCloseRe = /^\t\}\)/;
	for (const line of lines) {
		const dm = domainOpenRe.exec(line);
		if (dm) {
			domain = dm[1];
			if (!registrations.has(domain)) registrations.set(domain, new Set());
			continue;
		}
		if (domain && domainCloseRe.test(line)) {
			domain = null;
			continue;
		}
		if (domain) {
			const mm = methodRe.exec(line);
			if (mm) registrations.get(domain).add(mm[1]);
		}
	}
	// Inline dev namespace: `dev: base.router({ emit: devEmitProcedure })`.
	const inline = routerSource.matchAll(/([A-Za-z_]\w*):\s*base\.router\(\{\s*([A-Za-z_]\w*):/g);
	for (const m of inline) {
		const dName = m[1];
		if (!registrations.has(dName)) registrations.set(dName, new Set());
		registrations.get(dName).add(m[2]);
	}
	return registrations;
}

/** Collect every exported identifier from the `@ceraui/rpc/schemas` barrel files. */
export function collectSchemaExports(root) {
	const dir = join(root, SCHEMAS_DIR);
	const names = new Set();
	if (!existsSync(dir)) return names;
	for (const file of walk(dir)) {
		if (!file.endsWith('.ts') || TEST_FILE_RE.test(file)) continue;
		const src = readFileSync(file, 'utf8');
		for (const m of src.matchAll(
			/export\s+(?:declare\s+)?(?:const|function|type|interface|class|enum)\s+([A-Za-z_]\w*)/g,
		)) {
			names.add(m[1]);
		}
		// Re-exports: `export { A, B as C }` and `export type { A, B }`.
		for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
			for (const part of m[1].split(',')) {
				const name = part
					.trim()
					.split(/\s+as\s+/)
					.pop()
					?.trim();
				if (name && /^[A-Za-z_]\w*$/.test(name)) names.add(name);
			}
		}
	}
	return names;
}

/**
 * Pure RPC matcher. Returns `{ rows, violations }`. A violation is a TypedRPC
 * method with no backend handler registration. (Schema linkage is reported per
 * method; a referenced-but-unexported schema type is a separate violation.)
 */
export function matchRpc(methods, registrations, importedSchemaNames, schemaExports) {
	const rows = [];
	const violations = [];
	for (const { domain, method, optional } of methods) {
		const handler = registrations.get(domain)?.has(method) ?? false;
		if (!handler) {
			violations.push(
				`TypedRPC \`${domain}.${method}\` has no backend procedure registration in router.ts`,
			);
		}
		rows.push({ domain, method, optional, handler });
	}
	// Every schema type client.ts imports must actually be exported by the barrel.
	const missingSchemaExports = importedSchemaNames.filter((n) => !schemaExports.has(n));
	for (const name of missingSchemaExports) {
		violations.push(
			`client.ts imports \`${name}\` from @ceraui/rpc/schemas but it is not exported by the barrel`,
		);
	}
	return { rows, violations, missingSchemaExports };
}

// ── Section 2: broadcast parity ─────────────────────────────────────────────

/** Build a `Map<CONST_NAME, "value">` for string-literal consts across backend src. */
function collectStringConsts(root) {
	const map = new Map();
	const dir = join(root, BACKEND_SRC);
	if (!existsSync(dir)) return map;
	for (const file of walk(dir)) {
		if (!file.endsWith('.ts') || TEST_FILE_RE.test(file)) continue;
		const src = readFileSync(file, 'utf8');
		for (const m of src.matchAll(
			/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*["']([^"']+)["']/g,
		)) {
			map.set(m[1], m[2]);
		}
	}
	return map;
}

/**
 * Enumerate broadcast event types across the backend. Captures the first argument
 * of `broadcast(` / `broadcastMsg(` when it is a string literal or an ALL-CAPS const
 * (resolved via `constMap`). Lower-case identifiers / expressions are dynamic and
 * skipped (reported separately). Excludes test/spec files and the events.ts
 * definition site.
 */
export function collectBroadcastTypes(root, constMap) {
	const types = new Map(); // type -> [{ file, const? }]
	const unresolved = new Set(); // dynamic first-args (informational)
	const callRe = /\bbroadcast(?:Msg)?\(\s*(?:(["'])([^"']+)\1|([A-Za-z_]\w*))/g;
	const dir = join(root, BACKEND_SRC);
	if (!existsSync(dir)) return { types, unresolved };
	for (const file of walk(dir)) {
		if (!file.endsWith('.ts') || TEST_FILE_RE.test(file)) continue;
		const rel = relative(root, file);
		if (rel.endsWith('rpc/events.ts')) continue; // definition + generic fan-out
		const src = readFileSync(file, 'utf8');
		for (const m of src.matchAll(callRe)) {
			const literal = m[2];
			const ident = m[3];
			if (literal !== undefined) {
				addType(types, literal, rel, null);
			} else if (ident && /^[A-Z][A-Z0-9_]*$/.test(ident) && constMap.has(ident)) {
				addType(types, constMap.get(ident), rel, ident);
			} else if (ident) {
				unresolved.add(`${ident} (${rel})`);
			}
		}
	}
	return { types, unresolved };
}

function addType(types, type, file, constName) {
	if (!types.has(type)) types.set(type, []);
	types.get(type).push({ file, const: constName });
}

/** Extract `case "<type>":` labels from subscriptions.svelte.ts. */
export function parseSubscriptionConsumers(subsSource) {
	const consumers = new Set();
	for (const m of subsSource.matchAll(/case\s+["']([^"']+)["']\s*:/g)) {
		consumers.add(m[1]);
	}
	return consumers;
}

/**
 * Pure broadcast matcher. Each type is matched if consumed, OR covered by an open
 * TD shim entry, OR a documented transport/relay-exempt frame. Anything else is a
 * violation.
 */
export function matchBroadcasts(types, consumers, openTdIds, exemptMap, tdShimMap) {
	const rows = [];
	const violations = [];
	for (const type of [...types.keys()].sort()) {
		let status;
		let detail = '';
		if (consumers.has(type)) {
			status = 'consumed';
		} else if (tdShimMap.has(type) && openTdIds.has(tdShimMap.get(type))) {
			status = 'td-shim';
			detail = tdShimMap.get(type);
		} else if (exemptMap.has(type)) {
			status = 'exempt';
			detail = exemptMap.get(type);
		} else {
			status = 'UNMATCHED';
			violations.push(
				`broadcast type "${type}" has no subscriptions.svelte.ts consumer and no open TD shim entry`,
			);
		}
		rows.push({ type, status, detail });
	}
	return { rows, violations };
}

// ── Section 3: i18n orphans ─────────────────────────────────────────────────

/**
 * Parse the `en` locale object literal into leaf dot-paths. Values are strings /
 * template strings (typesafe-i18n base locale — no arrow functions), so a `key:`
 * token followed by `{` opens a nested object and anything else is a leaf. A
 * character-level scanner tracks quote/brace state so string bodies never leak.
 */
export function parseLocaleLeafKeys(localeSource) {
	const open = localeSource.indexOf('const en = {');
	if (open === -1) return [];
	const braceStart = localeSource.indexOf('{', open);
	const leaves = [];
	const stack = [];
	let i = braceStart + 1;
	let pendingKey = null;
	const src = localeSource;
	const len = src.length;
	while (i < len) {
		const c = src[i];
		// Skip line + block comments.
		if (c === '/' && src[i + 1] === '/') {
			const nl = src.indexOf('\n', i);
			i = nl === -1 ? len : nl + 1;
			continue;
		}
		if (c === '/' && src[i + 1] === '*') {
			const close = src.indexOf('*/', i + 2);
			i = close === -1 ? len : close + 2;
			continue;
		}
		// Skip string / template literals wholesale.
		if (c === '"' || c === "'" || c === '`') {
			i = skipString(src, i, c);
			if (pendingKey !== null) {
				// key: "value" — a leaf.
				leaves.push([...stack, pendingKey].join('.'));
				pendingKey = null;
			}
			continue;
		}
		if (c === '{') {
			if (pendingKey !== null) {
				stack.push(pendingKey);
				pendingKey = null;
			}
			i++;
			continue;
		}
		if (c === '}') {
			// Close the top object; a `satisfies`/end brace with empty stack ends parse.
			if (stack.length === 0) break;
			stack.pop();
			pendingKey = null;
			i++;
			continue;
		}
		// A bare identifier or quoted key token followed by `:` is a key.
		const km = /^([A-Za-z_$][\w$]*|"[^"]+"|'[^']+')\s*:/.exec(src.slice(i, i + 200));
		if (km) {
			let key = km[1];
			if (key.startsWith('"') || key.startsWith("'")) key = key.slice(1, -1);
			pendingKey = key;
			i += km[0].length;
			continue;
		}
		i++;
	}
	return leaves;
}

function skipString(src, start, quote) {
	let pos = start + 1; // skip opening quote
	while (pos < src.length) {
		const c = src[pos];
		if (c === '\\') {
			pos += 2;
			continue;
		}
		if (c === quote) return pos + 1;
		pos++;
	}
	return pos;
}

/** Build one big reference corpus from FE + packages src, excluding locale files. */
function buildReferenceCorpus(root) {
	const parts = [];
	for (const rel of I18N_REFERENCE_ROOTS) {
		const dir = join(root, rel);
		if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
		for (const file of walk(dir)) {
			const dot = file.lastIndexOf('.');
			if (dot === -1 || !I18N_SCAN_EXTENSIONS.has(file.slice(dot))) continue;
			const relPath = relative(root, file);
			// Exclude the locale definition files + generated typesafe-i18n artefacts:
			// a key's own definition (and its 9 sibling translations) is not a "use".
			if (/packages\/i18n\/src\/[^/]+\/index\.ts$/.test(relPath)) continue;
			if (/packages\/i18n\/src\/(i18n-|custom-types|formatters)/.test(relPath)) continue;
			parts.push(readFileSync(file, 'utf8'));
		}
	}
	return parts.join('\n');
}

/**
 * Pure i18n orphan matcher. A leaf is "referenced" when its full dot-path OR its
 * leaf-name token appears anywhere in the corpus. Zero-reference leaves are
 * orphans; an orphan under a dynamic-exempt prefix is reported but NOT removable.
 */
export function matchI18nOrphans(leaves, corpus, exemptPrefixes) {
	const orphans = [];
	for (const path of leaves) {
		if (corpus.includes(path)) continue; // full dotted path used literally
		const leaf = path.slice(path.lastIndexOf('.') + 1);
		const tokenRe = new RegExp(`\\b${escapeRe(leaf)}\\b`);
		if (tokenRe.test(corpus)) continue; // leaf name used somewhere (conservative)
		const exempt = exemptPrefixes.some((p) => path.startsWith(p));
		orphans.push({ path, exempt });
	}
	return orphans;
}

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse open TD ids from the register (lightweight — reuses the block shape). */
function parseOpenTdIds(registerSource) {
	const open = new Set();
	const lines = registerSource.split('\n');
	let inBlock = false;
	let fields = {};
	for (const line of lines) {
		if (line.trim() === '```debt') {
			inBlock = true;
			fields = {};
			continue;
		}
		if (inBlock && line.trim() === '```') {
			if (fields.status === 'open' && fields.id) open.add(fields.id);
			inBlock = false;
			continue;
		}
		if (inBlock) {
			const colon = line.indexOf(':');
			if (colon !== -1) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
		}
	}
	return open;
}

// ── Orchestration ───────────────────────────────────────────────────────────

export function runAudit(root) {
	// Section 1: RPC parity.
	const clientSource = read(root, CLIENT_TS);
	const routerSource = read(root, ROUTER_TS);
	const methods = parseTypedRpcMethods(clientSource);
	const importedSchemaNames = parseSchemaImports(clientSource);
	const registrations = parseRouterRegistrations(routerSource);
	const schemaExports = collectSchemaExports(root);
	const rpc = matchRpc(methods, registrations, importedSchemaNames, schemaExports);

	// Section 2: broadcast parity.
	const constMap = collectStringConsts(root);
	const { types: broadcastTypes, unresolved } = collectBroadcastTypes(root, constMap);
	const consumers = parseSubscriptionConsumers(read(root, SUBSCRIPTIONS_TS));
	const openTdIds = parseOpenTdIds(read(root, TD_REGISTER));
	const broadcasts = matchBroadcasts(
		broadcastTypes,
		consumers,
		openTdIds,
		BROADCAST_EXEMPT,
		BROADCAST_TD_SHIM,
	);

	// Section 3: i18n orphans (informational).
	const leaves = parseLocaleLeafKeys(read(root, EN_LOCALE));
	const corpus = buildReferenceCorpus(root);
	const orphans = matchI18nOrphans(leaves, corpus, I18N_DYNAMIC_EXEMPT_PREFIXES);

	const violations = [...rpc.violations, ...broadcasts.violations];
	return {
		rpc,
		broadcasts,
		broadcastTypes,
		unresolved,
		consumers,
		openTdIds,
		leaves,
		orphans,
		methods,
		importedSchemaNames,
		violations,
		ok: violations.length === 0,
	};
}

function buildReport(result) {
	const now = new Date().toISOString();
	const L = [];
	L.push('# Live-Correctness Audit — §A4: RPC / Broadcast / i18n Contract Parity');
	L.push('');
	L.push(`_Generated by \`scripts/audit-contract-parity.mjs\` at ${now}._`);
	L.push('');
	L.push(
		result.ok
			? '**Result: PASS** — every TypedRPC method resolves to a backend handler + schema export, and every backend broadcast type is consumed or shim-covered.'
			: '**Result: FAIL** — see violations below.',
	);
	L.push('');

	// Section 1.
	L.push('## 1. RPC contract parity (frontend TypedRPC → schema + handler)');
	L.push('');
	L.push(`Parsed **${result.methods.length}** TypedRPC methods from \`${CLIENT_TS}\`.`);
	L.push('');
	L.push('| Domain | Method | Backend handler | Optional |');
	L.push('|--------|--------|-----------------|----------|');
	for (const r of result.rpc.rows) {
		L.push(
			`| ${r.domain} | ${r.method} | ${r.handler ? '✓' : '✗ MISSING'} | ${r.optional ? 'yes (dev-gated)' : ''} |`,
		);
	}
	L.push('');
	const schemaExportNote =
		result.rpc.missingSchemaExports.length === 0
			? 'all resolve to a `@ceraui/rpc/schemas` export.'
			: `MISSING: ${result.rpc.missingSchemaExports.join(', ')}`;
	L.push(
		`Schema types imported by client.ts from \`@ceraui/rpc/schemas\`: **${result.importedSchemaNames.length}** checked; ${schemaExportNote}`,
	);
	if (result.rpc.violations.length > 0) {
		L.push('');
		L.push('**RPC violations:**');
		for (const v of result.rpc.violations) L.push(`- ${v}`);
	}
	L.push('');

	// Section 2.
	L.push('## 2. Broadcast contract parity (backend broadcast → frontend consumer)');
	L.push('');
	L.push(`Enumerated **${result.broadcastTypes.size}** static broadcast event types.`);
	L.push('');
	L.push('| Event type | Status | Detail |');
	L.push('|------------|--------|--------|');
	for (const r of result.broadcasts.rows) {
		L.push(`| \`${r.type}\` | ${r.status} | ${r.detail} |`);
	}
	L.push('');
	if (result.unresolved.size > 0) {
		L.push(
			`_Dynamic (variable/expression) broadcast first-args skipped (not a parity concern): ${[...result.unresolved].join('; ')}._`,
		);
		L.push('');
	}
	if (result.broadcasts.violations.length > 0) {
		L.push('**Broadcast violations:**');
		for (const v of result.broadcasts.violations) L.push(`- ${v}`);
		L.push('');
	}

	// Section 3.
	const removable = result.orphans.filter((o) => !o.exempt);
	const exemptOrphans = result.orphans.filter((o) => o.exempt);
	L.push('## 3. Orphan i18n keys (report only — never auto-removed)');
	L.push('');
	L.push(
		`Scanned **${result.leaves.length}** leaf keys in \`${EN_LOCALE}\`; ` +
			`**${result.orphans.length}** have zero references across ${I18N_REFERENCE_ROOTS.map((r) => `\`${r}\``).join(' + ')} ` +
			`(**${removable.length}** removable, **${exemptOrphans.length}** dynamic-exempt).`,
	);
	L.push('');
	L.push(
		'Reference rule (conservative — biased to UNDER-report so nothing live is flagged): a leaf is "referenced" ' +
			'when its full dot-path OR its leaf-name token appears anywhere in the corpus. A zero-reference leaf under a ' +
			'dynamic-key namespace is EXEMPT from removal.',
	);
	L.push('');
	L.push('**Dynamic-exempt namespaces (resolved via `t(key)` / bracket-index — never removed):**');
	for (const p of I18N_DYNAMIC_EXEMPT_PREFIXES) L.push(`- \`${p}*\``);
	L.push('');
	if (removable.length > 0) {
		L.push('**Removable (provably-dead — zero references, not dynamic-exempt):**');
		for (const o of removable) L.push(`- \`${o.path}\``);
		L.push('');
		L.push(
			'> Remove ONLY after a manual grep re-confirms zero references (including dynamic dot-path construction sites), then regenerate typesafe-i18n.',
		);
	} else {
		L.push('**Removable:** none — no provably-dead key outside the dynamic-exempt namespaces.');
	}
	L.push('');
	if (exemptOrphans.length > 0) {
		L.push(
			'<details><summary>Dynamic-exempt zero-reference leaves (reported, NOT removed)</summary>',
		);
		L.push('');
		for (const o of exemptOrphans) L.push(`- \`${o.path}\``);
		L.push('');
		L.push('</details>');
		L.push('');
	}

	// Section 4: structural findings + actions taken (durable record).
	L.push('## 4. Structural findings & actions taken');
	L.push('');
	L.push(
		'- **`device.activeProfile` fans out to UI clients with no consumer** — the active-profile ' +
			'reporter emits the `ACTIVE_PROFILE_STATUS` frame via `broadcastMsg`, the correct transport for the ' +
			'device→platform status relay, but `broadcastMsg` also delivers it to the authenticated UI sockets, where ' +
			'`subscriptions.svelte.ts` has no `case` and falls through to `default: console.warn(...)`. Benign (drives ' +
			'nothing in the UI) but a producer-without-consumer mismatch + dev-console noise. Registered as ' +
			'`TD-active-profile-ui-fanout` (open) in `docs/TECHNICAL_DEBT.md`; the audit classifies it relay/transport-exempt ' +
			'so the parity gate stays green.',
	);
	L.push(
		'- **Dead-key removal performed this pass:** the entire `settings.streamTuning.*` block was removed from ' +
			'all 10 locale files — verified zero references across `apps/frontend/src` + `apps/backend/src` + `packages` ' +
			'+ tests (the `StreamTuningSection` component was deleted in the receiver-coherence v2 pass). typesafe-i18n was ' +
			'regenerated; the locale-parity gate + `frontend check` + backend `tsc --noEmit` stay green. The remaining ' +
			'removable candidates above are left for a dedicated cleanup pass (larger blast radius + concurrent-session risk).',
	);
	L.push('');
	L.push('---');
	L.push('');
	L.push(
		'_Exit-code contract: sections 1 (RPC parity) and 2 (broadcast parity) are HARD gates (a miss exits 1, ' +
			'naming the unmatched method/broadcast). Section 3 (i18n orphans) is informational — it never fails the run. ' +
			'`--self-test` drives the pure matchers against synthetic fixtures to prove the hard-fail path._',
	);

	return L.join('\n');
}

// ── Self-test (proves the hard-fail path without touching shipped source) ─────
function selfTest() {
	const failures = [];

	// RPC matcher: a fake method with no handler must be flagged.
	const fakeMethods = [{ domain: 'ghost', method: 'phantom', optional: false }];
	const emptyReg = new Map();
	const rpcResult = matchRpc(fakeMethods, emptyReg, [], new Set());
	if (
		rpcResult.violations.length === 0 ||
		!rpcResult.violations.some((v) => v.includes('ghost.phantom'))
	) {
		failures.push('RPC matcher did NOT flag an unmatched method `ghost.phantom`');
	}
	// RPC matcher: a matched method must NOT be flagged.
	const okReg = new Map([['auth', new Set(['login'])]]);
	const okRpc = matchRpc(
		[{ domain: 'auth', method: 'login', optional: false }],
		okReg,
		[],
		new Set(),
	);
	if (okRpc.violations.length !== 0) {
		failures.push('RPC matcher wrongly flagged a matched method `auth.login`');
	}
	// RPC matcher: an imported schema type missing from the barrel must be flagged.
	const missing = matchRpc([], new Map(), ['GhostInput'], new Set(['LoginInput']));
	if (!missing.violations.some((v) => v.includes('GhostInput'))) {
		failures.push('RPC matcher did NOT flag an unexported schema import `GhostInput`');
	}

	// Broadcast matcher: an unmatched type must be flagged.
	const bTypes = new Map([['ghostbroadcast', [{ file: 'x.ts', const: null }]]]);
	const bResult = matchBroadcasts(bTypes, new Set(), new Set(), new Map(), new Map());
	if (!bResult.violations.some((v) => v.includes('ghostbroadcast'))) {
		failures.push('Broadcast matcher did NOT flag an unmatched type `ghostbroadcast`');
	}
	// Broadcast matcher: consumed / exempt / td-shim must NOT be flagged.
	const okB = matchBroadcasts(
		new Map([
			['status', []],
			['ping', []],
			['pipelines', []],
		]),
		new Set(['status']),
		new Set(['TD-legacy-source-broadcasts']),
		new Map([['ping', 'transport']]),
		new Map([['pipelines', 'TD-legacy-source-broadcasts']]),
	);
	if (okB.violations.length !== 0) {
		failures.push(`Broadcast matcher wrongly flagged a matched type: ${okB.violations.join('; ')}`);
	}

	// i18n matcher: a zero-reference non-exempt leaf is a removable orphan; an
	// exempt one is reported-not-removable; a referenced one is not an orphan.
	const orphans = matchI18nOrphans(
		['a.deadleaf', 'live.education.reason.dynamicOnly', 'b.usedleaf'],
		'someCode usedleaf here',
		I18N_DYNAMIC_EXEMPT_PREFIXES,
	);
	const dead = orphans.find((o) => o.path === 'a.deadleaf');
	const dyn = orphans.find((o) => o.path === 'live.education.reason.dynamicOnly');
	const used = orphans.find((o) => o.path === 'b.usedleaf');
	if (!dead || dead.exempt)
		failures.push('i18n matcher did NOT flag removable orphan `a.deadleaf`');
	if (!dyn?.exempt) failures.push('i18n matcher did NOT exempt dynamic orphan');
	if (used) failures.push('i18n matcher wrongly flagged referenced leaf `b.usedleaf`');

	if (failures.length > 0) {
		console.error('SELF-TEST FAILED:');
		for (const f of failures) console.error(`  - ${f}`);
		return 1;
	}
	// biome-ignore lint/suspicious/noConsole: CLI tool stdout is its result output
	console.log(
		'SELF-TEST PASSED — matchers correctly flag unmatched method/broadcast and dead i18n keys.',
	);
	return 0;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function main() {
	const args = process.argv.slice(2);
	if (args.includes('--self-test')) {
		process.exit(selfTest());
	}
	const rootArg = args.find((a) => !a.startsWith('--'));
	const root = rootArg ? resolve(rootArg) : DEFAULT_ROOT;
	const result = runAudit(root);
	const report = buildReport(result);

	const outPath = join(root, REPORT_OUT);
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, report);

	// biome-ignore lint/suspicious/noConsole: CLI tool stdout is its result output
	console.log(
		`audit-contract-parity: ${result.methods.length} RPC methods, ${result.broadcastTypes.size} broadcast types, ` +
			`${result.leaves.length} i18n leaves (${result.orphans.length} zero-ref).`,
	);
	// biome-ignore lint/suspicious/noConsole: CLI tool stdout is its result output
	console.log(`Report written to ${REPORT_OUT}`);

	if (!result.ok) {
		console.error('CONTRACT PARITY FAILED:');
		for (const v of result.violations) console.error(`  - ${v}`);
		process.exit(1);
	}
	// biome-ignore lint/suspicious/noConsole: CLI tool stdout is its result output
	console.log('Contract parity OK — all TypedRPC methods + broadcast types matched.');
	process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main();
}
