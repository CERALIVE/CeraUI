import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(import.meta.dir, '../..');

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Tables and constants count too: notification keys need not occur in a call. */
export function notificationKeys(source: string): readonly string[] {
	const keys = new Set<string>();
	const tree = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest);
	function visit(node: ts.Node): void {
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
			ts.isStringLiteralLike(node.left) &&
			node.left.text.startsWith('notifications.')
		) {
			throw new Error('Notification keys must be complete literals, not concatenations');
		}
		if (ts.isStringLiteralLike(node)) {
			if (
				/^notifications\.[A-Za-z][A-Za-z0-9]*$/.test(node.text) ||
				node.text === 'network.os.deviceBusy'
			) {
				keys.add(node.text);
			}
		}
		if (ts.isTemplateExpression(node) && node.head.text.startsWith('notifications.')) {
			throw new Error('Notification keys must be complete literals, not templates');
		}
		ts.forEachChild(node, visit);
	}
	visit(tree);
	return [...keys].sort();
}

async function sourceKeys(directory: string): Promise<readonly string[]> {
	const keys = new Set<string>();
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (['tests', '__tests__', 'node_modules', 'mocks'].includes(entry.name)) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			for (const key of await sourceKeys(path)) keys.add(key);
		} else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
			for (const key of notificationKeys(await readFile(path, 'utf8'))) keys.add(key);
		}
	}
	return [...keys].sort();
}

export function renderCatalogMessage(pattern: string): {
	readonly inputs: Record<string, string>;
	readonly expected: string;
} {
	const inputs: Record<string, string> = {};
	const expected = pattern.replace(/\{(\w+)\}/g, (_match, name: string) => {
		const value = `__${name}__`;
		inputs[name] = value;
		return value;
	});
	return { inputs, expected };
}

/** Import only emitted JS, never source registries, sourcemaps or test setup. */
export async function checkNotificationBundle(assets: string): Promise<number> {
	const keys = await sourceKeys(join(ROOT, 'apps/backend/src'));
	if (keys.length === 0) throw new Error('Backend notification scan found no keys');
	const settings: unknown = JSON.parse(
		await readFile(join(ROOT, 'packages/i18n/project.inlang/settings.json'), 'utf8'),
	);
	if (!isRecord(settings) || !Array.isArray(settings.locales))
		throw new Error('Missing shipped locale list');
	const files = await readdir(assets);
	const registries = new Map<string, Readonly<Record<string, unknown>>>();
	for (const namespace of new Set(keys.map((key) => key.slice(0, key.indexOf('.'))))) {
		const chunks = files.filter((file) => file.startsWith(`${namespace}-`) && file.endsWith('.js'));
		if (chunks.length !== 1)
			throw new Error(`Expected one built ${namespace} namespace, got ${chunks.length}`);
		for (const chunk of chunks) {
			const module: unknown = await import(pathToFileURL(join(assets, chunk)).href);
			if (!isRecord(module) || !isRecord(module.messages))
				throw new Error(`Missing message registry in ${chunk}`);
			registries.set(namespace, module.messages);
		}
	}
	let failures = 0;
	for (const locale of settings.locales) {
		if (typeof locale !== 'string') throw new Error('Invalid locale code');
		const catalog: unknown = JSON.parse(
			await readFile(join(ROOT, 'packages/i18n/messages', `${locale}.json`), 'utf8'),
		);
		if (!isRecord(catalog)) throw new Error(`Invalid ${locale} catalog`);
		let missing = 0;
		for (const key of keys) {
			const pattern = catalog[key];
			if (typeof pattern !== 'string' || pattern.length === 0)
				throw new Error(`Expected a nonempty notification pattern: ${locale} ${key}`);
			const { inputs, expected } = renderCatalogMessage(pattern);
			const translate = registries.get(key.split('.')[0] ?? '')?.[key];
			const actual: unknown =
				typeof translate === 'function' ? translate(inputs, { locale }) : undefined;
			if (actual !== expected) {
				process.stderr.write(
					`${locale}\t${key}\t${actual === undefined ? 'MISSING' : 'WRONG TEXT'}\n`,
				);
				missing += 1;
			}
		}
		failures += missing;
		process.stdout.write(
			`${locale}: ${keys.length - missing}/${keys.length} backend notification keys render correctly\n`,
		);
	}
	process.stdout.write(
		`Production notification guard: ${keys.length} keys, ${settings.locales.length} locales, ${failures} failures\n`,
	);
	return failures;
}

if (import.meta.main) {
	const assets = resolve(process.argv[2] ?? join(ROOT, 'dist/public/assets'));
	process.exitCode = (await checkNotificationBundle(assets)) === 0 ? 0 : 1;
}
