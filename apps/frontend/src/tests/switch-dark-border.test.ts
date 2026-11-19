import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	balancedBlock,
	contrastRatio,
	appCss as css,
	declValue,
	resolveColor,
	ruleBody,
	tokenMap,
	tokensCss,
} from "./helpers/css-contrast";

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

const TRANSPARENT_TOKENS = new Set([
	"transparent",
	"rgba(0,0,0,0)",
	"rgba(0, 0, 0, 0)",
]);

const darkTokens = tokenMap(balancedBlock(tokensCss, '[data-theme="dark"]'), [
	"--switch-off",
	"--muted-foreground",
	"--border",
	"--card",
]);

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
		const border = resolveColor(borderColor, darkTokens);
		const card = resolveColor("var(--card)", darkTokens);
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
