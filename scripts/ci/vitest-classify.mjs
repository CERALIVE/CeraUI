import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';
import ts from 'typescript';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const defaultFrontendRoot = path.join(repoRoot, 'apps/frontend');
const componentGlobals = new Set([
	'$persist',
	'document',
	'localStorage',
	'sessionStorage',
	'window',
]);
const explicitNodeAssertionPattern =
	/expect\s*\(\s*typeof\s+window\s*\)\s*\.toBe\s*\(\s*["']undefined["']\s*\)/;

function analyzeSource(modulePath, source) {
	const sourceFile = ts.createSourceFile(
		modulePath,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const specifiers = [];
	let usesComponentGlobal = false;

	function visit(node) {
		if (ts.isIdentifier(node) && componentGlobals.has(node.text)) {
			usesComponentGlobal = true;
		}
		if (
			ts.isImportDeclaration(node) &&
			!node.importClause?.isTypeOnly &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			specifiers.push(node.moduleSpecifier.text);
		} else if (
			ts.isExportDeclaration(node) &&
			!node.isTypeOnly &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			specifiers.push(node.moduleSpecifier.text);
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length === 1 &&
			ts.isStringLiteral(node.arguments[0])
		) {
			specifiers.push(node.arguments[0].text);
		}
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return { specifiers, usesComponentGlobal };
}

function resolveExistingModule(basePath) {
	const extension = path.extname(basePath);
	const withoutJsExtension = extension === '.js' ? basePath.slice(0, -3) : null;
	const candidates = [
		basePath,
		`${basePath}.ts`,
		`${basePath}.tsx`,
		`${basePath}.svelte.ts`,
		`${basePath}.svelte`,
		`${basePath}.js`,
		`${basePath}.mjs`,
		path.join(basePath, 'index.ts'),
		path.join(basePath, 'index.svelte.ts'),
		path.join(basePath, 'index.svelte'),
		...(withoutJsExtension === null
			? []
			: [`${withoutJsExtension}.ts`, `${withoutJsExtension}.svelte.ts`]),
	];
	return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function resolveLocalImport(specifier, importer, frontendRoot) {
	let basePath;
	if (specifier.startsWith('.')) {
		basePath = path.resolve(path.dirname(importer), specifier);
	} else if (specifier === '$lib' || specifier.startsWith('$lib/')) {
		basePath = path.join(frontendRoot, 'src/lib', specifier.slice(5));
	} else if (specifier === '$main' || specifier.startsWith('$main/')) {
		basePath = path.join(frontendRoot, 'src/main', specifier.slice(6));
	} else if (specifier === '@ceraui/i18n') {
		basePath = path.join(repoRoot, 'packages/i18n/src/index.ts');
	} else if (specifier === '@ceraui/i18n/svelte') {
		basePath = path.join(repoRoot, 'packages/i18n/src/svelte.svelte.ts');
	} else if (specifier === '@ceraui/i18n/formatters') {
		basePath = path.join(repoRoot, 'packages/i18n/src/formatters.ts');
	} else if (specifier === '@ceraui/i18n/eager') {
		basePath = path.join(repoRoot, 'packages/i18n/generated/eager.js');
	} else {
		return null;
	}

	const resolved = resolveExistingModule(basePath);
	if (resolved === undefined) {
		throw new Error(`Cannot resolve local import "${specifier}" from ${importer}`);
	}
	return resolved;
}

function isComponentModule(modulePath, source, analysis) {
	return (
		modulePath.endsWith('.svelte') ||
		modulePath.endsWith('.svelte.ts') ||
		source.includes('// @vitest-environment jsdom') ||
		analysis.usesComponentGlobal
	);
}

function isComponentPackage(specifier) {
	return (
		specifier === 'svelte' ||
		specifier.startsWith('svelte/') ||
		specifier.startsWith('@testing-library/svelte') ||
		specifier.startsWith('svelte-persistent-runes') ||
		specifier === '@ceraui/i18n/svelte'
	);
}

function requiresNodeEnvironment(source) {
	return (
		source.includes('// @vitest-environment node') || explicitNodeAssertionPattern.test(source)
	);
}

function reachesComponent(testPath, frontendRoot, analysisCache) {
	const pending = [testPath];
	const visited = new Set();

	while (pending.length > 0) {
		const modulePath = pending.pop();
		if (modulePath === undefined || visited.has(modulePath)) continue;
		visited.add(modulePath);

		const source = readFileSync(modulePath, 'utf8');
		const analysis = analysisCache.get(modulePath) ?? analyzeSource(modulePath, source);
		analysisCache.set(modulePath, analysis);
		if (isComponentModule(modulePath, source, analysis)) return true;

		for (const specifier of analysis.specifiers) {
			if (isComponentPackage(specifier)) return true;
			const dependency = resolveLocalImport(specifier, modulePath, frontendRoot);
			if (dependency !== null) pending.push(dependency);
		}
	}

	return false;
}

export function classifyVitestFiles(frontendRoot = defaultFrontendRoot) {
	const tests = globSync('src/**/*.test.ts', {
		cwd: frontendRoot,
		nodir: true,
	}).sort();
	const pure = [];
	const components = [];
	const analysisCache = new Map();

	for (const testFile of tests) {
		const testPath = path.join(frontendRoot, testFile);
		const source = readFileSync(testPath, 'utf8');

		// A test that explicitly proves the no-window fallback requires Node even
		// when the implementation reaches a rune module. This topology rule keeps
		// the TTL seam honest without maintaining a filename exception list.
		if (requiresNodeEnvironment(source)) {
			pure.push(testFile);
		} else if (reachesComponent(testPath, frontendRoot, analysisCache)) {
			components.push(testFile);
		} else {
			pure.push(testFile);
		}
	}

	return { pure, components };
}
