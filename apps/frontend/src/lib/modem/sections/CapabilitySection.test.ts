// @vitest-environment jsdom
/**
 * THE FOUR-STATE CONTRACT, asserted against the rendered DOM.
 *
 * Each state is proven by what is in the document, not by a class name a CSS
 * change would walk straight through:
 *
 *   absent    — the container holds NO ELEMENT and NO TEXT. Not "hidden", not
 *               "zero height": a visibility assertion passes on the ghost row
 *               CT-1 forbids, so the assertion counts nodes. (Svelte leaves one
 *               empty `<!---->` block anchor behind an `{#if}`; it renders
 *               nothing, occupies nothing and is not addressable — the element
 *               and text counts are what a ghost would actually show up in.)
 *   unknown   — a `role="status"` diagnostic AND no control of any kind. The
 *               no-control half is the one that matters: a disabled control here
 *               claims a capability nobody has shown exists.
 *   blocked   — the control, disabled, AND the reason as visible text. A reason
 *               that lives only in an attribute is unreachable on the shipped
 *               kiosk touchscreen.
 *   available — the control, live.
 */

import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import CapabilityHarness from "./__fixtures__/CapabilityHarness.svelte";
import type { CapabilityView } from "./types";

const BLOCKED_REASON_KEY = "network.modem.gps.reason.notReported";
const UNKNOWN_REASON_KEY = "network.modem.sections.capability.unproven";

function mount(view: CapabilityView, props: Record<string, unknown> = {}) {
	return render(CapabilityHarness, { props: { view, ...props } });
}

/** Every element a control could plausibly be, so "no control" is provable. */
function controls(container: HTMLElement): Element[] {
	return [
		...container.querySelectorAll(
			"button, input, select, textarea, [role='switch']",
		),
	];
}

describe("absent — not one node", () => {
	it("renders NOTHING at all", () => {
		const { container } = mount({ mode: "absent" });

		expect(container.querySelectorAll("*")).toHaveLength(0);
		expect(container.textContent).toBe("");
	});

	it("mounts no live region either", () => {
		const { container } = mount({ mode: "absent" });

		expect(container.querySelector("[role='status']")).toBeNull();
		expect(container.querySelector("[role='alert']")).toBeNull();
	});
});

describe("unknown — a diagnostic, and NO control", () => {
	const view: CapabilityView = {
		mode: "unknown",
		reasonKey: UNKNOWN_REASON_KEY,
	};

	it("tags the section so a gate can tell the four apart", () => {
		const { getByTestId } = mount(view);

		expect(
			getByTestId("harness-capability").getAttribute("data-capability-state"),
		).toBe("unknown");
	});

	it("renders the reason as an announced, visibly distinct diagnostic", () => {
		const { getByTestId } = mount(view);
		const diagnostic = getByTestId("harness-capability-unknown");

		expect(diagnostic.getAttribute("role")).toBe("status");
		expect(diagnostic.getAttribute("data-state")).toBe("unknown");
		expect(diagnostic.textContent?.trim().length).toBeGreaterThan(0);
		// Never a dotted key on screen.
		expect(diagnostic.textContent).not.toContain(UNKNOWN_REASON_KEY);
	});

	/*
	  THE LOAD-BEARING ONE. Below `capable` nobody has shown there is a capability
	  being withheld, so a disabled control would claim one — and a disabled
	  control is indistinguishable, to an operator, from a supported feature the
	  device is refusing right now.
	*/
	it("offers no control — not even a disabled one", () => {
		const { container, queryByTestId } = mount(view);

		expect(queryByTestId("harness-capability-toggle")).toBeNull();
		expect(queryByTestId("harness-capability-control")).toBeNull();
		expect(controls(container)).toHaveLength(0);
	});

	it("renders no `blocked` refusal line", () => {
		const { queryByTestId } = mount(view);

		expect(queryByTestId("harness-capability-reason")).toBeNull();
	});

	it("renders no `available` body", () => {
		const { queryByTestId } = mount(view);

		expect(queryByTestId("harness-capability-body")).toBeNull();
	});
});

describe("blocked — a disabled control with its reason ON SCREEN", () => {
	const view: CapabilityView = {
		mode: "blocked",
		reasonKey: BLOCKED_REASON_KEY,
	};

	it("tags the section", () => {
		const { getByTestId } = mount(view);

		expect(
			getByTestId("harness-capability").getAttribute("data-capability-state"),
		).toBe("blocked");
	});

	it("renders the control, disabled", () => {
		const { getByTestId } = mount(view);
		const toggle = getByTestId(
			"harness-capability-toggle",
		) as HTMLButtonElement;

		expect(toggle.disabled).toBe(true);
		expect(toggle.getAttribute("data-control-state")).toBe("blocked");
	});

	it("puts the reason in visible text, not only in an attribute", () => {
		const { getByTestId } = mount(view);
		const reason = getByTestId("harness-capability-reason");

		expect(reason.textContent?.trim().length).toBeGreaterThan(0);
		expect(reason.textContent).not.toContain(BLOCKED_REASON_KEY);
	});

	it("hands the control the resolved reason and the reason's id", () => {
		const { getByTestId } = mount(view);
		const toggle = getByTestId("harness-capability-toggle");
		const reason = getByTestId("harness-capability-reason");

		expect(toggle.getAttribute("aria-describedby")).toBe(reason.id);
		expect(toggle.getAttribute("aria-label")).toBe(reason.textContent?.trim());
	});

	it("renders no `unknown` diagnostic and no `available` body", () => {
		const { queryByTestId } = mount(view);

		expect(queryByTestId("harness-capability-unknown")).toBeNull();
		expect(queryByTestId("harness-capability-body")).toBeNull();
	});
});

describe("available — a live control", () => {
	const view: CapabilityView = { mode: "available" };

	it("tags the section", () => {
		const { getByTestId } = mount(view);

		expect(
			getByTestId("harness-capability").getAttribute("data-capability-state"),
		).toBe("available");
	});

	it("renders the control, enabled, with no refusal attached", () => {
		const { getByTestId } = mount(view);
		const toggle = getByTestId(
			"harness-capability-toggle",
		) as HTMLButtonElement;

		expect(toggle.disabled).toBe(false);
		expect(toggle.getAttribute("data-control-state")).toBe("available");
		expect(toggle.getAttribute("aria-label")).toBeNull();
		expect(toggle.getAttribute("aria-describedby")).toBeNull();
	});

	it("renders the caller's readings", () => {
		const { getByTestId } = mount(view);

		expect(getByTestId("harness-capability-body")).toBeTruthy();
	});

	it("renders no reason line of either kind", () => {
		const { queryByTestId } = mount(view);

		expect(queryByTestId("harness-capability-unknown")).toBeNull();
		expect(queryByTestId("harness-capability-reason")).toBeNull();
	});
});

describe("an in-flight write disables the control WITHOUT changing the state", () => {
	it("keeps the section `available` while disabling the control", () => {
		const { getByTestId } = mount({ mode: "available" }, { busy: true });
		const toggle = getByTestId(
			"harness-capability-toggle",
		) as HTMLButtonElement;

		expect(
			getByTestId("harness-capability").getAttribute("data-capability-state"),
		).toBe("available");
		expect(toggle.disabled).toBe(true);
		// Still `available`: `busy` is a transient, not a refusal, and a control
		// that reported `blocked` here would invite the caller to render a reason
		// the device never gave.
		expect(toggle.getAttribute("data-control-state")).toBe("available");
	});
});

describe("the outcome band rides the section", () => {
	it("mounts both live regions with the surface, before any outcome exists", () => {
		const { getByTestId } = mount({ mode: "available" });

		expect(getByTestId("harness-capability-announce-polite")).toBeTruthy();
		expect(getByTestId("harness-capability-announce-assertive")).toBeTruthy();
	});

	it("renders a terminal outcome in a persistent band", () => {
		const { getByTestId } = mount(
			{ mode: "available" },
			{ outcome: { kind: "refused", message: "The device said no." } },
		);
		const band = getByTestId("harness-capability-outcome");

		expect(band.getAttribute("data-outcome")).toBe("refused");
		expect(band.textContent).toContain("The device said no.");
	});
});

describe("the heading labels the control when the caller supplies an id", () => {
	it("renders a <label for> pointing at it", () => {
		const { container } = mount(
			{ mode: "available" },
			{ controlId: "harness-toggle" },
		);
		const label = container.querySelector("label");

		expect(label?.getAttribute("for")).toBe("harness-toggle");
	});

	it("renders a plain heading when there is no control to label", () => {
		const { container } = mount({
			mode: "unknown",
			reasonKey: UNKNOWN_REASON_KEY,
		});

		expect(container.querySelector("label")).toBeNull();
		expect(container.textContent).toContain("Location");
	});
});
