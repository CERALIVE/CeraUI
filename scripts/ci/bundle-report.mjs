#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// Per-chunk gzip report for the built SPA, plus a hard budget on the
// initial-route JS set (the entry script and every chunk index.html
// modulepreloads — i.e. the bytes a cold first paint actually pays for).
//
// BUDGET BASELINE (measured 2026-08-14 on chore/deps-orpc2-ts7spike-2026-08,
// `bun run build:frontend`, then this script under Bun — Bun's zlib and
// Node's differ by ~0.3%, so the baseline is Bun's, matching CI):
//   initial-route JS gzip = 497_197 B across 5 chunks
//     devtools      461_577  (the dominant chunk — see note below)
//     index          23_048
//     vendor-core     9_879
//     vendor-misc     2_263
//     rolldown-rt        430
// Budget = baseline + 10% = 546_917 B. Raise it only with a recorded
// re-measurement; a growth beyond 10% is a regression to explain, not a
// number to bump.
//
// NOTE for the i18n/lazy-loading waves: `devtools` is 93% of the initial set
// today. Splitting it out of the initial graph is the single largest win
// available and would make this budget dramatically tighter — re-baseline
// deliberately if that lands.
import { gzipSync } from 'node:zlib';

const INITIAL_ROUTE_JS_GZIP_BUDGET_BYTES = 546_917;
const DIST = 'dist/public';
const ASSET_REF = /(?:src|href)="\/(assets\/[^"]+\.js)"/g;

const gzipBytes = (relativePath) =>
	gzipSync(readFileSync(join(DIST, relativePath)), { level: 9 }).length;

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const initialSet = [...html.matchAll(ASSET_REF)].map(([, ref]) => ref);
if (initialSet.length === 0) {
	console.error(`bundle-report: no JS references found in ${DIST}/index.html — build first`);
	process.exit(1);
}

const rows = readdirSync(join(DIST, 'assets'))
	.filter((name) => name.endsWith('.js') || name.endsWith('.css'))
	.map((name) => {
		const ref = `assets/${name}`;
		return { ref, gzip: gzipBytes(ref), initial: initialSet.includes(ref) };
	})
	.sort((left, right) => right.gzip - left.gzip);

const report = ['chunk                                          gzip      initial-route'];
for (const row of rows) {
	report.push(`${row.ref.padEnd(46)} ${kib(row.gzip).padStart(10)}  ${row.initial ? 'yes' : ''}`);
}

const initialGzip = initialSet.reduce((total, ref) => total + gzipBytes(ref), 0);
const totalGzip = rows.reduce((total, row) => total + row.gzip, 0);
report.push(
	'',
	`total JS+CSS gzip:      ${kib(totalGzip)}`,
	`initial-route JS gzip:  ${kib(initialGzip)} of ${kib(INITIAL_ROUTE_JS_GZIP_BUDGET_BYTES)} budget`,
	'',
);
process.stdout.write(report.join('\n'));

if (initialGzip > INITIAL_ROUTE_JS_GZIP_BUDGET_BYTES) {
	console.error(
		`::error::initial-route JS gzip ${initialGzip} B exceeds the ${INITIAL_ROUTE_JS_GZIP_BUDGET_BYTES} B budget by ${initialGzip - INITIAL_ROUTE_JS_GZIP_BUDGET_BYTES} B`,
	);
	process.exit(1);
}
