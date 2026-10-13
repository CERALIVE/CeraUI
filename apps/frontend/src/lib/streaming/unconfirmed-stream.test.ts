import { LIFECYCLE_STATES } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	showUnconfirmedStreamStop,
	startOptimismSuperseded,
	stopConfirmedByDevice,
	streamStateUnconfirmed,
	UNCONFIRMED_STOP_OPERATION,
	UNCONFIRMED_STREAM_LIFECYCLES,
} from "./unconfirmed-stream";

// The six cells that MUST offer the band, written out by hand. Every other
// combination of lifecycle x is_streaming x optimism must not. Local optimism
// never hides it: the optimistic live cockpit's control is a DISABLED
// "Starting...", not a Stop (FIX-16-C3 moved the two `|false|starting` cells
// here; C2 had encoded the opposite assumption).
const SHOWN = new Set([
	"reconciling|false|idle",
	"reconciling|false|starting",
	"reconciling|false|stopping",
	"stop_failed|false|idle",
	"stop_failed|false|starting",
	"stop_failed|false|stopping",
]);

const LIFECYCLES = [...LIFECYCLE_STATES, undefined] as const;
const STREAMING = [false, true] as const;
const OPTIMISM = ["idle", "starting", "stopping"] as const;

describe("unconfirmed-stream predicate", () => {
	it("names exactly reconciling and stop_failed as the unconfirmed lifecycles", () => {
		expect([...UNCONFIRMED_STREAM_LIFECYCLES].sort()).toEqual([
			"reconciling",
			"stop_failed",
		]);
		expect(UNCONFIRMED_STOP_OPERATION).toBe("stream-stop-unconfirmed");
	});

	it("covers every lifecycle the wire can carry (the matrix below is complete)", () => {
		expect([...LIFECYCLE_STATES].sort()).toEqual([
			"idle",
			"reconciling",
			"reconfiguring",
			"starting",
			"stop_failed",
			"stopping",
			"streaming",
		]);
	});

	for (const lifecycle of LIFECYCLES) {
		for (const isStreaming of STREAMING) {
			for (const optimismState of OPTIMISM) {
				const cell = `${lifecycle}|${isStreaming}|${optimismState}`;
				const expected = SHOWN.has(cell);
				it(`${cell} -> ${expected ? "band" : "no band"}`, () => {
					expect(
						showUnconfirmedStreamStop({
							lifecycle,
							isStreaming,
							optimismState,
						}),
					).toBe(expected);
				});
			}
		}
	}
});

describe("the band stays through the operator's own pending Stop", () => {
	// Hand-written: with its own Stop in flight, the band also covers the
	// backend's `stopping` (entered before the engine answers). Nothing else.
	const SHOWN_WHILE_PENDING = new Set([
		"reconciling|false",
		"stop_failed|false",
		"stopping|false",
	]);
	for (const lifecycle of LIFECYCLES) {
		for (const isStreaming of STREAMING) {
			const cell = `${lifecycle}|${isStreaming}`;
			const expected = SHOWN_WHILE_PENDING.has(cell);
			it(`${cell} with a pending Stop -> ${expected ? "band" : "no band"}`, () => {
				expect(
					showUnconfirmedStreamStop({
						lifecycle,
						isStreaming,
						optimismState: "idle",
						stopPending: true,
					}),
				).toBe(expected);
			});
		}
	}
});

describe("an unresolved operator Stop keeps the band until the device settles it", () => {
	// Hand-written (FIX-16-FRONT3 R2): a Stop whose outcome is UNKNOWN (failed,
	// timed out, reset) keeps its surface whatever the held lifecycle says, and
	// only `is_streaming` true (the live cockpit's own Stop) hides it.
	const SHOWN_WHILE_UNRESOLVED = new Set([
		"idle|false",
		"starting|false",
		"streaming|false",
		"stopping|false",
		"reconfiguring|false",
		"reconciling|false",
		"stop_failed|false",
		"undefined|false",
	]);
	for (const lifecycle of LIFECYCLES) {
		for (const isStreaming of STREAMING) {
			const cell = `${lifecycle}|${isStreaming}`;
			const expected = SHOWN_WHILE_UNRESOLVED.has(cell);
			it(`${cell} with an unresolved Stop -> ${expected ? "band" : "no band"}`, () => {
				expect(
					showUnconfirmedStreamStop({
						lifecycle,
						isStreaming,
						optimismState: "idle",
						stopUnresolved: true,
					}),
				).toBe(expected);
			});
		}
	}
});

describe("stopConfirmedByDevice — only the device's idle commit confirms a Stop", () => {
	for (const lifecycle of LIFECYCLES) {
		for (const isStreaming of STREAMING) {
			const expected = lifecycle === "idle" && isStreaming === false;
			it(`${lifecycle}|${isStreaming} -> ${expected ? "confirmed" : "not confirmed"}`, () => {
				expect(stopConfirmedByDevice({ lifecycle, isStreaming })).toBe(
					expected,
				);
			});
		}
	}
});

describe("streamStateUnconfirmed — the header's not-streaming claim is withheld", () => {
	const UNCONFIRMED = new Set(["reconciling|false", "stop_failed|false"]);
	for (const lifecycle of LIFECYCLES) {
		for (const isStreaming of STREAMING) {
			const cell = `${lifecycle}|${isStreaming}`;
			it(`${cell} -> ${UNCONFIRMED.has(cell)}`, () => {
				expect(streamStateUnconfirmed({ lifecycle, isStreaming })).toBe(
					UNCONFIRMED.has(cell),
				);
			});
		}
	}
});

describe("startOptimismSuperseded — device evidence outranks a local starting", () => {
	// Hand-written: the cells where a local `starting` must settle.
	const SETTLE = new Set([
		"reconciling|false|false",
		"reconciling|false|true",
		"stop_failed|false|false",
		"stop_failed|false|true",
		"idle|false|true",
	]);
	for (const lifecycle of LIFECYCLES) {
		for (const isStreaming of STREAMING) {
			for (const delivered of [false, true]) {
				const cell = `${lifecycle}|${isStreaming}|${delivered}`;
				const expected = SETTLE.has(cell);
				it(`starting, ${cell} -> ${expected ? "settle" : "keep"}`, () => {
					expect(
						startOptimismSuperseded({
							optimismState: "starting",
							isStreaming,
							lifecycle,
							lifecycleSinceLostReply: delivered,
						}),
					).toBe(expected);
				});
			}
		}
	}

	it("never settles an idle or stopping optimism", () => {
		for (const optimismState of ["idle", "stopping"] as const) {
			expect(
				startOptimismSuperseded({
					optimismState,
					isStreaming: false,
					lifecycle: "reconciling",
					lifecycleSinceLostReply: true,
				}),
			).toBe(false);
		}
	});
});
