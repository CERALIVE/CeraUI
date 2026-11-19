import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	appCss,
	balancedBlock,
	contrastRatio,
	declValue,
	resolveColor,
	ruleBody,
	tokenMap,
	tokensCss,
} from "./helpers/css-contrast";

/**
 * The destructive button (CLI-managed, never edited) paints its fills from its
 * recipe; app.css owns its label colour and its disabled look. Every
 * destructive confirmation uses it, System Logs' Clear all logs and Clear
 * event history included. The label keeps WCAG AA 4.5:1 on the resting, focus
 * and hover fills and while disabled, in the light, dark and e-ink palettes,
 * and it stays red so the action still reads as destructive. Resolved from the
 * real stylesheets, as in toggle-on-contrast.test.ts.
 */

const DESTRUCTIVE =
	":is([data-slot='button'], [data-slot='alert-dialog-action'])[class~='bg-destructive/10']";
const NAMES = ["--card", "--foreground", "--destructive"];
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

const [, recipe = ""] =
	readFileSync(
		fileURLToPath(
			new URL("../lib/components/ui/button/button.svelte", import.meta.url),
		),
		"utf8",
	).match(/destructive:\s*'([^']+)'/) ?? [];
const classes = recipe.split(/\s+/);

/** The dialog card under the recipe's `<variant>bg-destructive/<N>` tint, mixed in oklab. */
function tint(variant: string): string {
	const prefix = `${variant}bg-destructive/`;
	const percent = classes
		.find((name) => name.startsWith(prefix))
		?.slice(prefix.length);
	if (percent === undefined) throw new Error(`no ${prefix}N class`);
	return `color-mix(in oklab, var(--destructive) ${percent}%, var(--card))`;
}

const label = () => declValue(ruleBody(appCss, `${DESTRUCTIVE} {`), "color");
const disabled = () => ruleBody(appCss, `${DESTRUCTIVE}:disabled {`);

describe("destructive button colours", () => {
	it("draws the fills app.css keys on, with no separate focus fill", () => {
		expect(classes).toContain("bg-destructive/10");
		expect(
			classes.filter((name) => name.includes("focus-visible:bg-")),
		).toEqual([]);
	});

	it.each(PALETTES)(
		"keeps the %s label at 4.5:1 at rest, on focus, on hover and disabled",
		(_, variant, tokens) => {
			const ink = resolveColor(label(), tokens);
			expect(
				contrastRatio(ink, resolveColor(tint(variant), tokens)),
			).toBeGreaterThanOrEqual(4.5);
			expect(
				contrastRatio(ink, resolveColor(tint(`${variant}hover:`), tokens)),
			).toBeGreaterThanOrEqual(4.5);
			expect(declValue(disabled(), "opacity")).toBe("1");
			expect(
				contrastRatio(
					resolveColor(declValue(disabled(), "color"), tokens),
					resolveColor(declValue(disabled(), "background-color"), tokens),
				),
			).toBeGreaterThanOrEqual(4.5);
		},
	);

	it.each(PALETTES.slice(0, 2))("keeps the %s label red", (_, __, tokens) => {
		const { a, b } = resolveColor(label(), tokens);
		expect(Math.hypot(a, b)).toBeGreaterThanOrEqual(0.08);
	});
});
