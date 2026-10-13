import { LIFECYCLE_STATES } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	showUnconfirmedStreamStop,
	UNCONFIRMED_STOP_OPERATION,
	UNCONFIRMED_STREAM_LIFECYCLES,
} from "./unconfirmed-stream";

// The four cells that MUST offer the band, written out by hand. Every other
// combination of lifecycle x is_streaming x optimism must not.
const SHOWN = new Set([
	"reconciling|false|idle",
	"reconciling|false|stopping",
	"stop_failed|false|idle",
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
