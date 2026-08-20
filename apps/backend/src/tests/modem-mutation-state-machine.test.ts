/**
 * The modem-mutation journal state machine, exhaustively.
 *
 * The machine is a data table, so this suite enumerates the WHOLE cross product
 * of states rather than sampling it: every legal transition is asserted legal and
 * every one of the remaining pairs is asserted illegal. A safety machine whose
 * illegal transitions are untested is a machine whose illegal transitions are
 * reachable.
 */
import { describe, expect, test } from "bun:test";

import {
	type ModemMutationState,
	modemMutationStateSchema,
} from "@ceraui/rpc/schemas";

import {
	blocksMutations,
	blocksStreaming,
	isArchivable,
	isLegalMutationTransition,
	legalMutationTransitions,
	presenceRecheckTarget,
	replayActionFor,
} from "../modules/modems/mutation-journal-state.ts";

const ALL_STATES =
	modemMutationStateSchema.options as readonly ModemMutationState[];

const LEGAL: ReadonlyArray<readonly [ModemMutationState, ModemMutationState]> =
	[
		["armed", "executing"],
		["armed", "completed"],
		["armed", "failed"],
		["armed", "device-absent-quarantine"],
		["executing", "completed"],
		["executing", "failed"],
		["executing", "device-absent-quarantine"],
		["failed", "acknowledged"],
		["failed", "device-absent-quarantine"],
		["device-absent-quarantine", "failed"],
		["device-absent-quarantine", "decommissioned"],
		["decommissioned", "recommission-pending"],
		["recommission-pending", "acknowledged"],
	];

describe("modem mutation state machine — transitions", () => {
	test("every declared legal transition is accepted", () => {
		for (const [from, to] of LEGAL) {
			expect(isLegalMutationTransition(from, to)).toBe(true);
		}
	});

	test("EVERY other pair in the full cross product is refused", () => {
		const legal = new Set(LEGAL.map(([from, to]) => `${from}->${to}`));
		const refused: string[] = [];
		for (const from of ALL_STATES) {
			for (const to of ALL_STATES) {
				const key = `${from}->${to}`;
				if (legal.has(key)) continue;
				if (isLegalMutationTransition(from, to)) refused.push(key);
			}
		}
		expect(refused).toEqual([]);
	});

	test("a completed or acknowledged entry has nowhere left to go", () => {
		expect(legalMutationTransitions("completed")).toEqual([]);
		expect(legalMutationTransitions("acknowledged")).toEqual([]);
	});

	test("decommissioned is NOT terminal — a port-keyed identity can be re-occupied", () => {
		expect(legalMutationTransitions("decommissioned")).toEqual([
			"recommission-pending",
		]);
	});
});

describe("modem mutation state machine — blocking", () => {
	test("mutation blocking covers every non-archivable state", () => {
		const blocking = ALL_STATES.filter(blocksMutations);
		expect(blocking.sort()).toEqual(
			[
				"armed",
				"device-absent-quarantine",
				"decommissioned",
				"executing",
				"failed",
				"recommission-pending",
			].sort(),
		);
	});

	test("streaming blocking is a STRICT subset — a decommission releases it", () => {
		const streamBlocking = ALL_STATES.filter(blocksStreaming);
		expect(streamBlocking.sort()).toEqual(
			["armed", "device-absent-quarantine", "executing", "failed"].sort(),
		);
		for (const state of streamBlocking)
			expect(blocksMutations(state)).toBe(true);

		// The whole point of a decommission: a destroyed modem stays unmutatable
		// while the REMAINING links are freed to stream.
		expect(blocksMutations("decommissioned")).toBe(true);
		expect(blocksStreaming("decommissioned")).toBe(false);
		expect(blocksMutations("recommission-pending")).toBe(true);
		expect(blocksStreaming("recommission-pending")).toBe(false);
	});

	test("only completed and acknowledged entries are archived", () => {
		expect(ALL_STATES.filter(isArchivable).sort()).toEqual([
			"acknowledged",
			"completed",
		]);
	});
});

describe("modem mutation state machine — replay table", () => {
	test("every state has an action, and the table matches the contract", () => {
		expect(
			Object.fromEntries(ALL_STATES.map((s) => [s, replayActionFor(s)])),
		).toEqual({
			armed: "rollback",
			executing: "rollback",
			completed: "prune",
			failed: "remain-blocked",
			acknowledged: "resume-archive",
			"device-absent-quarantine": "recheck-presence",
			decommissioned: "recheck-presence",
			"recommission-pending": "remain-blocked",
		});
	});

	test("a returning quarantined device resumes ORDINARY fail-closed handling", () => {
		expect(presenceRecheckTarget("device-absent-quarantine", true)).toBe(
			"failed",
		);
		expect(
			presenceRecheckTarget("device-absent-quarantine", false),
		).toBeUndefined();
	});

	test("a device at a decommissioned identity needs an explicit rebaseline", () => {
		expect(presenceRecheckTarget("decommissioned", true)).toBe(
			"recommission-pending",
		);
		expect(presenceRecheckTarget("decommissioned", false)).toBeUndefined();
	});

	test("presence recheck answers nothing for states it does not govern", () => {
		for (const state of ALL_STATES) {
			if (state === "device-absent-quarantine" || state === "decommissioned") {
				continue;
			}
			expect(presenceRecheckTarget(state, true)).toBeUndefined();
			expect(presenceRecheckTarget(state, false)).toBeUndefined();
		}
	});

	test("every replay action the table names transitions LEGALLY", () => {
		expect(
			isLegalMutationTransition("device-absent-quarantine", "failed"),
		).toBe(true);
		expect(
			isLegalMutationTransition("decommissioned", "recommission-pending"),
		).toBe(true);
		// A rollback that cannot restore transitions armed/executing → failed.
		expect(isLegalMutationTransition("armed", "failed")).toBe(true);
		expect(isLegalMutationTransition("executing", "failed")).toBe(true);
	});
});
