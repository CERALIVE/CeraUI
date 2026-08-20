// @vitest-environment jsdom
/**
 * A COLLAPSED DISCLOSURE MUST BE HIDDEN, NOT MERELY UNPAINTED.
 *
 * `CollapsibleSection` keeps its body MOUNTED and `inert` while collapsed and
 * reveals it with a CSS `grid-template-rows: 0fr → 1fr` transition. Both are
 * deliberate (see the component header). What neither of them does is withdraw
 * the content from HIT TESTING: `overflow: hidden` clips painting, and every
 * control inside keeps a full-size layout box at its uncollapsed coordinates.
 *
 * The Cellular row hit exactly this on the bench board — a collapsed
 * `open-router-admin` reporting 173x32 at y=1433 from inside a 0px-tall
 * ancestor, which Playwright called visible and then retried
 * `intercepts pointer events` against forever — and fixed it on its own copy of
 * this markup. This is the SHARED component; the same guard belongs here, and
 * these assertions are what stop a later class-list tidy from removing it.
 *
 * jsdom lays nothing out, so the ESCAPING BOX itself is a browser fact and is
 * asserted in `tests/e2e/modem-advanced-disclosure.spec.ts`. What is provable
 * here is the guard's presence, its transition, and the two things it must not
 * be confused with.
 */

import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import CollapsibleHarness from "./__fixtures__/CollapsibleHarness.svelte";
import CollapsibleSection from "./CollapsibleSection.svelte";

function mount(open = false) {
	return render(CollapsibleHarness, {
		props: {
			open,
			title: "Advanced",
			bodyId: "harness-body",
			testid: "harness",
			toggleTestid: "harness-toggle",
			bodyTestid: "harness-body",
		},
	});
}

/** The `overflow: hidden` wrapper the guard lives on. */
function clip(getByTestId: (id: string) => HTMLElement): HTMLElement {
	const el = getByTestId("harness-body").firstElementChild;
	if (!(el instanceof HTMLElement)) throw new Error("no clipping wrapper");
	return el;
}

describe("the clipped body is withdrawn from hit testing while collapsed", () => {
	it("marks the clipping wrapper visibility:hidden", () => {
		const { getByTestId } = mount();

		expect(getByTestId("harness-body").getAttribute("data-open")).toBe("false");
		expect(clip(getByTestId).style.visibility).toBe("hidden");
	});

	it("reveals it on open and withdraws it again on close", async () => {
		const { getByTestId } = mount();

		await fireEvent.click(getByTestId("harness-toggle"));
		expect(clip(getByTestId).style.visibility).toBe("visible");

		await fireEvent.click(getByTestId("harness-toggle"));
		expect(clip(getByTestId).style.visibility).toBe("hidden");
	});

	it("opens visible when it starts open", () => {
		const { getByTestId } = mount(true);

		expect(clip(getByTestId).style.visibility).toBe("visible");
	});

	/*
	  The transition is load-bearing, not decoration: a `visibility` transition
	  whose start value is `visible` holds `visible` for the whole duration, so
	  the CLOSE still animates alongside the grid collapse while the OPEN is
	  instant. Drop it and the body vanishes a frame before the row finishes
	  shrinking.
	*/
	it("transitions the guard so the close still animates", () => {
		const { getByTestId } = mount();

		expect(clip(getByTestId).className).toContain("transition-[visibility]");
	});
});

describe("the guard is not a substitute for what was already there", () => {
	/*
	  `inert` governs focus and the accessibility tree; `visibility` governs
	  painting and hit testing. Neither implies the other, and the component
	  needs BOTH — asserted together so a future edit cannot trade one for the
	  other and call it a simplification.
	*/
	it("keeps `inert` on the collapsed body", async () => {
		const { getByTestId } = mount();
		const body = getByTestId("harness-body") as HTMLElement & {
			inert?: boolean;
		};

		// jsdom implements `inert` as a property and never reflects it to an
		// attribute, so `hasAttribute` is permanently false here.
		expect(body.inert).toBe(true);

		await fireEvent.click(getByTestId("harness-toggle"));
		expect(body.inert).toBe(false);
	});

	it("keeps the CSS grid reveal rather than a JS transition", () => {
		const { getByTestId } = mount();
		const body = getByTestId("harness-body");

		expect(body.style.gridTemplateRows).toBe("0fr");
		expect(body.className).toContain("transition-[grid-template-rows]");
	});

	it("keeps the body MOUNTED while collapsed", () => {
		const { getByTestId, getByText } = mount();

		expect(getByTestId("harness-body").textContent).toContain("body content");
		expect(getByText("body content")).toBeTruthy();
	});
});

describe("the trigger announces what it controls", () => {
	it("wires aria-controls / aria-expanded to the body", async () => {
		const { getByTestId } = mount();
		const toggle = getByTestId("harness-toggle");

		expect(toggle.getAttribute("aria-controls")).toBe("harness-body");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");

		await fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
	});

	it("is at least the 44px touch target", () => {
		const { getByTestId } = mount();

		expect(getByTestId("harness-toggle").className).toContain("min-h-[44px]");
	});
});

describe("the component under test is the shared one", () => {
	it("is the module every consumer imports", () => {
		expect(CollapsibleSection).toBeTypeOf("function");
	});
});
