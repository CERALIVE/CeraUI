import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

export type NativePattern = {
	readonly file: string;
	readonly owner: string;
	readonly pattern: string;
	readonly flags: string;
	readonly matcher: RegExp;
};
export type DynamicPattern = {
	readonly file: string;
	readonly parameter: string;
	readonly instantiate: (value: string) => RegExp;
};

async function nativeSources(): Promise<ReadonlyMap<string, ts.SourceFile>> {
	const pending = ['guest-preflight.ts', 'first-ap.ts', 'hybrid-upgrade.ts', 'bootstrap.ts'];
	const result = new Map<string, ts.SourceFile>();
	while (pending.length) {
		const file = pending.shift();
		if (!file || result.has(file)) continue;
		const source = await readFile(resolve(import.meta.dir, file), 'utf8');
		const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
		result.set(file, ast);
		const follow = (value: string) => {
			if (value.startsWith('./') && value.endsWith('.ts')) pending.push(value.slice(2));
		};
		const visit = (node: ts.Node): void => {
			if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
				follow(node.moduleSpecifier.text);
			if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				const argument = node.arguments[0];
				if (argument && ts.isStringLiteral(argument)) follow(argument.text);
			}
			ts.forEachChild(node, visit);
		};
		visit(ast);
	}
	return result;
}

/** Replay the actual frozen literal matchers; receipt contents are never evaluated. */
export async function nativePatterns(): Promise<readonly NativePattern[]> {
	const patterns: NativePattern[] = [];
	for (const [file, ast] of await nativeSources()) {
		const visit = (node: ts.Node, owner: string): void => {
			const name = ts.isFunctionDeclaration(node) && node.name ? node.name.text : owner;
			if (ts.isRegularExpressionLiteral(node)) {
				const slash = node.text.lastIndexOf('/');
				const pattern = node.text.slice(1, slash);
				const flags = node.text.slice(slash + 1);
				patterns.push({ file, owner: name, pattern, flags, matcher: new RegExp(pattern, flags) });
			}
			ts.forEachChild(node, (child) => visit(child, name));
		};
		visit(ast, 'entrypoint');
	}
	return patterns;
}

/** The two dynamic constructors use one reviewed data substitution, not code evaluation. */
export async function dynamicPatterns(): Promise<readonly DynamicPattern[]> {
	const result: DynamicPattern[] = [];
	for (const [file, ast] of await nativeSources()) {
		const visit = (node: ts.Node): void => {
			if (
				ts.isNewExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === 'RegExp'
			) {
				const argument = node.arguments?.[0];
				if (!argument || !ts.isTemplateExpression(argument) || argument.templateSpans.length !== 1)
					throw new Error(`Unreviewed dynamic native matcher in ${file}`);
				const span = argument.templateSpans[0];
				if (!span) throw new Error('Missing template span');
				const head = argument.head.text;
				const tail = span.literal.text;
				result.push({
					file,
					parameter: span.expression.getText(ast),
					instantiate: (value) => new RegExp(`${head}${value}${tail}`),
				});
			}
			ts.forEachChild(node, visit);
		};
		visit(ast);
	}
	return result;
}
