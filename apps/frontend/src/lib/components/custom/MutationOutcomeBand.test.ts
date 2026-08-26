// @vitest-environment jsdom
/**
 * THE BAND'S DETAIL BLOCK, asserted against the rendered DOM.
 *
 * `DESIGN.md` §8 already had the band; what is proven here is the part a mocked
 * `t` or a key-shape assertion cannot see — that an `unknown-outcome` really
 * reaches the operator as neither a success nor a failure, that its
 * reconciliation pointer is on screen rather than only announced, and that it
 * never appears beside a retry.
 *
 * Two shapes are deliberate:
 *
 *  1. **THE ANNOUNCEMENT IS COMPARED TO THE VISIBLE TEXT.** LR-3 says an outcome
 *     is announced exactly once and LR-1 says the region exists beforehand, so
 *     "the detail rendered" and "the detail was announced" are two different
 *     claims and both are made.
 *  2. **RETRY AND RECONCILIATION ARE ASSERTED AS MUTUALLY EXCLUSIVE.** That is
 *     the safety rule: a retry offered beside an unknown outcome is how a write
 *     that may already have landed gets applied a second time.
 */

import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import type {
	MutationOutcome,
	MutationOutcomeDetail,
} from "$lib/modem/mutation-outcome";

import MutationOutcomeBand from "./MutationOutcomeBand.svelte";

const NAME = "probe";

function mount(
	outcome: MutationOutcome | undefined,
	detail?: MutationOutcomeDetail,
) {
	return render(MutationOutcomeBand, {
		props: { name: NAME, outcome, detail },
	});
}

const UNKNOWN_DETAIL: MutationOutcomeDetail = {
	result: "Whether the change took effect is unknown.",
	completion: "The modem did not answer in time.",
	unknownReason: "The change was sent and no reply came back.",
	reconciliation: "This modem is held until an earlier change is confirmed.",
};

const RETRYABLE_DETAIL: MutationOutcomeDetail = {
	result: "The change was refused.",
	completion: "The request ran on the modem and failed.",
	retry: "This can clear on its own — try again in a moment.",
};

describe("MutationOutcomeBand — the classified detail", () => {
	it("Given no detail, When rendered, Then the band is byte-identical to before", () => {
		const { getByTestId, queryByTestId } = mount({
			kind: "refused",
			message: "The modem refused.",
		});
		expect(getByTestId(`${NAME}-outcome`).textContent).toContain(
			"The modem refused.",
		);
		expect(queryByTestId(`${NAME}-outcome-result`)).toBeNull();
		expect(queryByTestId(`${NAME}-outcome-completion`)).toBeNull();
		expect(queryByTestId(`${NAME}-outcome-retry`)).toBeNull();
		expect(queryByTestId(`${NAME}-outcome-reconciliation`)).toBeNull();
	});

	it("Given an unknown outcome, When rendered, Then it claims neither success nor failure and points at reconciliation", () => {
		const { getByTestId, queryByTestId } = mount(
			{ kind: "unknown", message: "The switch could not be confirmed." },
			UNKNOWN_DETAIL,
		);
		const band = getByTestId(`${NAME}-outcome`);

		expect(band.getAttribute("data-outcome")).toBe("unknown");
		expect(getByTestId(`${NAME}-outcome-result`).textContent).toContain(
			UNKNOWN_DETAIL.result,
		);
		expect(getByTestId(`${NAME}-outcome-unknown-reason`).textContent).toContain(
			UNKNOWN_DETAIL.unknownReason as string,
		);
		expect(getByTestId(`${NAME}-outcome-reconciliation`).textContent).toContain(
			UNKNOWN_DETAIL.reconciliation as string,
		);
		// The safety rule, on the surface that enforces it.
		expect(queryByTestId(`${NAME}-outcome-retry`)).toBeNull();
	});

	it("Given an unknown outcome, When announced, Then it interrupts and carries the reconciliation pointer", () => {
		const { getByTestId } = mount(
			{ kind: "unknown", message: "The switch could not be confirmed." },
			UNKNOWN_DETAIL,
		);
		const assertive = getByTestId(`${NAME}-announce-assertive`);
		const polite = getByTestId(`${NAME}-announce-polite`);

		expect(assertive.textContent).toContain(
			"The switch could not be confirmed.",
		);
		expect(assertive.textContent).toContain(
			UNKNOWN_DETAIL.reconciliation as string,
		);
		// Exactly once: the polite region must not repeat it.
		expect(polite.textContent).toBe("");
	});

	it("Given a retryable refusal, When rendered, Then the retry hint is on screen and no reconciliation pointer is", () => {
		const { getByTestId, queryByTestId } = mount(
			{ kind: "refused", message: "The modem is busy." },
			RETRYABLE_DETAIL,
		);
		expect(getByTestId(`${NAME}-outcome-retry`).textContent).toContain(
			RETRYABLE_DETAIL.retry as string,
		);
		expect(getByTestId(`${NAME}-outcome-completion`).textContent).toContain(
			RETRYABLE_DETAIL.completion as string,
		);
		expect(queryByTestId(`${NAME}-outcome-reconciliation`)).toBeNull();
	});

	it("Given a success, When rendered, Then it announces politely and shows only what the result adds", () => {
		const { getByTestId, queryByTestId } = mount(
			{ kind: "applied", message: "FCC auto-unlock is on." },
			{ result: "The change is in force." },
		);
		expect(getByTestId(`${NAME}-outcome`).getAttribute("data-outcome")).toBe(
			"applied",
		);
		expect(getByTestId(`${NAME}-announce-polite`).textContent).toContain(
			"The change is in force.",
		);
		expect(getByTestId(`${NAME}-announce-assertive`).textContent).toBe("");
		expect(queryByTestId(`${NAME}-outcome-completion`)).toBeNull();
	});

	it("Given no outcome at all, When rendered, Then both live regions still exist and are empty", () => {
		const { getByTestId, queryByTestId } = mount(undefined, UNKNOWN_DETAIL);
		expect(getByTestId(`${NAME}-announce-polite`).textContent).toBe("");
		expect(getByTestId(`${NAME}-announce-assertive`).textContent).toBe("");
		// The detail must not render on its own — it describes an outcome, and
		// there is none.
		expect(queryByTestId(`${NAME}-outcome`)).toBeNull();
		expect(queryByTestId(`${NAME}-outcome-result`)).toBeNull();
	});
});
