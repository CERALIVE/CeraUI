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
 * The pressed state of the toggle primitive (CLI-managed, never edited) is
 * styled by app.css's `[data-slot='toggle'][data-state='on']` rule; the Events
 * filter chips are its consumer. A pressed chip's label keeps WCAG AA 4.5:1 on
 * its fill, and the fill stands 3:1 apart from the surfaces around it, in the
 * light, dark and e-ink palettes. Resolved from the real stylesheets, as in
 * switch-dark-border.test.ts.
 */

const NAMES = [
	"--background",
	"--foreground",
	"--card",
	"--primary",
	"--primary-foreground",
	"--switch-off",
];
const PALETTES = [
	["light", tokenMap(balancedBlock(tokensCss, ".light {"), NAMES)],
	["dark", tokenMap(balancedBlock(tokensCss, '[data-theme="dark"] {'), NAMES)],
	[
		"e-ink",
		tokenMap(balancedBlock(appCss, "html[data-theme='eink'] {"), NAMES),
	],
] as const;

const pressed = ruleBody(appCss, "[data-slot='toggle'][data-state='on']");

describe("pressed toggle colours", () => {
	it.each(PALETTES)("keeps the %s label at 4.5:1 on its fill", (_, tokens) => {
		const fill = resolveColor(declValue(pressed, "background-color"), tokens);
		const label = resolveColor(declValue(pressed, "color"), tokens);

		expect(contrastRatio(fill, label)).toBeGreaterThanOrEqual(4.5);
	});

	it.each(PALETTES)(
		"sets the %s fill 3:1 apart from the page and card",
		(_, tokens) => {
			const fill = resolveColor(declValue(pressed, "background-color"), tokens);

			for (const surface of ["var(--background)", "var(--card)"])
				expect(
					contrastRatio(fill, resolveColor(surface, tokens)),
				).toBeGreaterThanOrEqual(3);
		},
	);
});
