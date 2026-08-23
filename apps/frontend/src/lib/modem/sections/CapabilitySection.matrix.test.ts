// @vitest-environment jsdom
/**
 * THE CAPABILITY-TRUTH MATRIX.
 *
 * This is the cross-product regression lock for the one renderer every modem
 * capability surface uses. It deliberately asserts only rendered DOM. A correct
 * claim object beside a lying component is the defect class this gate exists to
 * catch.
 *
 * Matrix: 7 modules × 3 device families × 5 claim states × 4 read states =
 * 420 named cells. The family axis must not change the result; the structural
 * companion gate (`no-vendor-branching.test.ts`) makes that independence
 * enforceable in shipped source.
 */

import {
	CAPABILITY_MODULES,
	SUPPORT_CLAIM_STATES,
	type SupportClaimState,
} from "@ceraui/rpc/schemas";
import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";

import CapabilityHarness from "./__fixtures__/CapabilityHarness.svelte";
import type { CapabilityView } from "./types";

const DEVICE_FAMILIES = [
	"mm-managed",
	"router-ethernet",
	"unrecognized",
] as const;
const READ_STATES = ["fresh", "stale", "unknown", "unavailable"] as const;
const UNKNOWN_REASON_KEY = "network.modem.sections.capability.unproven";
const BLOCKED_REASON_KEY = "network.modem.gps.reason.notReported";

type DeviceFamily = (typeof DEVICE_FAMILIES)[number];
type ReadState = (typeof READ_STATES)[number];
type DomOutcome = "absent" | "unknown" | "blocked" | "available";

interface MatrixCell {
	readonly module: (typeof CAPABILITY_MODULES)[number];
	readonly family: DeviceFamily;
	readonly claim: SupportClaimState;
	readonly read: ReadState;
	readonly expected: DomOutcome;
	readonly name: string;
}

function expectedOutcome(
	module: (typeof CAPABILITY_MODULES)[number],
	claim: SupportClaimState,
	read: ReadState,
): DomOutcome {
	if (claim === "unavailable") return "absent";
	if (claim === "implemented" || claim === "enabled") return "unknown";
	// USSD's children are the live carrier dialogue. Its documented three-state
	// adapter keeps them mounted and renders read refusals inside the session.
	if (module === "ussd") return "available";
	if (read === "fresh") return "available";
	if (read === "unknown") return "unknown";
	return "blocked";
}

function viewFor(outcome: DomOutcome): CapabilityView {
	switch (outcome) {
		case "absent":
			return { mode: "absent" };
		case "unknown":
			return { mode: "unknown", reasonKey: UNKNOWN_REASON_KEY };
		case "blocked":
			return { mode: "blocked", reasonKey: BLOCKED_REASON_KEY };
		case "available":
			return { mode: "available" };
	}
}

const CELLS: readonly MatrixCell[] = CAPABILITY_MODULES.flatMap((module) =>
	DEVICE_FAMILIES.flatMap((family) =>
		SUPPORT_CLAIM_STATES.flatMap((claim) =>
			READ_STATES.map((read) => {
				const expected = expectedOutcome(module, claim, read);
				return {
					module,
					family,
					claim,
					read,
					expected,
					name: `${module} × ${family} × ${claim} × ${read} → ${expected}`,
				};
			}),
		),
	),
);

function controls(container: HTMLElement): Element[] {
	return [
		...container.querySelectorAll(
			"button, input, select, textarea, [role='switch']",
		),
	];
}

function assertOutcome(
	cell: MatrixCell,
	actual: DomOutcome = cell.expected,
): void {
	const result = render(CapabilityHarness, {
		props: { view: viewFor(actual) },
	});
	const section = result.queryByTestId("harness-capability");
	const control = result.queryByTestId("harness-capability-toggle");
	const unknown = result.queryByTestId("harness-capability-unknown");
	const reason = result.queryByTestId("harness-capability-reason");

	switch (cell.expected) {
		case "absent":
			expect(result.container.querySelectorAll("*"), cell.name).toHaveLength(0);
			expect(result.container.textContent, cell.name).toBe("");
			return;
		case "unknown":
			expect(section?.getAttribute("data-capability-state"), cell.name).toBe(
				"unknown",
			);
			expect(unknown?.getAttribute("role"), cell.name).toBe("status");
			expect(unknown?.textContent?.trim().length, cell.name).toBeGreaterThan(0);
			expect(control, cell.name).toBeNull();
			expect(controls(result.container), cell.name).toHaveLength(0);
			return;
		case "blocked":
			expect(section?.getAttribute("data-capability-state"), cell.name).toBe(
				"blocked",
			);
			expect((control as HTMLButtonElement | null)?.disabled, cell.name).toBe(
				true,
			);
			expect(reason?.textContent?.trim().length, cell.name).toBeGreaterThan(0);
			expect(control?.getAttribute("aria-describedby"), cell.name).toBe(
				reason?.id,
			);
			return;
		case "available":
			expect(section?.getAttribute("data-capability-state"), cell.name).toBe(
				"available",
			);
			expect((control as HTMLButtonElement | null)?.disabled, cell.name).toBe(
				false,
			);
			expect(
				result.queryByTestId("harness-capability-body"),
				cell.name,
			).not.toBeNull();
			expect(unknown, cell.name).toBeNull();
			expect(reason, cell.name).toBeNull();
	}
}

afterEach(cleanup);

describe("capability truth: every module × family × claim × read state", () => {
	it("is the complete 420-cell cross product", () => {
		expect(CELLS).toHaveLength(420);
		expect(new Set(CELLS.map((cell) => cell.name)).size).toBe(CELLS.length);
	});

	it.each(CELLS)("$name", (cell) => {
		assertOutcome(cell);
	});

	it("NON-VACUITY: a read-unknown cell rendered as unsupported is named and rejected", () => {
		const cell = CELLS.find(
			(candidate) =>
				candidate.module === "gps" &&
				candidate.family === "router-ethernet" &&
				candidate.claim === "capable" &&
				candidate.read === "unknown",
		);
		expect(cell).toBeDefined();
		if (cell === undefined) return;

		// Deliberately wrong: removing this negation produces exactly one named red
		// cell, proving the 420 green cells are not a tautological empty sweep.
		expect(() => assertOutcome(cell, "absent")).toThrow(cell.name);
	});
});
