import { describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

import {
	assertFederationAssetSet,
	discoverFederationAssets,
	federationAssetKind,
} from './federation-assets.ts';

const OUTPUT = join(import.meta.dir, '../dist/federation/2026.7.0');

describe('federation asset contract', () => {
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
});
