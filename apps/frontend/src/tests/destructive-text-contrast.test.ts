import { readdirSync, readFileSync } from "node:fs";
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
const NAMES = [
	...SURFACES,
	"--foreground",
	"--destructive",
	"--status-error",
	"--status-warning",
	"--destructive-foreground",
];
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
// Red only while hovered: the Wi-Fi list's Forget icon (WifiNetworkList.svelte).
const RED_TEXT_HOVER = {
	selector: ".hover\\:text-destructive:hover",
	utility: "var(--destructive)",
};
// A faded line on the solid red fill: pwa-status.svelte's bars (opacity-80).
const FADED_ON_RED_FILL =
	".bg-destructive.text-destructive-foreground .opacity-80";
// A sonner error toast's icon (LayoutToastHost.svelte), on the toast's own red tint.
const ERROR_TOAST = "[data-sonner-toast][data-type='error']";
const ERROR_TOAST_ICON = {
	selector: `${ERROR_TOAST} [data-icon]`,
	utility: "",
};
// Red status inside the inverted tooltip (bg-foreground): the HUD health legend.
const RED_STATUS_ON_TOOLTIP = {
	selector: "[data-slot='tooltip-content'] .text-status-error",
	utility: "",
};
// ui/dropdown-menu (CLI-managed): a destructive item's label and icon, which its
// recipe sets through variant forms of `text-destructive`.
const DESTRUCTIVE_MENU_ITEM = {
	selector:
		":is([data-slot='dropdown-menu-item'][data-variant='destructive'], [data-slot='dropdown-menu-item'][data-variant='destructive'] > svg)",
	utility: "var(--destructive)",
};
// Tailwind compiles a variant form of a red ink to the raw token, out of reach of
// the class-keyed rules, so each one names the app.css rule that sets its ink.
const VARIANT_RED_INKS: Record<string, string> = {
	"hover:text-destructive": RED_TEXT_HOVER.selector,
	"data-[variant=destructive]:text-destructive": DESTRUCTIVE_MENU_ITEM.selector,
	"data-[variant=destructive]:focus:text-destructive":
		DESTRUCTIVE_MENU_ITEM.selector,
	"data-[variant=destructive]:*:[svg]:text-destructive":
		DESTRUCTIVE_MENU_ITEM.selector,
};

const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A source file's class names, split on whitespace and quotes. */
function classTokens(path: string): string[] {
	return readFileSync(`${SOURCE_ROOT}${path}`, "utf8").split(/[\s"'`]+/);
}

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
const destructiveMenuItem = classTokens(
	"lib/components/ui/dropdown-menu/dropdown-menu-item.svelte",
);
// A Button rendered as a primitive's child snippet (`<Button {...props} variant="destructive">`)
// takes the primitive's data-slot from those props, over its own: under ui/dialog's Close
// (IdentityPreview.svelte's "Restart now") it is no longer "button".
const [, dialogCloseSlot] =
	readFileSync(
		`${SOURCE_ROOT}lib/components/ui/dialog/dialog-close.svelte`,
		"utf8",
	).match(/data-slot="([^"]+)"/) ?? [];
const [, buttonBase = ""] =
	readFileSync(
		`${SOURCE_ROOT}lib/components/ui/button/button.svelte`,
		"utf8",
	).match(/base:\s*"([^"]+)"/) ?? [];
const buttonClasses = (variant: string) =>
	[
		buttonBase,
		...recipe("../lib/components/ui/button/button.svelte", variant),
	].join(" ");

/**
 * Whether an element with these attributes matches `selector`, in the forms the
 * destructive button rule is written in: an optional `:is(...)` list, then
 * `[name='value']` and `[name~='value']` parts.
 */
function matchesAttributes(
	selector: string,
	attributes: Record<string, string>,
): boolean {
	const part = (text: string) => {
		const match = text.match(/^\[([\w-]+)(~?)='([^']*)'\]$/);
		if (match === null) throw new Error(`unsupported selector part ${text}`);
		const [, name = "", list, value = ""] = match;
		const have = attributes[name] ?? "";
		return list ? have.split(/\s+/).includes(value) : have === value;
	};
	const [is, alternatives = ""] = selector.match(/^:is\(([^)]*)\)/) ?? [];
	if (is !== undefined && !alternatives.split(/,\s*/).some(part)) return false;
	const rest = selector.slice(is?.length ?? 0);
	return (rest.match(/\[[^\]]+\]/g) ?? []).every(part);
}

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

	it.each(PALETTES)(
		"keeps %s red text at 4.5:1 on the amber warning tint it sits on",
		(_, __, tokens) => {
			// HotspotActivationConfirm.svelte: name, password, load and save errors
			// inside its bg-status-warning/10 panel, in a popover, card or dialog.
			const text = resolveColor(ink(RED_TEXT), tokens);
			const amber = resolveColor("var(--status-warning)", tokens);
			const ratios: Record<string, number> = {};
			for (const surface of SURFACES) {
				const base = resolveColor(`var(${surface})`, tokens);
				ratios[`amber on ${surface}`] = contrastRatio(
					text,
					paintOver(amber, 0.1, base),
				);
			}
			expect(belowAA(ratios)).toEqual({});
		},
	);

	it.each(PALETTES)(
		"keeps %s red status text at 4.5:1 on the error badge over the amber warning tint",
		(_, __, tokens) => {
			// SharingSection.svelte: a down uplink's error Badge inside the section's
			// bg-status-warning/10 headline surface, in a card or on the page.
			const text = resolveColor(ink(RED_STATUS), tokens);
			const amber = resolveColor("var(--status-warning)", tokens);
			const red = resolveColor("var(--status-error)", tokens);
			const alpha = tintAlpha(errorBadge, "bg-status-error/");
			const ratios: Record<string, number> = {};
			for (const surface of SURFACES) {
				const base = resolveColor(`var(${surface})`, tokens);
				ratios[`badge on amber on ${surface}`] = contrastRatio(
					text,
					paintOver(red, alpha, paintOver(amber, 0.1, base)),
				);
			}
			expect(belowAA(ratios)).toEqual({});
		},
	);

	it.each(PALETTES)(
		"keeps %s faded text on the solid destructive fill at 4.5:1",
		(_, __, tokens) => {
			const opacity = appCss.includes(`${FADED_ON_RED_FILL} {`)
				? Number(
						declValue(ruleBody(appCss, `${FADED_ON_RED_FILL} {`), "opacity"),
					)
				: 0.8;
			const fill = resolveColor("var(--destructive)", tokens);
			const text = paintOver(
				resolveColor("var(--destructive-foreground)", tokens),
				opacity,
				fill,
			);
			expect(belowAA({ "faded line": contrastRatio(text, fill) })).toEqual({});
		},
	);

	it.each(PALETTES)(
		"keeps %s red status text at 4.5:1 inside the inverted tooltip",
		(_, __, tokens) => {
			// HudBar.svelte: the health legend's Dead glyph, on the tooltip's
			// --foreground fill; without a rule of its own it takes the page ink.
			const rule = ink(RED_STATUS_ON_TOOLTIP) || ink(RED_STATUS);
			const ratio = contrastRatio(
				resolveColor(rule, tokens),
				resolveColor("var(--foreground)", tokens),
			);
			expect(belowAA({ "tooltip --foreground": ratio })).toEqual({});
		},
	);

	it.each(PALETTES)(
		"keeps %s error toast icon in the red status ink, at 4.5:1 on the toast's red tint",
		(_, __, tokens) => {
			// The toast rules carry !important to beat sonner's own styles.
			const plain = (value: string) => value.replace(/\s*!important$/, "");
			const icon = plain(ink(ERROR_TOAST_ICON));
			const tint = plain(
				declValue(ruleBody(appCss, `${ERROR_TOAST} {`), "background"),
			);
			const ratio = contrastRatio(
				resolveColor(icon, tokens),
				resolveColor(tint, tokens),
			);
			expect(belowAA({ "error toast tint": ratio })).toEqual({});
			expect(icon).toBe(ink(RED_STATUS));
		},
	);

	it.each(PALETTES)(
		"keeps %s hover-only red text in the red text ink, at 4.5:1 on every surface",
		(_, __, tokens) => {
			const text = resolveColor(ink(RED_TEXT_HOVER), tokens);
			const ratios: Record<string, number> = {};
			for (const surface of SURFACES) {
				ratios[surface] = contrastRatio(
					text,
					resolveColor(`var(${surface})`, tokens),
				);
			}
			expect(belowAA(ratios)).toEqual({});
			expect(ink(RED_TEXT_HOVER)).toBe(ink(RED_TEXT));
		},
	);

	it("gives a destructive Button its label rule when a primitive re-slots it", () => {
		const selector = appCss
			.split("\n")
			.find((line) => line.endsWith("[class~='bg-destructive/10'] {"))
			?.slice(0, -2);
		expect(selector).toBeDefined();
		expect(dialogCloseSlot).toBeDefined();
		expect(dialogCloseSlot).not.toBe("button");
		const destructive = buttonClasses("destructive");
		const rule = (slot: string, classes = destructive) =>
			matchesAttributes(selector ?? "", { class: classes, "data-slot": slot });
		expect(rule("button")).toBe(true);
		expect(rule(dialogCloseSlot ?? "")).toBe(true);
		expect(rule(dialogCloseSlot ?? "", buttonClasses("outline"))).toBe(false);
		expect(appCss).toContain(`${selector}:disabled {`);
	});

	it("names an app.css rule for every variant form of a red ink in the app", () => {
		const found = new Set<string>();
		for (const path of readdirSync(SOURCE_ROOT, {
			recursive: true,
			encoding: "utf8",
		})) {
			if (
				!/\.(svelte|ts)$/.test(path) ||
				/\.test\.ts$|(^|\/)tests\//.test(path)
			)
				continue;
			for (const token of classTokens(path))
				if (/.:text-(destructive|status-error)$/.test(token)) found.add(token);
		}
		expect([...found].sort()).toEqual(Object.keys(VARIANT_RED_INKS).sort());
		for (const selector of new Set(Object.values(VARIANT_RED_INKS)))
			expect(appCss).toContain(`${selector} {`);
	});

	it.each(PALETTES)(
		"keeps %s destructive menu item in the red text ink, at 4.5:1 on the popover and on its focus tint",
		(_, variant, tokens) => {
			// The focus wash is also the hover one: bits-ui focuses the item under the pointer.
			const alpha = tintAlpha(
				destructiveMenuItem,
				`${variant}data-[variant=destructive]:focus:bg-destructive/`,
			);
			const text = resolveColor(ink(DESTRUCTIVE_MENU_ITEM), tokens);
			const popover = resolveColor("var(--popover)", tokens);
			const red = resolveColor("var(--destructive)", tokens);
			expect(
				belowAA({
					popover: contrastRatio(text, popover),
					"focus tint": contrastRatio(text, paintOver(red, alpha, popover)),
				}),
			).toEqual({});
			expect(ink(DESTRUCTIVE_MENU_ITEM)).toBe(ink(RED_TEXT));
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
