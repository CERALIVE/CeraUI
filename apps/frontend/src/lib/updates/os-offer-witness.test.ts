/**
 * "No newer system image has been found" over EVERY sequence of up to BOUND
 * device and dialog events (round-3 review C, C3-2).
 *
 * The device below is a model of the producer's facts, not of the frontend:
 * an OS check that finds an image holds it (in memory, and in a stage-recovery
 * record that survives a restart); one that finds nothing clears both; a failed
 * check moves only the attempt clock; a package check moves the phase only; a
 * restart loses the memory-only candidate and drops the link. Every phase
 * change is pushed to the open dialog, as the device does. The oracle is
 * that ground truth: the sentence may be shown only while the device holds no
 * offer. Liveness: a check the dialog sees complete with nothing found, on one
 * link, IS shown.
 */
import type {
	UpdateDetails,
	UpdateOrchestratorPhase,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	NO_WITNESS,
	type OsCheckWitness,
	witnessedNothingNewer,
	witnessPhase,
	witnessRead,
} from "./os-offer-witness";
import { osCheckFoundNothing } from "./update-dialog-view";

const EVENTS = [
	"check-image",
	"check-nothing",
	"check-fail",
	"package-check",
	"restart",
	"read",
] as const;
type OfferEvent = (typeof EVENTS)[number];

const BOUND = 8;

interface Device {
	readonly now: number;
	readonly attemptAt: number | null;
	readonly successAt: number | null;
	/** Memory-only: lost by a restart. */
	readonly candidate: boolean;
	/** Ground truth: an offer is held (memory or a stage-recovery record). */
	readonly offerHeld: boolean;
	readonly phase: UpdateOrchestratorPhase;
	readonly link: number;
}

interface State {
	readonly device: Device;
	readonly witness: OsCheckWitness;
	readonly details: UpdateDetails | undefined;
}

const INITIAL: State = {
	device: {
		now: 1_000,
		attemptAt: null,
		successAt: null,
		candidate: false,
		offerHeld: false,
		phase: "idle",
		link: 0,
	},
	witness: NO_WITNESS,
	details: undefined,
};

function detailsOf(device: Device): UpdateDetails {
	const clock = {
		lastAttemptAt: device.attemptAt,
		lastSuccessAt: device.successAt,
		nextAttemptAt: null,
	};
	return {
		slots: null,
		os: {
			bootedVersion: "2026.10.70",
			staged: null,
			candidate: device.candidate
				? { version: "2026.10.76", sizeBytes: 1 }
				: null,
		},
		checks: { packages: clock, os: clock },
		pendingCellular: null,
		transport: null,
	};
}

/** The device moves; a changed phase is pushed to the dialog. */
function step(state: State, event: OfferEvent): State {
	const next = deviceStep(state, event);
	return next.device.phase === state.device.phase
		? next
		: { ...next, witness: witnessPhase(next.witness, next.device.phase) };
}

function deviceStep(state: State, event: OfferEvent): State {
	const d = state.device;
	const now = d.now + 1_000;
	switch (event) {
		case "check-image":
			return {
				...state,
				device: {
					...d,
					now,
					attemptAt: now,
					successAt: now,
					candidate: true,
					offerHeld: true,
					phase: "os-available",
				},
			};
		case "check-nothing":
			return {
				...state,
				device: {
					...d,
					now,
					attemptAt: now,
					successAt: now,
					candidate: false,
					offerHeld: false,
					phase: "idle",
				},
			};
		case "check-fail":
			return { ...state, device: { ...d, now, attemptAt: now, phase: "idle" } };
		case "package-check":
			return { ...state, device: { ...d, now, phase: "available" } };
		case "restart":
			return {
				...state,
				device: { ...d, now, candidate: false, link: d.link + 1 },
			};
		case "read": {
			const details = detailsOf(d);
			return {
				...state,
				details,
				witness: witnessRead(state.witness, d.link, details),
			};
		}
		default: {
			const unreachable: never = event;
			return unreachable;
		}
	}
}

function shown(state: State): boolean {
	return (
		witnessedNothingNewer(state.witness, state.device.link, state.details) &&
		osCheckFoundNothing(state.details, state.device.phase)
	);
}

function run(events: readonly OfferEvent[]): State {
	return events.reduce(step, INITIAL);
}

describe("'No newer system image' over every sequence", () => {
	it(`is shown only while the device holds no offer, up to ${BOUND} events`, () => {
		// Given every sequence of device and dialog events up to the bound.
		let sequences = 0;
		const failures: string[] = [];
		const path: OfferEvent[] = [];
		const visit = (state: State): void => {
			for (const event of EVENTS) {
				path.push(event);
				sequences += 1;
				const next = step(state, event);
				// Then the sentence never contradicts the device's ground truth.
				if (shown(next) && next.device.offerHeld && failures.length < 3)
					failures.push(path.join(", "));
				if (path.length < BOUND) visit(next);
				path.pop();
			}
		};
		visit(INITIAL);

		expect(failures).toEqual([]);
		let total = 0;
		for (let length = 1; length <= BOUND; length += 1)
			total += EVENTS.length ** length;
		expect(sequences).toBe(total);
	});
});

describe("the reviewer's sequence and the liveness cases", () => {
	it("package phase + lost candidate memory is not 'no newer image'", () => {
		// Given an OS check that found an image, read, then a package phase.
		const state = run([
			"check-image",
			"read",
			"package-check",
			"restart",
			"read",
		]);

		// Then after the restart the empty candidate proves nothing.
		expect(state.details?.os.candidate).toBeNull();
		expect(state.device.offerHeld).toBe(true);
		expect(shown(state)).toBe(false);
	});

	it("a check seen completing with nothing found, on one link, is shown", () => {
		const state = run(["read", "check-nothing", "read"]);
		expect(shown(state)).toBe(true);
	});

	it("a check that completed before the dialog first read is not", () => {
		const state = run(["check-nothing", "read"]);
		expect(shown(state)).toBe(false);
	});

	it("an image found after the witnessed check withdraws it before the next read", () => {
		// The matrix's own counterexample: the dialog's details are stale until
		// the read the pushed phase triggers lands.
		const state = run([
			"read",
			"check-nothing",
			"read",
			"check-image",
			"check-fail",
		]);
		expect(state.device.offerHeld).toBe(true);
		expect(shown(state)).toBe(false);
	});

	it("it survives a later package phase on the same link", () => {
		const state = run([
			"read",
			"check-nothing",
			"read",
			"package-check",
			"read",
		]);
		expect(shown(state)).toBe(true);
	});
});
