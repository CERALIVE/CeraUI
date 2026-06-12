import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Dark-mode off-state switch border legibility.
 *
 * `switch.svelte` (CLI-managed, must not be edited) hardcodes
 * `border border-transparent` as a utility class (specificity 0,1,0).
 * `app.css` overrides it with a higher-specificity attribute selector so
 * the inactive track stays visible against the near-black `--card`.
 *
 * The frontend vitest environment is `node` (no jsdom), and jsdom's
 * `getComputedStyle` cannot resolve `oklch()`, `color-mix()`, or `var()`
 * anyway. So instead of mounting into a fake DOM that returns the raw
 * unresolved string, this test resolves the cascade by hand from the real
 * stylesheet: it reads the actual border-color the `.dark` unchecked rule
 * produces and asserts it is (a) not transparent and (b) >=3:1 against the
 * dark `--card`. That verifies the same invariant a computed-style probe
 * would, deterministically.
 */

const cssPath = fileURLToPath(new URL("../app.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");

// The brand token values (light/dark) now live in the shared
// @ceralive/design-tokens package, imported by app.css. Resolve that
// stylesheet the same way the bundler does so this test reads the real
// cascade rather than app.css in isolation.
const tokensCss = readFileSync(
	createRequire(import.meta.url).resolve("@ceralive/design-tokens/tokens.css"),
	"utf8",
);

const TRANSPARENT_TOKENS = new Set([
	"transparent",
	"rgba(0,0,0,0)",
	"rgba(0, 0, 0, 0)",
]);

type Oklch = { L: number; C: number; h: number };
type Oklab = { L: number; a: number; b: number };

/** Slice the body of the first `<selector> { ... }` block (no nested braces). */
function ruleBody(source: string, selector: string): string {
	const at = source.indexOf(selector);
	if (at === -1) throw new Error(`selector not found: ${selector}`);
	const open = source.indexOf("{", at);
	const close = source.indexOf("}", open);
	return source.slice(open + 1, close);
}

/** Slice the body of a brace-balanced block opened by `header` (e.g. `.dark {`). */
function balancedBlock(source: string, header: string): string {
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

function declValue(body: string, prop: string): string {
	const m = body.match(new RegExp(`${prop}\\s*:\\s*([^;]+);`));
	if (!m) throw new Error(`declaration not found: ${prop}`);
	return m[1].trim();
}

function parseOklch(value: string): Oklch {
	const m = value.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/);
	if (!m) throw new Error(`not an oklch() value: ${value}`);
	return { L: +m[1], C: +m[2], h: +m[3] };
}

function oklchToOklab({ L, C, h }: Oklch): Oklab {
	const rad = (h * Math.PI) / 180;
	return { L, a: C * Math.cos(rad), b: C * Math.sin(rad) };
}

/** Resolve `color-mix(in oklab, var(--A) P%, var(--B))` against a token map. */
function resolveColorMix(value: string, tokens: Record<string, Oklch>): Oklab {
	const m = value.match(
		/color-mix\(\s*in oklab\s*,\s*var\((--[\w-]+)\)\s+([\d.]+)%\s*,\s*var\((--[\w-]+)\)\s*\)/,
	);
	if (!m) throw new Error(`unsupported border-color form: ${value}`);
	const [, nameA, pctRaw, nameB] = m;
	const wA = +pctRaw / 100;
	const wB = 1 - wA;
	const A = oklchToOklab(tokens[nameA]);
	const B = oklchToOklab(tokens[nameB]);
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
	const lin = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707_614_701 * s,
	].map((c) => Math.max(0, Math.min(1, c)));
	return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrastRatio(x: Oklab, y: Oklab): number {
	const lx = relativeLuminance(x);
	const ly = relativeLuminance(y);
	const [hi, lo] = lx >= ly ? [lx, ly] : [ly, lx];
	return (hi + 0.05) / (lo + 0.05);
}

const darkBlock = balancedBlock(tokensCss, '[data-theme="dark"]');
const darkTokens: Record<string, Oklch> = {};
for (const token of [
	"--switch-off",
	"--muted-foreground",
	"--border",
	"--card",
]) {
	darkTokens[token] = parseOklch(declValue(darkBlock, token));
}

describe("dark-mode off-state switch border", () => {
	const borderColor = declValue(
		ruleBody(css, ".dark [data-slot='switch'][data-state='unchecked']"),
		"border-color",
	);

	it("sets a non-transparent border-color on the unchecked dark switch", () => {
		expect(borderColor.toLowerCase()).not.toBe("");
		expect(TRANSPARENT_TOKENS.has(borderColor.toLowerCase())).toBe(false);
	});

	it("resolves to a color with >=3:1 contrast against the dark --card", () => {
		const border = resolveColorMix(borderColor, darkTokens);
		const card = oklchToOklab(darkTokens["--card"]);
		expect(contrastRatio(border, card)).toBeGreaterThanOrEqual(3);
	});

	it("wins over the primitive's `border-transparent` via higher specificity", () => {
		const switchSource = readFileSync(
			fileURLToPath(
				new URL("../lib/components/ui/switch/switch.svelte", import.meta.url),
			),
			"utf8",
		);
		// The primitive still ships the transparent utility (0,1,0); our
		// .dark attribute-selector rule (0,3,0) is what makes the border show.
		expect(switchSource).toContain("border-transparent");
		expect(css).toContain(".dark [data-slot='switch'][data-state='unchecked']");
	});
});
