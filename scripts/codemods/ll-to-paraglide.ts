/**
 * Codemod: legacy `$LL` / `getLL()` call sites -> paraglide `m["dotted.key"]()`.
 *
 * Run:  bun scripts/codemods/ll-to-paraglide.ts [--dry]
 *
 * WHY A LEXICAL SCANNER AND NOT `ast-grep`
 * ----------------------------------------
 * ast-grep 0.45.1 has NO Svelte grammar (`--lang svelte` -> "svelte is not
 * supported!"), and ~93% of the call sites live inside `.svelte` template
 * expressions, which no TypeScript parser accepts either. The transform itself
 * is purely lexical — `$LL` followed by a dotted identifier chain followed by a
 * call — so a scanner is exact for this grammar. What makes it SAFE rather than
 * a hopeful regex is the oracle: every key the scanner derives is checked
 * against the 1 472-key catalog (`packages/i18n/messages/en.json`) before the
 * rewrite is emitted. A misfire cannot silently ship — it either fails the key
 * check and is reported untouched, or it is a real key.
 *
 * IDEMPOTENT BY CONSTRUCTION: every rule keys off a token (`$LL`, `getLL()`,
 * the legacy import specifier) that the rule itself removes, so a second run
 * finds nothing and writes nothing.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Glob } from 'bun';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(REPO, 'apps/frontend/src');
const CATALOG = join(REPO, 'packages/i18n/messages/en.json');

const LEGACY_MODULE = '@ceraui/i18n/i18n-svelte5';
const FACADE_MODULE = '@ceraui/i18n/svelte';

const DRY = process.argv.includes('--dry');

/** The verbatim dotted keys paraglide exposes. The rewrite oracle. */
const KEYS = new Set(
	Object.keys(JSON.parse(readFileSync(CATALOG, 'utf8')) as Record<string, unknown>).filter(
		(k) => k !== '$schema',
	),
);

interface Report {
	file: string;
	rewrites: number;
	unresolved: string[];
}

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';
const CHAIN = `(?:\\??\\.${IDENT})+`;
/** The call tail: `(` or the optional-call `?.(`. */
const TAIL = '((?:\\?\\.)?\\()';
/** `$LL.a.b.c(`, `$LL?.a?.b?.(`, and the `getLL()` accessor form. */
const CALL_RE = new RegExp(`(\\$LL|getLL\\(\\))(${CHAIN})${TAIL}`, 'g');
/**
 * `const t = $derived($LL.settings.deviceStats);` — a namespace alias bound to a
 * NON-leaf node of the old proxy tree. There is no paraglide equivalent (the
 * registry is flat), so the binding is deleted and every `t.foo()` through it is
 * re-expanded to the full dotted key.
 */
const ALIAS_RE = new RegExp(
	`^([ \\t]*)const (${IDENT}) = (?:\\$derived\\(\\$LL(${CHAIN})\\)|\\$LL(${CHAIN})|(?:getLL\\(\\)|get\\(LL\\))(${CHAIN})?);[ \\t]*\\n`,
	'gm',
);

/**
 * Prose in comments that names the old API. Rewording these is the only
 * non-call-site edit this codemod makes; exact-match so it is idempotent.
 */
const COMMENT_REWRITES: ReadonlyArray<readonly [string, string]> = [
	[
		'// i18n keys for disabled-option reason tooltips. Consumers pass these to LL\n// (e.g. LL.live.education.reason.unsupportedPlatform()) — never render the key',
		'// i18n keys for disabled-option reason tooltips. Consumers resolve these through\n// `m` (e.g. m["live.education.reason.unsupportedPlatform"]()) — never render the key',
	],
	[
		' * network-ingest gateway is not active. Consumers pass this to `LL`\n * (e.g. `LL.live.education.reason.gatewayInactive()`) — never render the key',
		' * network-ingest gateway is not active. Consumers resolve this through `m`\n * (e.g. `m["live.education.reason.gatewayInactive"]()`) — never render the key',
	],
	[
		' * Pure + rune-free: it imports no Svelte runtime and no live `$LL`, so the',
		' * Pure + rune-free: it imports no Svelte runtime and no live message store, so the',
	],
	[
		' * through the `$LL` proxy — never render the key string directly. The key names',
		' * through `m["<key>"]()` — never render the key string directly. The key names',
	],
	[
		'/** i18n resolvers the summary composes, keeping {@link buildServerSummary} `$LL`-free. */',
		'/** i18n resolvers the summary composes, keeping {@link buildServerSummary} message-free. */',
	],
	[
		' * Display text is resolved *once, at push time* via `$LL`',
		' * Display text is resolved *once, at push time* via the message registry',
	],
	[
		' * `notifications.svelte.ts` statically imports `@ceraui/i18n/i18n-svelte5`, whose',
		' * `notifications.svelte.ts` statically imports `@ceraui/i18n/svelte`, whose',
	],
	[
		' * imports `@ceraui/i18n/i18n-svelte5` (declares Svelte runes). Mock it so importing',
		' * imports `@ceraui/i18n/svelte` (declares Svelte runes). Mock it so importing',
	],
	[
		' * (`@ceraui/i18n/i18n-svelte5`): when `key` is present and exists in the translation',
		' * (`@ceraui/i18n/svelte`): when `key` is present and exists in the translation',
	],
	[
		'	/** Resolved display text (`$LL[key](params)` or `msg` fallback). */',
		'	/** Resolved display text (`m[key](params)` or `msg` fallback). */',
	],
	[
		'/** A callable translation leaf as exposed by the `$LL` proxy. */',
		'/** A callable translation leaf as exposed by the `m` registry. */',
	],
	[
		' * Uses an explicit `in` guard at each step so the live `$LL` Proxy (whose `has`',
		' * Uses an explicit `in` guard at each step so the live `m` Proxy (whose `has`',
	],
	[
		' * `string | number | boolean` shape the `$LL` interpolator expects. Non-scalar',
		' * `string | number | boolean` shape the message interpolator expects. Non-scalar',
	],
	[
		'  label copy is the shared `kindBadgeLabelKey` resolved through the `$LL` proxy.',
		'  label copy is the shared `kindBadgeLabelKey` resolved through `resolveMessageKey`.',
	],
	[
		'		// en-backed $LL proxy (LiveView itself is too dep-heavy to mount in a unit).',
		'		// en-backed message registry (LiveView itself is too dep-heavy to mount in a unit).',
	],
	[
		' * the store resolves `$LL` to a plain tree rather than evaluating the adapter.',
		' * the store resolves messages from a plain tree rather than evaluating the adapter.',
	],
	[
		' * explicit `translations` tree rather than reading the live `$LL`.',
		' * explicit `translations` tree rather than reading the live registry.',
	],
	[
		'/** A minimal stand-in for the `$LL` translation tree (nested + interpolating). */',
		'/** A minimal stand-in for the message registry (flat dotted keys + interpolating). */',
	],
	[
		'// `$LL`. This suite drives the runes store end-to-end, where `push()` resolves',
		'// the registry. This suite drives the runes store end-to-end, where `push()` resolves',
	],
	[
		'	it("resolves `key` via the mocked `$LL` with `params` (not the raw key string)", () => {',
		'	it("resolves `key` via the mocked registry with `params` (not the raw key string)", () => {',
	],
	[
		'// assert the SINGLE failure-feedback path, and `getLL()` returns a minimal shape',
		'// assert the SINGLE failure-feedback path, and the mocked `m` returns a minimal shape',
	],
	[
		'// text via the live `getLL()` — mocked here to a real tree so we assert keys',
		'// text via the live registry — mocked here to a real map so we assert keys',
	],
	[
		' * attribute equals the value resolved through `$LL` (the runes i18n adapter',
		' * attribute equals the value resolved through `m` (the paraglide message registry',
	],
	[
		'	it("renders the static-IP input with the placeholder from $LL, not a hardcoded literal", () => {',
		'	it("renders the static-IP input with the placeholder from the catalog, not a hardcoded literal", () => {',
	],
	[
		'  Labels are passed in (consumer supplies `$LL.*`) so this shared primitive stays',
		'  Labels are passed in (consumer supplies `m["…"]()`) so this shared primitive stays',
	],
	[
		'  All copy is `$LL.live.education.tier.*`. The banner stays in normal document',
		'  All copy is `m["live.education.tier.*"]`. The banner stays in normal document',
	],
];

/** Rewrite `$LL.a.b.c(` / `getLL().a.b.c(` -> `m["a.b.c"](`, oracle-checked. */
function rewriteCalls(source: string, unresolved: string[]): [string, number] {
	let count = 0;
	const out = source.replace(CALL_RE, (match, _head: string, chain: string, tail: string) => {
		const key = chain
			.split('.')
			.slice(1)
			.map((segment) => segment.replace(/\?$/, ''))
			.join('.');
		if (!KEYS.has(key)) {
			unresolved.push(match);
			return match;
		}
		count += 1;
		return `m[${JSON.stringify(key)}]${tail}`;
	});
	return [out, count];
}

/**
 * The per-site dotted-key walkers (`let result: unknown = $LL; for (const part of
 * key.split("."))…`). Ten files carry a byte-identical fallback — miss returns the
 * key, non-function returns the key — which `resolveMessageKey` reproduces, so the
 * whole body collapses to a delegation. Anchored on the unique `unknown = $LL;`
 * line and on the opening line's own indentation, so the lazy spans cannot run past
 * the helper's closing brace.
 */
const WALKER_RE =
	/^([ \t]*)(?:const (\w+) = \(key: string\): string => \{|function (\w+)\(key: string\): string \{)\n[\s\S]*?unknown = \$LL;\n[\s\S]*?\n\1\}(;?)\n/gm;

function rewriteWalkers(source: string): [string, number] {
	let count = 0;
	const out = source.replace(
		WALKER_RE,
		(_whole, indent: string, arrowName: string | undefined, fnName: string | undefined) => {
			count += 1;
			if (arrowName !== undefined) return `${indent}const ${arrowName} = resolveMessageKey;\n`;
			return (
				`${indent}function ${fnName}(key: string): string {\n` +
				`${indent}\treturn resolveMessageKey(key);\n` +
				`${indent}}\n`
			);
		},
	);
	return [out, count];
}

/** Delete `const t = $derived($LL.ns.sub)` bindings and inline their full keys. */
function rewriteAliases(source: string, unresolved: string[]): [string, number] {
	let out = source;
	let count = 0;
	const expandedAliases = new Set<string>();
	for (const match of [...source.matchAll(ALIAS_RE)]) {
		const alias = match[2] ?? '';
		const prefix = (match[3] ?? match[4] ?? match[5] ?? '').slice(1);
		const useRe = new RegExp(`\\b${alias}((?:\\.${IDENT})+)${TAIL}`, 'g');
		let used = 0;
		const expanded = out.replace(useRe, (whole, chain: string, tail: string) => {
			const key = prefix === '' ? chain.slice(1) : `${prefix}${chain}`;
			if (!KEYS.has(key)) {
				unresolved.push(whole);
				return whole;
			}
			used += 1;
			return `m[${JSON.stringify(key)}]${tail}`;
		});
		// A file may rebind the same alias per test/scope; the first pass already
		// expanded every use in the file, so the later bindings are simply dead.
		if (used === 0 && !expandedAliases.has(`${alias}\u0000${prefix}`)) {
			unresolved.push(`alias ${alias} -> ${prefix}: no resolvable use`);
			continue;
		}
		expandedAliases.add(`${alias}\u0000${prefix}`);
		out = expanded.replace(match[0], '');
		count += used;
	}
	return [out, count];
}

/** Collapse the legacy import into the facade import the rewritten file needs. */
function rewriteImports(source: string, file: string, unresolved: string[]): string {
	const legacy = new RegExp(
		`^[ \\t]*import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${LEGACY_MODULE}['"];?[ \\t]*\\n`,
		'm',
	);
	const legacyMatch = legacy.exec(source);
	if (legacyMatch === null) return source;

	const quote = legacyMatch[0].includes(`"${LEGACY_MODULE}"`) ? '"' : "'";
	const specifiers = (legacyMatch[1] ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	let body = source.replace(legacy, '');
	const needed = new Set<string>();

	for (const specifier of specifiers) {
		if (specifier === 'LL') continue; // consumed by rewriteCalls
		if (specifier === 'locale') {
			// `$locale` (legacy store auto-subscription) -> the reactive getter.
			body = body.replace(/\$locale\b/g, 'getLocale()');
			needed.add('getLocale');
			continue;
		}
		if (specifier === 'getLL') continue; // consumed by rewriteCalls
		if (specifier === 'setLocale' || specifier.startsWith('setLocale as')) continue;
		unresolved.push(`unmapped import specifier: ${specifier} (${file})`);
	}

	if (/\bm\[/.test(body)) needed.add('m');
	if (/\bresolveMessageKey\b/.test(body)) needed.add('resolveMessageKey');

	if (needed.size === 0) return body;

	// Merge into an existing facade import when the file already has one.
	const facade = new RegExp(
		`^([ \\t]*import\\s*\\{)([^}]*)(\\}\\s*from\\s*['"]${FACADE_MODULE}['"];?[ \\t]*\\n)`,
		'm',
	);
	const facadeMatch = facade.exec(body);
	if (facadeMatch !== null) {
		const merged = new Set([
			...(facadeMatch[2] ?? '')
				.split(',')
				.map((s) => s.trim())
				.filter((s) => s.length > 0),
			...needed,
		]);
		return body.replace(
			facade,
			`${facadeMatch[1]} ${[...merged].sort().join(', ')} ${facadeMatch[3]}`,
		);
	}

	const line = `import { ${[...needed].sort().join(', ')} } from ${quote}${FACADE_MODULE}${quote};\n`;
	// Reinstate at the legacy import's own position to keep the diff local.
	const anchor = legacyMatch.index;
	return `${body.slice(0, anchor)}${line}${body.slice(anchor)}`;
}

function transform(source: string, file: string, unresolved: string[]): [string, number] {
	let out = source;
	for (const [from, to] of COMMENT_REWRITES) {
		out = out.split(from).join(to);
	}
	const [withWalkers, walkerCount] = rewriteWalkers(out);
	const [withAliases, aliasCount] = rewriteAliases(withWalkers, unresolved);
	const [withCalls, callCount] = rewriteCalls(withAliases, unresolved);
	out = rewriteImports(withCalls, file, unresolved);
	return [out, walkerCount + aliasCount + callCount];
}

function main(): void {
	const reports: Report[] = [];
	let changed = 0;
	let total = 0;

	for (const rel of new Glob('**/*.{svelte,ts}').scanSync(SRC)) {
		const path = join(SRC, rel);
		const source = readFileSync(path, 'utf8');
		const unresolved: string[] = [];
		const [next, count] = transform(source, rel, unresolved);
		total += count;
		if (next !== source) {
			changed += 1;
			if (!DRY) writeFileSync(path, next);
		}
		if (count > 0 || unresolved.length > 0) {
			reports.push({ file: rel, rewrites: count, unresolved });
		}
	}

	for (const report of reports) {
		if (report.unresolved.length === 0) continue;
		process.stdout.write(`UNRESOLVED ${report.file}\n`);
		for (const item of new Set(report.unresolved)) process.stdout.write(`    ${item}\n`);
	}
	process.stdout.write(
		`${DRY ? '[dry] ' : ''}${total} call sites rewritten across ${changed} files; ` +
			`${reports.reduce((n, r) => n + r.unresolved.length, 0)} unresolved\n`,
	);
}

main();
