/**
 * Resolves app.css colour rules against the shared design tokens and measures
 * WCAG contrast by hand. The frontend vitest environment cannot compute
 * `oklch()`, `color-mix()` or `var()`, so tests that guard a rendered colour
 * read the real stylesheets instead of a DOM that returns the raw string.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export type Oklch = { L: number; C: number; h: number };
export type Oklab = { L: number; a: number; b: number };

export const appCss = readFileSync(
	fileURLToPath(new URL("../../app.css", import.meta.url)),
	"utf8",
);

// The brand token values (light/dark) live in the shared
// @ceralive/design-tokens package, imported by app.css. Resolve that
// stylesheet the same way the bundler does so tests read the real cascade
// rather than app.css in isolation.
export const tokensCss = readFileSync(
	createRequire(import.meta.url).resolve("@ceralive/design-tokens/tokens.css"),
	"utf8",
);

/** Slice the body of the first `<selector> { ... }` block (no nested braces). */
export function ruleBody(source: string, selector: string): string {
	const at = source.indexOf(selector);
	if (at === -1) throw new Error(`selector not found: ${selector}`);
	const open = source.indexOf("{", at);
	const close = source.indexOf("}", open);
	return source.slice(open + 1, close);
}

/** Slice the body of a brace-balanced block opened by `header` (e.g. `.dark {`). */
export function balancedBlock(source: string, header: string): string {
	const at = source.indexOf(header);
	if (at === -1) throw new Error(`block not found: ${header}`);
	let depth = 0;
	const open = source.indexOf("{", at);
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}" && --depth === 0)
			return source.slice(open + 1, i);
	}
	throw new Error(`unbalanced block: ${header}`);
}

/** The value of `prop` in a rule body; `color` never matches `background-color`. */
export function declValue(body: string, prop: string): string {
	const [, value] =
		body.match(new RegExp(`(?:^|[\\s;])${prop}\\s*:\\s*([^;]+);`)) ?? [];
	if (value === undefined) throw new Error(`declaration not found: ${prop}`);
	return value.trim();
}

export function parseOklch(value: string): Oklch {
	const [, L, C, h] =
		value.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/) ?? [];
	if (L === undefined || C === undefined || h === undefined)
		throw new Error(`not an oklch() value: ${value}`);
	return { L: +L, C: +C, h: +h };
}

export function tokenMap(
	block: string,
	names: readonly string[],
): Record<string, Oklch> {
	return Object.fromEntries(
		names.map((name) => [name, parseOklch(declValue(block, name))]),
	);
}

export function oklchToOklab({ L, C, h }: Oklch): Oklab {
	const rad = (h * Math.PI) / 180;
	return { L, a: C * Math.cos(rad), b: C * Math.sin(rad) };
}

/** Resolve `var(--A)` or `color-mix(in oklab, var(--A) P%, var(--B))` against a token map. */
export function resolveColor(
	value: string,
	tokens: Readonly<Record<string, Oklch>>,
): Oklab {
	const token = (name: string | undefined): Oklab => {
		const color = name === undefined ? undefined : tokens[name];
		if (color === undefined) throw new Error(`unknown token in: ${value}`);
		return oklchToOklab(color);
	};
	const [, single] = value.match(/^var\((--[\w-]+)\)$/) ?? [];
	if (single !== undefined) return token(single);
	const [, nameA, pctRaw, nameB] =
		value.match(
			/color-mix\(\s*in oklab\s*,\s*var\((--[\w-]+)\)\s+([\d.]+)%\s*,\s*var\((--[\w-]+)\)\s*\)/,
		) ?? [];
	if (pctRaw === undefined)
		throw new Error(`unsupported colour form: ${value}`);
	const wA = +pctRaw / 100;
	const wB = 1 - wA;
	const A = token(nameA);
	const B = token(nameB);
	return {
		L: A.L * wA + B.L * wB,
		a: A.a * wA + B.a * wB,
		b: A.b * wA + B.b * wB,
	};
}

/** oklab -> linear sRGB -> WCAG relative luminance. */
function relativeLuminance({ L, a, b }: Oklab): number {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291_485_548 * b) ** 3;
	const clamp = (c: number) => Math.max(0, Math.min(1, c));
	const red = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
	const green = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
	const blue = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707_614_701 * s);
	return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(x: Oklab, y: Oklab): number {
	const lx = relativeLuminance(x);
	const ly = relativeLuminance(y);
	const [hi, lo] = lx >= ly ? [lx, ly] : [ly, lx];
	return (hi + 0.05) / (lo + 0.05);
}
