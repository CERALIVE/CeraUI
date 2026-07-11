import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const ENTRY_FILES = new Set(['encoder.js', 'audio.js', 'server.js']);

export type FederationAssetKind = 'entry' | 'chunk' | 'style';

export interface FederationAsset {
	readonly filename: string;
	readonly kind: FederationAssetKind;
	readonly imports: readonly string[];
}

export interface SignedFederationAsset extends FederationAsset {
	readonly integrity: string;
}

export function parsePackageVersion(text: string): string {
	const raw: unknown = JSON.parse(text);
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new Error('invalid package.json');
	}
	const version = Reflect.get(raw, 'version');
	if (typeof version !== 'string' || version.length === 0) {
		throw new Error('root package.json has no "version" field');
	}
	return version;
}

export function parseSignedManifestAssets(text: string): readonly SignedFederationAsset[] {
	const raw: unknown = JSON.parse(text);
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new Error('invalid federation manifest');
	}
	const files = Reflect.get(raw, 'files');
	if (!Array.isArray(files)) throw new Error('invalid federation manifest files');
	return files.map((file) => {
		if (typeof file !== 'object' || file === null || Array.isArray(file)) {
			throw new Error('invalid federation manifest asset');
		}
		const filename = Reflect.get(file, 'filename');
		const integrity = Reflect.get(file, 'integrity');
		const kind = Reflect.get(file, 'kind');
		const imports = Reflect.get(file, 'imports');
		if (
			typeof filename !== 'string' ||
			typeof integrity !== 'string' ||
			(kind !== 'entry' && kind !== 'chunk' && kind !== 'style') ||
			!isStringArray(imports)
		) {
			throw new Error('invalid federation manifest asset');
		}
		return { filename, integrity, kind, imports };
	});
}

export function federationAssetKind(filename: string): FederationAssetKind | null {
	if (ENTRY_FILES.has(filename)) return 'entry';
	if (extname(filename) === '.js') return 'chunk';
	if (extname(filename) === '.css') return 'style';
	return null;
}

export function discoverFederationAssets(dir: string): FederationAsset[] {
	const graph = readBuildGraph(dir);
	return readdirSync(dir)
		.map((filename) => {
			const kind = federationAssetKind(filename);
			return kind === null ? null : { filename, kind, imports: importsFor(filename, graph) };
		})
		.filter((asset): asset is FederationAsset => asset !== null)
		.sort((left, right) => left.filename.localeCompare(right.filename));
}

type BuildGraphEntry = {
	readonly file: string;
	readonly imports: readonly string[];
};

function readBuildGraph(dir: string): Readonly<Record<string, BuildGraphEntry>> {
	const raw: unknown = JSON.parse(readFileSync(join(dir, 'federation-build.json'), 'utf8'));
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new Error('invalid federation build graph');
	}
	const graph: Record<string, BuildGraphEntry> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			throw new Error(`invalid federation build graph entry ${key}`);
		}
		const file = Reflect.get(value, 'file');
		const imports = Reflect.get(value, 'imports');
		if (typeof file !== 'string' || (imports !== undefined && !isStringArray(imports))) {
			throw new Error(`invalid federation build graph entry ${key}`);
		}
		graph[key] = { file, imports: imports ?? [] };
	}
	return graph;
}

function importsFor(
	filename: string,
	graph: Readonly<Record<string, BuildGraphEntry>>,
): readonly string[] {
	const entry = Object.values(graph).find((candidate) => candidate.file === filename);
	if (entry === undefined || extname(filename) === '.css') return [];
	return entry.imports.map((key) => {
		const imported = graph[key];
		if (imported === undefined) throw new Error(`missing federation import ${key}`);
		return imported.file;
	});
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function assertFederationAssetSet(assets: readonly FederationAsset[]): void {
	const byFilename = new Map(assets.map((asset) => [asset.filename, asset]));
	if (byFilename.size !== assets.length) throw new Error('duplicate federation asset');
	for (const entry of ENTRY_FILES) {
		if (!assets.some((asset) => asset.filename === entry && asset.kind === 'entry')) {
			throw new Error(`missing federation entry ${entry}`);
		}
	}
	if (!assets.some((asset) => asset.kind === 'style')) {
		throw new Error('missing federation stylesheet');
	}
	for (const asset of assets) {
		for (const dependency of asset.imports) {
			const target = byFilename.get(dependency);
			if (target === undefined) throw new Error(`missing federation dependency ${dependency}`);
			if (target.kind === 'style')
				throw new Error(`stylesheet imported as executable ${dependency}`);
		}
	}
	const reachable = new Set<string>();
	const visit = (filename: string): void => {
		if (reachable.has(filename)) return;
		reachable.add(filename);
		for (const dependency of byFilename.get(filename)?.imports ?? []) visit(dependency);
	};
	for (const asset of assets) if (asset.kind === 'entry') visit(asset.filename);
	for (const asset of assets) {
		if (asset.kind === 'chunk' && !reachable.has(asset.filename)) {
			throw new Error(`unreachable federation chunk ${asset.filename}`);
		}
	}
}
