#!/usr/bin/env node
// PWA precache regression gate.
//
// vite-plugin-pwa injects the precache manifest into the generated service worker at
// build time. When a Vite/Workbox/plugin upgrade changes chunk naming, output layout,
// or the `globPatterns` semantics, the manifest can silently stop covering emitted
// assets — the app still builds, still boots online, and only fails offline, where
// nobody looks. This gate turns that silent drift into a build failure.
//
// PASS: dist/public/sw.js exists AND every built dist/public/assets/*.{js,css} file is
// listed in the injected precache manifest.
// FAIL: prints the uncovered filenames and exits 1.
//
// Run from anywhere: `bun apps/frontend/scripts/check-precache.mjs` (paths resolve off
// this file, not the cwd).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distPublic = path.resolve(scriptDir, '../../../dist/public');
const swPath = path.join(distPublic, 'sw.js');
const assetsDir = path.join(distPublic, 'assets');

function fail(message) {
	console.error(`check-precache: FAIL — ${message}`);
	process.exit(1);
}

if (!existsSync(swPath)) {
	fail(`no service worker at ${swPath}. Run \`bun run build:frontend\` first.`);
}

if (!existsSync(assetsDir)) {
	fail(`no built assets at ${assetsDir}. Run \`bun run build:frontend\` first.`);
}

const sw = readFileSync(swPath, 'utf8');

// Scope extraction to the injected precacheAndRoute([...]) call so runtimeCaching
// url patterns elsewhere in the SW can never be mistaken for precache entries.
const callIndex = sw.indexOf('precacheAndRoute(');
if (callIndex === -1) {
	fail('sw.js contains no precacheAndRoute(...) call — the precache manifest was not injected.');
}

const arrayStart = sw.indexOf('[', callIndex);
if (arrayStart === -1) {
	fail('precacheAndRoute(...) call has no manifest array.');
}

let depth = 0;
let arrayEnd = -1;
for (let i = arrayStart; i < sw.length; i += 1) {
	const char = sw[i];
	if (char === '[') {
		depth += 1;
	} else if (char === ']') {
		depth -= 1;
		if (depth === 0) {
			arrayEnd = i;
			break;
		}
	}
}

if (arrayEnd === -1) {
	fail('precacheAndRoute(...) manifest array is unterminated.');
}

const manifestSource = sw.slice(arrayStart, arrayEnd + 1);

// Entries are minified objects: {url:"assets/index-Cz2S9M42.js",revision:null}.
// Both quoted and unquoted `url` keys are accepted so a minifier change cannot make
// this gate silently match nothing.
const manifestUrls = new Set();
for (const match of manifestSource.matchAll(/["']?url["']?\s*:\s*["']([^"']+)["']/g)) {
	manifestUrls.add(match[1].replace(/^\.?\//, ''));
}

if (manifestUrls.size === 0) {
	fail('precache manifest array parsed but contained no url entries.');
}

const builtAssets = readdirSync(assetsDir)
	.filter((name) => name.endsWith('.js') || name.endsWith('.css'))
	.map((name) => `assets/${name}`)
	.sort();

if (builtAssets.length === 0) {
	fail(`no .js/.css files under ${assetsDir}.`);
}

const missing = builtAssets.filter((asset) => !manifestUrls.has(asset));

if (missing.length > 0) {
	console.error(
		`check-precache: FAIL — ${missing.length} built asset(s) missing from the sw.js precache manifest:`,
	);
	for (const name of missing) {
		console.error(`  - ${name}`);
	}
	console.error(
		`check-precache: manifest listed ${manifestUrls.size} entr(y|ies); ${builtAssets.length} .js/.css assets were built.`,
	);
	process.exit(1);
}

console.log(
	`check-precache: PASS — sw.js present, all ${builtAssets.length} built .js/.css assets covered by a ${manifestUrls.size}-entry precache manifest.`,
);
