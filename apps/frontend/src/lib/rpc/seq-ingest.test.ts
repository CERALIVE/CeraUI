/**
 * Task 13 — per-type seq drop-stale ingestion gate.
 *
 * `subscriptions.svelte.ts` cannot be imported under the node vitest env (its
 * runes throw outside a Svelte component), so these tests model the exact gate
 * `handleMessage` wires around the pure {@link createSeqTracker}:
 *
 *   if (seq !== undefined && tracker.shouldDrop(type, seq)) return;  // drop
 *   apply();                                                         // apply once
 *   if (seq !== undefined) tracker.advance(type, seq);               // advance
 *
 * plus `tracker.resetOnReconnect()` on the reconnect edge. The assertions cover
 * the two behaviours the task requires: a duplicate seq applies exactly once,
 * and a post-reconnect low seq is accepted.
 */
import { describe, expect, it } from "vitest";

import { createSeqTracker, type SeqTracker } from "./seq-guard";

/** Mirror of the handleMessage ingestion gate; records each applied frame. */
function makeIngest(
	tracker: SeqTracker,
	applied: Array<[string, number | undefined]>,
) {
	return (type: string, seq?: number): boolean => {
		if (seq !== undefined && tracker.shouldDrop(type, seq)) {
			return false;
		}
		applied.push([type, seq]);
		if (seq !== undefined) {
			tracker.advance(type, seq);
		}
		return true;
	};
}

describe("seq drop-stale ingestion gate (Task 13)", () => {
	it("applies a duplicate seq exactly once", () => {
		const tracker = createSeqTracker();
		const applied: Array<[string, number | undefined]> = [];
		const ingest = makeIngest(tracker, applied);

		expect(ingest("status", 5)).toBe(true);
		expect(ingest("status", 5)).toBe(false);
		expect(ingest("status", 5)).toBe(false);

		expect(applied).toEqual([["status", 5]]);
	});

	it("drops out-of-order frames but accepts newer ones (gaps allowed)", () => {
		const tracker = createSeqTracker();
		const applied: Array<[string, number | undefined]> = [];
		const ingest = makeIngest(tracker, applied);

		expect(ingest("status", 10)).toBe(true);
		expect(ingest("status", 9)).toBe(false);
		expect(ingest("status", 15)).toBe(true);

		expect(applied).toEqual([
			["status", 10],
			["status", 15],
		]);
	});

	it("accepts a low seq after reconnect reset (restarted server)", () => {
		const tracker = createSeqTracker();
		const applied: Array<[string, number | undefined]> = [];
		const ingest = makeIngest(tracker, applied);

		expect(ingest("status", 99)).toBe(true);
		expect(ingest("status", 1)).toBe(false);

		tracker.resetOnReconnect();

		expect(ingest("status", 1)).toBe(true);

		expect(applied).toEqual([
			["status", 99],
			["status", 1],
		]);
	});

	it("lets messages without seq bypass the guard", () => {
		const tracker = createSeqTracker();
		const applied: Array<[string, number | undefined]> = [];
		const ingest = makeIngest(tracker, applied);

		tracker.advance("config", 50);

		expect(ingest("config", undefined)).toBe(true);
		expect(ingest("config", undefined)).toBe(true);
		expect(ingest("config", 40)).toBe(false);

		expect(applied).toEqual([
			["config", undefined],
			["config", undefined],
		]);
	});

	it("keeps per-type sequences independent during ingestion", () => {
		const tracker = createSeqTracker();
		const applied: Array<[string, number | undefined]> = [];
		const ingest = makeIngest(tracker, applied);

		expect(ingest("config", 7)).toBe(true);
		expect(ingest("netif", 2)).toBe(true);
		expect(ingest("config", 7)).toBe(false);
		expect(ingest("netif", 3)).toBe(true);

		expect(applied).toEqual([
			["config", 7],
			["netif", 2],
			["netif", 3],
		]);
	});
});
