import type { TransitionConfig } from "svelte/transition";
import { afterEach, describe, expect, it } from "vitest";

import {
	DEFAULT_DISPLAY_PROFILE,
	setDisplayProfile,
} from "$lib/stores/display-profile.svelte";
import {
	einkGatedFade,
	einkGatedFly,
	einkGatedSlide,
	gateForEink,
} from "$lib/transitions";

/**
 * T10 — e-ink motion gate for JS-driven Svelte transitions.
 *
 * Svelte's css-based transitions (slide/fade/fly) compile to the Web Animations
 * API, which the global e-ink CSS freeze cannot stop. `gateForEink` wraps a
 * transition so it returns a css-less, zero-duration config under the e-ink/mono
 * profiles (Svelte then starts no animation) while passing straight through under
 * lcd. This suite pins that profile-scoped behaviour against a stub transition
 * (no DOM needed) and confirms the three exported wrappers no-op under e-ink.
 *
 * Node env (no `window`): the e-ink branch returns before the wrapped transition
 * runs, so the real slide/fly/fade — which read `getComputedStyle` — are never
 * called on that path, and the lcd path is exercised via a DOM-free stub.
 */

const STUB_DURATION = 321;

function stub(
	_node: Element,
	params?: { duration?: number },
): TransitionConfig {
	return {
		duration: params?.duration ?? 150,
		css: (t) => `opacity: ${t}`,
	};
}

const fakeNode = null as unknown as Element;

afterEach(() => {
	setDisplayProfile(DEFAULT_DISPLAY_PROFILE);
});

describe("gateForEink", () => {
	it("passes the real transition through under the lcd profile", () => {
		setDisplayProfile("lcd");
		const gated = gateForEink(stub);

		const config = gated(fakeNode, { duration: STUB_DURATION });

		expect(config.duration).toBe(STUB_DURATION);
		expect(typeof config.css).toBe("function");
	});

	it("returns a css-less, zero-duration no-op under the eink profile", () => {
		setDisplayProfile("eink");
		const gated = gateForEink(stub);

		const config = gated(fakeNode, { duration: STUB_DURATION });

		expect(config.duration).toBe(0);
		expect(config.css).toBeUndefined();
		expect(config.tick).toBeUndefined();
	});

	it("returns the same no-op under the mono profile", () => {
		setDisplayProfile("mono");
		const gated = gateForEink(stub);

		const config = gated(fakeNode, { duration: STUB_DURATION });

		expect(config.duration).toBe(0);
		expect(config.css).toBeUndefined();
	});

	it("does not invoke the wrapped transition at all under e-ink", () => {
		setDisplayProfile("eink");
		let called = false;
		const gated = gateForEink((_node: Element): TransitionConfig => {
			called = true;
			return { duration: 999, css: () => "" };
		});

		gated(fakeNode);

		expect(called).toBe(false);
	});
});

describe("exported eink-gated transitions", () => {
	for (const profile of ["eink", "mono"] as const) {
		it(`einkGatedSlide/Fade/Fly are frozen no-ops under ${profile}`, () => {
			setDisplayProfile(profile);

			for (const transition of [einkGatedSlide, einkGatedFade, einkGatedFly]) {
				const config = transition(fakeNode, { duration: 150 });
				expect(config.duration).toBe(0);
				expect(config.css).toBeUndefined();
			}
		});
	}
});
