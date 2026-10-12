/**
 * EXHAUSTIVE interleavings of the Updates dialog's action/outcome machine.
 *
 * Every sequence of up to BOUND events from the alphabet below is applied to a
 * reference world (`tests/helpers/update-action-world.ts`) that drives the
 * PRODUCTION machine and binder step and keeps its own ground truth. After
 * every event the machine's bands and busy state must match that truth:
 *
 *   U1 "Not started" only for a positive pre-dispatch refusal, never for a
 *      request the device started;
 *   U2 an unconfirmed outcome clears once ANY later evidence settles it,
 *      including a read made because a session was restored on the same phase;
 *   U3 nothing from a closed dialog's session reaches the reopened one;
 *   U4 a dropped duplicate dispatch changes nothing;
 *   U5 busy lasts exactly as long as the request is awaited;
 *   U6 an uncertain outcome nothing has settled is shown as unconfirmed.
 *
 * Deterministic: no timers, no I/O, no randomness.
 */
import { describe, expect, it } from "vitest";
import {
	initialWorld,
	type World,
	type WorldAction,
	type WorldCall,
} from "../../tests/helpers/update-action-world";
import {
	applicable,
	step,
	WORLD_EVENTS,
	type WorldEvent,
} from "../../tests/helpers/update-action-world-events";
import { actionBands, isBusy, reduceActions } from "./update-action-outcome";

const BOUND = 8;

interface ExpectedBand {
	readonly state: "refused" | "unconfirmed";
	readonly cause?: "lost" | "error";
}

function bandOwner(w: World): WorldCall | undefined {
	return w.calls.findLast((call) => call.session === w.session);
}

function expectedBand(w: World): ExpectedBand | undefined {
	const owner = bandOwner(w);
	if (owner === undefined) return undefined;
	switch (owner.verdict) {
		case "pending":
		case "accepted":
			return undefined;
		case "refused":
			return { state: "refused" };
		case "uncertain-lost":
			return owner.evidence
				? undefined
				: { state: "unconfirmed", cause: "lost" };
		case "uncertain-error":
			return owner.evidence
				? undefined
				: { state: "unconfirmed", cause: "error" };
		default: {
			const unreachable: never = owner.verdict;
			return unreachable;
		}
	}
}

/** The violated invariant, or `undefined` when the world is consistent. */
function violation(w: World): string | undefined {
	const bands = actionBands(w.machine);
	if (bands.length > 1) return "two bands for one action";
	const band = bands[0];
	const call = w.calls.find((entry) => entry.id === band?.call);
	if (band !== undefined && call?.session !== w.session)
		return "U3 a band from another session";
	const expected = expectedBand(w);
	const actual =
		band === undefined
			? undefined
			: band.state === "refused"
				? { state: band.state }
				: { state: band.state, cause: band.cause };
	if (JSON.stringify(actual) !== JSON.stringify(expected))
		return `U1/U2/U6 band ${JSON.stringify(actual)} != truth ${JSON.stringify(expected)}`;
	if (band?.state === "refused" && call?.started === true)
		return "U1 'Not started' for a request the device started";
	const awaited = w.calls.some((entry) => entry.transport === "flight");
	if (isBusy(w.machine, w.action) !== awaited)
		return `U5 busy ${!awaited} while awaited is ${awaited}`;
	return undefined;
}

function duplicateViolation(w: World): string | undefined {
	const untouched = reduceActions(w.machine, {
		type: "dispatch",
		action: w.action,
		call: 10_000,
		context: { afterRead: w.seq, clocks: undefined, staged: undefined },
	});
	return untouched === w.machine
		? undefined
		: "U4 a duplicate changed the machine";
}

interface Exploration {
	readonly sequences: number;
	readonly fullLength: number;
	readonly failures: readonly string[];
}

function explore(action: WorldAction): Exploration {
	let sequences = 0;
	let fullLength = 0;
	const failures: string[] = [];
	const path: WorldEvent[] = [];
	const visit = (w: World): void => {
		for (const event of WORLD_EVENTS) {
			if (!applicable(w, event)) continue;
			path.push(event);
			sequences += 1;
			const next = step(w, event);
			const found =
				(event === "duplicate" ? duplicateViolation(w) : undefined) ??
				violation(next);
			if (found !== undefined && failures.length < 5)
				failures.push(`${found} after [${path.join(", ")}]`);
			if (path.length === BOUND) fullLength += 1;
			else if (next !== w) visit(next);
			path.pop();
		}
	};
	visit(initialWorld(action));
	return { sequences, fullLength, failures };
}

function run(action: WorldAction, events: readonly WorldEvent[]): World {
	return events.reduce((world, event) => {
		if (!applicable(world, event))
			throw new Error(`${event} is not applicable`);
		return step(world, event);
	}, initialWorld(action));
}

describe("the reviewer's sequences are paths of the world", () => {
	it("M1: an internal error after the device showed the image staged leaves no band", () => {
		// Given an install the device stages, which a fresh read then shows.
		// When the awaited request finally fails with an internal error.
		const world = run("install", [
			"dispatch",
			"device-starts",
			"read-oldest",
			"internal",
		]);

		// Then no band claims anything, least of all "Not started".
		expect(actionBands(world.machine)).toEqual([]);
		expect(violation(world)).toBeUndefined();
	});

	it("M2: a check hidden by an outage is settled by the restored session's read", () => {
		// Given a check whose link drops, and which the device runs while away.
		const away = run("check", ["dispatch", "drop-link", "device-starts"]);
		expect(actionBands(away.machine)[0]?.state).toBe("unconfirmed");

		// When the link returns on the same phase and the reread lands.
		const back = run("check", [
			"dispatch",
			"drop-link",
			"device-starts",
			"reconnect",
			"read-oldest",
		]);

		// Then the uncertainty is gone.
		expect(actionBands(back.machine)).toEqual([]);
		expect(violation(back)).toBeUndefined();
	});

	it("m1: a duplicate never takes the real request's watch", () => {
		// Given an install, a declined duplicate, then a lost reply.
		const world = run("install", ["dispatch", "duplicate", "timeout"]);

		// Then the lost reply is unconfirmed and nothing is busy.
		expect(actionBands(world.machine)[0]).toMatchObject({
			state: "unconfirmed",
			cause: "lost",
		});
		expect(isBusy(world.machine, "install")).toBe(false);
	});
});

/** The explored space, pinned: a shrinking alphabet must not pass silently. */
const SPACE = {
	check: { sequences: 1_686_842, fullLength: 1_434_585 },
	install: { sequences: 1_136_319, fullLength: 948_702 },
} as const;

describe.each(["check", "install"] as const)(
	"every interleaving of the %s action",
	(action) => {
		it(`holds U1–U6 up to ${BOUND} events`, () => {
			// Given every sequence of applicable events up to the bound.
			const result = explore(action);

			// Then no state reached violates an invariant…
			expect(result.failures).toEqual([]);
			// …and the whole space was explored.
			expect({
				sequences: result.sequences,
				fullLength: result.fullLength,
			}).toEqual(SPACE[action]);
		});
	},
);
