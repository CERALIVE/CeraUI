#!/usr/bin/env bun
// Bundle-delta gate for the built SPA and the federation bundles.
//
// Every budget is RELATIVE to the pre-migration baseline captured at commit
// 2b9051b8 (plan todo 19), archived repo-locally under
// `test-results/premigration-build/`. The absolute ceilings are a SECOND
// constraint, not a replacement: a budget is the SMALLER of the two.
//
// BASELINE (gzip level 9 under Bun — Bun's zlib and Node's differ by ~0.3%, so
// the baseline is Bun's, matching CI). Reproduce with:
//   bun scripts/ci/bundle-report.mjs --dist test-results/premigration-build/public
//
// Raising a number here is NOT how a breach gets fixed. The catalog is the only
// lever with real headroom, and it has exactly one: flip namespaces from eager
// to lazy in `EAGER_NAMESPACES` (packages/i18n/scripts/generate-registry.ts).
// Under rolldown a statically-reachable chunk cannot be split by naming it, so a
// dynamic import is the only thing that moves bytes out of the entry chunk.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const KIB = 1024;

const SPA_BASELINE = {
	totalGzip: 762_410,
	initialRouteGzip: 497_196,
	largestChunkGzip: 461_577,
	precacheGzip: 903_286,
};

// Per-file, keyed on the emitted federation filename. Entry names are stable;
// shared chunks are hashed, so they are matched on the pre-hash stem. Captured by
// building `bun run build:federation` in a worktree at the baseline commit.
//
// KNOWN BREACH — `toast-host.js`, the shared chunk that carries the message
// catalog for all three dialogs. A federation bundle is fetched as ONE hosted
// module against a signed manifest pinning an exact chunk graph, so it cannot use
// the SPA's lazily-imported namespace chunks: it registers the catalog
// statically (`lib/federation/messages.ts`). Paraglide's per-message ×10-locale
// expansion makes that catalog ~3x the typesafe-i18n dictionaries it replaced,
// and unlike the SPA there is no split to spend. Splitting it here would only
// move the same bytes into sibling files to slip under a PER-FILE budget, so it
// is reported rather than dodged. Real remedies, both outside this gate:
// `outputStructure: "locale-modules"`, or dynamic namespace chunks with manifest
// + signing + CSP coverage on the platform side.
const FEDERATION_BASELINE = {
	'toast-host.js': 223_579,
	'server.js': 26_645,
	'frontend.css': 24_087,
	'encoder.js': 22_713,
	'audio.js': 7_009,
	'InfoPopover.js': 6_104,
	'input.js': 3_845,
};

const budget = (baseline, ratio, absolute) =>
	Math.floor(
		absolute === undefined ? baseline * ratio : Math.min(baseline * ratio, baseline + absolute),
	);

const kib = (bytes) => `${(bytes / KIB).toFixed(1)} KiB`;

const gzipBytes = (dir, relativePath) =>
	gzipSync(readFileSync(join(dir, relativePath)), { level: 9 }).length;

/** Every url in the service worker's injected `precacheAndRoute([...])` manifest. */
function precacheUrls(dist) {
	const sw = readFileSync(join(dist, 'sw.js'), 'utf8');
	const callIndex = sw.indexOf('precacheAndRoute(');
	const arrayStart = sw.indexOf('[', callIndex);
	if (callIndex === -1 || arrayStart === -1) {
		throw new Error('sw.js carries no precacheAndRoute(...) manifest');
	}
	let depth = 0;
	let arrayEnd = -1;
	for (let i = arrayStart; i < sw.length; i += 1) {
		if (sw[i] === '[') depth += 1;
		else if (sw[i] === ']' && --depth === 0) {
			arrayEnd = i;
			break;
		}
	}
	if (arrayEnd === -1) throw new Error('sw.js precache manifest array is unterminated');
	return [
		...sw.slice(arrayStart, arrayEnd + 1).matchAll(/["']?url["']?\s*:\s*["']([^"']+)["']/g),
	].map((match) => match[1].replace(/^\.?\//, ''));
}

function measureSpa(dist) {
	const html = readFileSync(join(dist, 'index.html'), 'utf8');
	const initialSet = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map(
		([, ref]) => ref,
	);
	if (initialSet.length === 0) {
		throw new Error(
			`no JS references in ${dist}/index.html — run \`bun run build:frontend\` first`,
		);
	}
	const rows = readdirSync(join(dist, 'assets'))
		.filter((name) => name.endsWith('.js') || name.endsWith('.css'))
		.map((name) => ({
			ref: `assets/${name}`,
			gzip: gzipBytes(dist, `assets/${name}`),
			initial: initialSet.includes(`assets/${name}`),
		}))
		.sort((left, right) => right.gzip - left.gzip);

	return {
		rows,
		totalGzip: rows.reduce((total, row) => total + row.gzip, 0),
		initialRouteGzip: initialSet.reduce((total, ref) => total + gzipBytes(dist, ref), 0),
		largestChunkGzip: rows[0].gzip,
		precacheGzip: precacheUrls(dist)
			.filter((url) => existsSync(join(dist, url)))
			.reduce((total, url) => total + gzipBytes(dist, url), 0),
	};
}

// Strips rolldown's `-<hash>` before the extension so a chunk matches its
// baseline. The class excludes `-` on purpose: a hash never contains one, and
// allowing it swallows the name too (`toast-host-duUb1s03.js` -> `toast.js`).
export function federationStem(filename) {
	return filename.replace(/-[A-Za-z0-9_]{8,}(?=\.[a-z]+$)/, '');
}

function measureFederation(dir) {
	return readdirSync(dir)
		.filter((name) => name.endsWith('.js') || name.endsWith('.css'))
		.map((name) => ({ name, stem: federationStem(name), gzip: gzipBytes(dir, name) }))
		.sort((left, right) => right.gzip - left.gzip);
}

const failures = [];

function check(label, actual, allowed, baseline) {
	const delta =
		baseline === undefined
			? ''
			: ` (baseline ${kib(baseline)}, ${((actual / baseline - 1) * 100).toFixed(1)}%)`;
	const verdict = actual > allowed ? 'FAIL' : 'ok';
	process.stdout.write(
		`${verdict.padEnd(5)} ${label.padEnd(34)} ${kib(actual).padStart(11)} of ${kib(allowed).padStart(11)}${delta}\n`,
	);
	if (actual > allowed) {
		failures.push(`${label}: ${actual} B exceeds the ${allowed} B budget by ${actual - allowed} B`);
	}
}

const distArg = process.argv.indexOf('--dist');
const DIST = distArg === -1 ? 'dist/public' : process.argv[distArg + 1];
const spa = measureSpa(DIST);

const report = ['chunk                                          gzip      initial-route'];
for (const row of spa.rows) {
	report.push(`${row.ref.padEnd(46)} ${kib(row.gzip).padStart(10)}  ${row.initial ? 'yes' : ''}`);
}
process.stdout.write(`${report.join('\n')}\n\n`);

check(
	'total SPA JS+CSS gzip',
	spa.totalGzip,
	budget(SPA_BASELINE.totalGzip, 1.12),
	SPA_BASELINE.totalGzip,
);
check(
	'service-worker precache gzip',
	spa.precacheGzip,
	budget(SPA_BASELINE.precacheGzip, 1.12),
	SPA_BASELINE.precacheGzip,
);
check(
	'largest single chunk gzip',
	spa.largestChunkGzip,
	budget(SPA_BASELINE.largestChunkGzip, 1.15),
	SPA_BASELINE.largestChunkGzip,
);
check(
	'initial-route JS gzip',
	spa.initialRouteGzip,
	budget(SPA_BASELINE.initialRouteGzip, 1.1, 200 * KIB),
	SPA_BASELINE.initialRouteGzip,
);

// Federation is built by a SEPARATE command, so its absence is not a failure —
// `build:frontend` alone legitimately leaves dist/federation empty.
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const federationDir = join('dist', 'federation', version);
if (existsSync(federationDir)) {
	process.stdout.write(`\nfederation ${federationDir}\n`);
	for (const asset of measureFederation(federationDir)) {
		const baseline = FEDERATION_BASELINE[asset.stem];
		if (baseline === undefined) {
			failures.push(`federation ${asset.name}: no baseline for stem ${asset.stem}`);
			process.stdout.write(
				`FAIL  ${asset.name.padEnd(34)} ${kib(asset.gzip).padStart(11)} — unbaselined asset\n`,
			);
			continue;
		}
		check(`federation ${asset.stem}`, asset.gzip, budget(baseline, 1.1, 150 * KIB), baseline);
	}
} else {
	process.stdout.write(`\nfederation: ${federationDir} absent — skipped\n`);
}

if (failures.length > 0) {
	for (const failure of failures) console.error(`::error::${failure}`);
	process.exit(1);
}
