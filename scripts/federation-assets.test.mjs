import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

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
		expect(assets.filter((asset) => asset.kind === 'chunk')).toHaveLength(3);
		expect(assets.filter((asset) => asset.kind === 'style')).toHaveLength(1);
		for (const asset of assets) {
			for (const dependency of asset.imports) {
				expect(assets.some((candidate) => candidate.filename === dependency)).toBe(true);
			}
		}
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
