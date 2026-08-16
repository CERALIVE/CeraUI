import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import {
	assertFederationAssetSet,
	discoverFederationAssets,
	federationAssetKind,
	normalizeFederationAssetText,
	parsePackageVersion,
} from './federation-assets.ts';

// Derived, never literal. A pinned version silently tests whatever stale output
// a dirty checkout happens to hold, and fails outright on a clean one the moment
// package.json moves on — which it had (this read `2026.7.0` while the build
// emitted `2026.7.2`). This is the SAME resolution sign-federation.ts uses, so
// the two cannot disagree about which directory is being signed.
const ROOT = join(import.meta.dir, '..');
const VERSION = parsePackageVersion(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const OUTPUT = join(ROOT, 'dist', 'federation', VERSION);

describe('federation asset contract', () => {
	it('resolves the output directory from the root package version', () => {
		expect(VERSION).toMatch(/^\d{4}\.\d+\.\d+$/);
		expect(OUTPUT.endsWith(join('dist', 'federation', VERSION))).toBe(true);
		expect(
			existsSync(OUTPUT),
			`no federation output at ${OUTPUT} — run \`bun run build:federation\` first`,
		).toBe(true);
	});

	it('classifies entries, chunks, and styles', () => {
		expect(federationAssetKind('encoder.js')).toBe('entry');
		expect(federationAssetKind('select-hash.js')).toBe('chunk');
		expect(federationAssetKind('frontend.css')).toBe('style');
		expect(federationAssetKind('manifest.json')).toBeNull();
	});

	it('covers every built executable and stylesheet with dependency edges', () => {
		const assets = discoverFederationAssets(OUTPUT);
		expect(() => assertFederationAssetSet(assets)).not.toThrow();
		expect(assets.filter((asset) => asset.kind === 'entry')).toHaveLength(3);
		const emitted = readdirSync(OUTPUT)
			.filter((filename) => ['.js', '.css'].includes(extname(filename)))
			.sort((left, right) => left.localeCompare(right));
		expect(assets.map((asset) => asset.filename)).toEqual(emitted);
		for (const asset of assets) {
			for (const dependency of asset.imports) {
				expect(assets.some((candidate) => candidate.filename === dependency)).toBe(true);
			}
		}
	});

	it('rejects executable chunks outside the entry graph', () => {
		expect(() =>
			assertFederationAssetSet([
				{ filename: 'encoder.js', kind: 'entry', imports: [] },
				{ filename: 'audio.js', kind: 'entry', imports: [] },
				{ filename: 'server.js', kind: 'entry', imports: [] },
				{ filename: 'orphan.js', kind: 'chunk', imports: [] },
				{ filename: 'frontend.css', kind: 'style', imports: [] },
			]),
		).toThrow('unreachable federation chunk orphan.js');
	});

	it('rejects an asset set without emitted CSS', () => {
		expect(() =>
			assertFederationAssetSet([
				{ filename: 'encoder.js', kind: 'entry', imports: [] },
				{ filename: 'audio.js', kind: 'entry', imports: [] },
				{ filename: 'server.js', kind: 'entry', imports: [] },
			]),
		).toThrow('missing federation stylesheet');
	});

	it('removes generated trailing whitespace before signing', () => {
		expect(normalizeFederationAssetText('const x = 1;  \n\t\n')).toBe('const x = 1;\n\n');
	});
});
