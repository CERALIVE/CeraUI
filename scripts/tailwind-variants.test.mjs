import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSync } from 'bun';
import ts from 'typescript';

const frontend = join(import.meta.dir, '../apps/frontend');
const { tv: reference } = await import(resolveSync('tailwind-variants', frontend));
const { clsx } = await import(resolveSync('clsx', frontend));
const { twMerge } = await import(resolveSync('tailwind-merge', frontend));
const { tv } = await import('../apps/frontend/src/lib/tailwind-variants.ts');
const cn = (...inputs) => twMerge(clsx(inputs));
const recipes = [
	['badge/badge.svelte', 'badgeVariants'],
	['button/button.svelte', 'buttonVariants'],
	['input-group/input-group-addon.svelte', 'inputGroupAddonVariants'],
	['input-group/input-group-button.svelte', 'inputGroupButtonVariants'],
	['tabs/tabs-list.svelte', 'tabsListVariants'],
	['toggle/toggle.svelte', 'toggleVariants'],
];

for (const [file, name] of recipes) {
	test(`${name} preserves raw and cn class bytes for every variant and caller override`, () => {
		const source = readFileSync(join(frontend, 'src/lib/components/ui', file), 'utf8');
		const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
		let recipe;
		function visit(node) {
			if (
				ts.isVariableDeclaration(node) &&
				node.name.getText(ast) === name &&
				node.initializer &&
				ts.isCallExpression(node.initializer)
			) {
				const argument = node.initializer.arguments[0];
				recipe = new Function(`return (${argument.getText(ast)})`)();
			}
			ts.forEachChild(node, visit);
		}
		visit(ast);
		expect(recipe, `missing ${name}`).toBeDefined();
		const old = reference(recipe);
		const current = tv(recipe);
		let combinations = [{}];
		for (const [key, values] of Object.entries(recipe.variants)) {
			combinations = combinations.flatMap((props) =>
				[undefined, ...Object.keys(values)].map((value) => ({ ...props, [key]: value })),
			);
		}
		for (const props of [undefined, {}, ...combinations]) {
			expect(current(props)).toBe(old(props));
			expect(cn(current(props))).toBe(cn(old(props)));
			expect(current(props)).toBe(old(props));
			const overrides = { ...props, class: 'px-9 h-20 transition-none' };
			expect(current(overrides)).toBe(old(overrides));
			expect(cn(current(props), overrides.class)).toBe(cn(old(props), overrides.class));
		}
	});
}

test('the injected merger resolves conflicts before cn is called', () => {
	const recipe = tv({
		base: 'px-2 py-1 transition-all',
		variants: { size: { large: 'px-8 transition-colors' } },
		defaultVariants: { size: 'large' },
	});
	expect(recipe()).toBe('py-1 px-8 transition-colors');
	expect(recipe({ class: 'px-4 transition-none' })).toBe('py-1 px-4 transition-none');
});
