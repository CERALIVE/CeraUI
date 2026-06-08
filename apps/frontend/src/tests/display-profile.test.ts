import { afterEach, describe, expect, it } from "vitest";

import {
	DEFAULT_DISPLAY_PROFILE,
	DISPLAY_PROFILES,
	type DisplayProfile,
	getDisplayProfile,
	parseDisplayProfile,
	prefersEinkTheme,
	setDisplayProfile,
} from "$lib/stores/display-profile.svelte";

/**
 * Display-profile store + URL contract (DC-4).
 *
 * Mirrors `layout-mode.svelte.ts`: a `$persist`-backed runes store with a
 * getter/setter, defaulting to `lcd`. App.svelte parses `?display=lcd|eink|mono`
 * and reflects the profile onto `<html>` (`data-display` always; `data-theme="eink"`
 * for the e-ink/mono profiles). This suite pins the pure, node-testable surface:
 * the default, the getter/setter round-trip, the param normalization (with
 * fallback to `lcd`), and the eink-theme predicate that drives `data-theme`.
 *
 * The vitest environment is `node` (no `window`), so `svelte-persistent-runes`
 * never touches localStorage and the store starts at its declared default.
 */

afterEach(() => {
	// Module-level $persist state is shared across tests; reset to default so
	// setter tests don't leak into ordering-sensitive default assertions.
	setDisplayProfile(DEFAULT_DISPLAY_PROFILE);
});

describe("display-profile store", () => {
	it("declares lcd as the default profile", () => {
		expect(DEFAULT_DISPLAY_PROFILE).toBe("lcd");
		expect(getDisplayProfile()).toBe("lcd");
	});

	it("exposes the three known profiles without duplicates", () => {
		expect(DISPLAY_PROFILES).toEqual(["lcd", "eink", "mono"]);
		expect(new Set(DISPLAY_PROFILES).size).toBe(DISPLAY_PROFILES.length);
	});

	it("round-trips every known profile through the getter/setter", () => {
		for (const profile of DISPLAY_PROFILES) {
			setDisplayProfile(profile);
			expect(getDisplayProfile()).toBe(profile);
		}
	});
});

describe("parseDisplayProfile", () => {
	it("accepts each known profile verbatim", () => {
		for (const profile of DISPLAY_PROFILES) {
			expect(parseDisplayProfile(profile)).toBe(profile);
		}
	});

	it("falls back to lcd when the param is absent", () => {
		expect(parseDisplayProfile(null)).toBe("lcd");
		expect(parseDisplayProfile(undefined)).toBe("lcd");
	});

	it("falls back to lcd for unknown / malformed values", () => {
		for (const bogus of ["bogus", "LCD", "e-ink", "", " mono", "0"]) {
			expect(parseDisplayProfile(bogus)).toBe("lcd");
		}
	});
});

describe("prefersEinkTheme", () => {
	it('is true for the e-ink and mono profiles (data-theme="eink")', () => {
		expect(prefersEinkTheme("eink")).toBe(true);
		expect(prefersEinkTheme("mono")).toBe(true);
	});

	it("is false for the lcd profile (no data-theme override)", () => {
		expect(prefersEinkTheme("lcd")).toBe(false);
	});

	it("covers every profile in the union", () => {
		const seen: Record<DisplayProfile, boolean> = {
			lcd: prefersEinkTheme("lcd"),
			eink: prefersEinkTheme("eink"),
			mono: prefersEinkTheme("mono"),
		};
		expect(seen).toEqual({ lcd: false, eink: true, mono: true });
	});
});
