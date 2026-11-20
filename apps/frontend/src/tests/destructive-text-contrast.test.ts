import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	appCss,
	balancedBlock,
	contrastRatio,
	declValue,
	type Oklab,
	resolveColor,
	ruleBody,
	tokenMap,
	tokensCss,
} from "./helpers/css-contrast";

/**
 * Red text and red status text keep WCAG AA 4.5:1 on every surface they sit
 * on, in the light, dark and e-ink palettes, and stay red. `text-destructive`
 * sets every error line and the label of the shadcn destructive badge
 * (CLI-managed, never edited) over its own red tint; `text-status-error` sets
 * red status text, the status Badge's `error` tone over its
 * `bg-status-error/10` tint included. app.css owns both inks; where it sets
 * none, the utility's own token paints. Tints are composited the way the
 * browser paints them, not mixed in oklab. Resolved from the real stylesheets,
 * as in destructive-button-contrast.test.ts.
 */

const SURFACES = ["--background", "--card", "--popover"] as const;
const NAMES = [...SURFACES, "--foreground", "--destructive", "--status-error"];
const PALETTES = [
	["light", "", tokenMap(balancedBlock(tokensCss, ".light {"), NAMES)],
	[
		"dark",
		"dark:",
		tokenMap(balancedBlock(tokensCss, '[data-theme="dark"] {'), NAMES),
	],
	[
		"e-ink",
		"",
		tokenMap(balancedBlock(appCss, "html[data-theme='eink'] {"), NAMES),
	],
] as const;

const RED_TEXT = {
	selector: ".text-destructive",
	utility: "var(--destructive)",
};
const RED_STATUS = {
	selector: ".text-status-error",
	utility: "var(--status-error)",
};

function recipe(path: string, variant: string): string[] {
	const source = readFileSync(
		fileURLToPath(new URL(path, import.meta.url)),
		"utf8",
	);
	const [, classes = ""] =
		source.match(new RegExp(`${variant}:\\s*'([^']+)'`)) ?? [];
	return classes.split(/\s+/);
}

const destructiveBadge = recipe(
	"../lib/components/ui/badge/badge.svelte",
	"destructive",
);
const errorBadge = recipe("../lib/components/custom/Badge.svelte", "error");

function tintAlpha(classes: readonly string[], prefix: string): number {
	const percent = classes
		.find((name) => name.startsWith(prefix))
		?.slice(prefix.length);
	if (percent === undefined) throw new Error(`no ${prefix}N class`);
	return +percent / 100;
}

/** oklab -> linear sRGB, clamped to the sRGB gamut. */
function toLinearSrgb({ L, a, b }: Oklab): [number, number, number] {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291_485_548 * b) ** 3;
	const clamp = (c: number) => Math.max(0, Math.min(1, c));
	return [
		clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
		clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
		clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707_614_701 * s),
	];
}

/** linear sRGB -> oklab. */
function fromLinearSrgb([red, green, blue]: [number, number, number]): Oklab {
	const l = Math.cbrt(
		0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue,
	);
	const m = Math.cbrt(
		0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue,
	);
	const s = Math.cbrt(
		0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue,
	);
	return {
		L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	};
}

/**
 * `top` at `alpha` painted over the opaque `base`, as the browser composites a
 * translucent fill such as `bg-destructive/20`: blended in gamma-encoded sRGB,
 * which leaves a lighter wash on a light surface than a mix in oklab does.
 */
function paintOver(top: Oklab, alpha: number, base: Oklab): Oklab {
	const encode = (c: number) =>
		c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
	const decode = (c: number) =>
		c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	const over = toLinearSrgb(top);
	const under = toLinearSrgb(base);
	const blend = (i: 0 | 1 | 2) =>
		decode(encode(over[i]) * alpha + encode(under[i]) * (1 - alpha));
	return fromLinearSrgb([blend(0), blend(1), blend(2)]);
}

/** The ink app.css gives `selector`, or the utility's own token if it sets none. */
function ink({ selector, utility }: { selector: string; utility: string }) {
	return appCss.includes(`${selector} {`)
		? declValue(ruleBody(appCss, `${selector} {`), "color")
		: utility;
}

/** Every ratio under 4.5:1, rounded, so a failure names each surface. */
function belowAA(ratios: Record<string, number>): Record<string, number> {
	return Object.fromEntries(
		Object.entries(ratios)
			.filter(([, ratio]) => ratio < 4.5)
			.map(([surface, ratio]) => [surface, +ratio.toFixed(2)]),
	);
}

describe("red text and red badge colours", () => {
	it("keys on the classes both badges ship", () => {
		expect(destructiveBadge).toContain("text-destructive");
		expect(errorBadge).toEqual(
			expect.arrayContaining(["bg-status-error/10", "text-status-error"]),
		);
	});

	it.each(PALETTES)(
		"keeps %s red text at 4.5:1 on every surface and on the destructive badge",
		(_, variant, tokens) => {
			const text = resolveColor(ink(RED_TEXT), tokens);
			const red = resolveColor("var(--destructive)", tokens);
			const alpha = tintAlpha(destructiveBadge, `${variant}bg-destructive/`);
			const ratios: Record<string, number> = {};
			for (const surface of SURFACES) {
				const base = resolveColor(`var(${surface})`, tokens);
				ratios[surface] = contrastRatio(text, base);
				ratios[`badge on ${surface}`] = contrastRatio(
					text,
					paintOver(red, alpha, base),
				);
			}
			expect(belowAA(ratios)).toEqual({});
		},
	);

	it.each(PALETTES)(
		"keeps %s red status text at 4.5:1 on every surface and on the error badge",
		(_, __, tokens) => {
			const text = resolveColor(ink(RED_STATUS), tokens);
			const red = resolveColor("var(--status-error)", tokens);
			const alpha = tintAlpha(errorBadge, "bg-status-error/");
			const ratios: Record<string, number> = {};
			for (const surface of SURFACES) {
				const base = resolveColor(`var(${surface})`, tokens);
				ratios[surface] = contrastRatio(text, base);
				ratios[`badge on ${surface}`] = contrastRatio(
					text,
					paintOver(red, alpha, base),
				);
			}
			expect(belowAA(ratios)).toEqual({});
		},
	);

	it.each(PALETTES.slice(0, 2))(
		"keeps %s red text and red status text red",
		(_, __, tokens) => {
			for (const rule of [RED_TEXT, RED_STATUS]) {
				const { a, b } = resolveColor(ink(rule), tokens);
				expect(Math.hypot(a, b)).toBeGreaterThanOrEqual(0.08);
				// Hue in degrees: red sits near 25; orange and pink start past 45 and below 0.
				const hue = (Math.atan2(b, a) * 180) / Math.PI;
				expect(hue).toBeGreaterThan(0);
				expect(hue).toBeLessThan(45);
			}
		},
	);
});
