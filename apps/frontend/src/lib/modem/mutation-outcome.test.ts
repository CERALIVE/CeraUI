/**
 * The politeness rule, asserted once so no surface can re-derive it differently.
 *
 * §8 LR-2's clause is absolute — "nothing on these surfaces uses `assertive` for
 * a success" — and its counterpart matters just as much: an outcome the operator
 * cannot be told about must interrupt, because it is the one they have to act on.
 */
import { describe, expect, it } from "vitest";

import {
	type MutationOutcomeKind,
	mutationOutcome,
	outcomeBandRole,
	outcomeIsAssertive,
	outcomeTone,
} from "./mutation-outcome";

const KINDS: MutationOutcomeKind[] = ["applied", "refused", "unknown"];

describe("politeness follows the kind (LR-2)", () => {
	it("a success is polite", () => {
		expect(outcomeIsAssertive("applied")).toBe(false);
	});

	it("a refusal interrupts", () => {
		expect(outcomeIsAssertive("refused")).toBe(true);
	});

	// Grouped with `refused` deliberately: an operator who cannot be told whether
	// their change took effect needs to hear that at least as urgently.
	it("an unknown outcome interrupts too", () => {
		expect(outcomeIsAssertive("unknown")).toBe(true);
	});
});

describe("the visible band is never itself a live region (LR-3)", () => {
	it.each(KINDS)("%s carries no role of its own", (kind) => {
		expect(outcomeBandRole(kind)).toBeUndefined();
	});
});

describe("the three kinds are three tones — `unknown` borrows neither neighbour", () => {
	it("maps each kind to its own tone", () => {
		expect(outcomeTone("applied")).toBe("success");
		expect(outcomeTone("refused")).toBe("error");
		expect(outcomeTone("unknown")).toBe("warning");
	});

	it("no two kinds share a tone", () => {
		expect(new Set(KINDS.map(outcomeTone)).size).toBe(KINDS.length);
	});
});

describe("an outcome with no words is not an outcome", () => {
	it("builds one from a real sentence", () => {
		expect(mutationOutcome("applied", "It worked.")).toEqual({
			kind: "applied",
			message: "It worked.",
		});
	});

	// A band with no words is a coloured mark, and a state carried by a mark
	// alone is a state the operator cannot read.
	it.each(["", "   ", "\n\t"])("refuses the empty message %j", (message) => {
		expect(mutationOutcome("refused", message)).toBeUndefined();
	});
});
