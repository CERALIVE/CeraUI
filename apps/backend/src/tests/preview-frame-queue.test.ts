/*
 * Todo 14 (CeraUI half) — bounded drop-oldest preview-frame queue.
 *
 * The pure queue behind the `/preview` proxy's slow-consumer buffering. It keeps
 * a PINNED init frame (the newest MSE codec-config) plus the LATEST media
 * fragments, dropping the oldest media when it exceeds either the frame-count or
 * the byte cap — never growing without bound, and never dropping the init frame
 * that keeps the fragments decodable.
 */
import { describe, expect, it } from "bun:test";

import { BoundedDropOldestQueue } from "../modules/ui/preview-frame-queue.ts";

const sizeOf = (): number => 1;

function newQueue(overrides?: {
	maxItems?: number;
	maxBytes?: number;
	isPinned?: (n: number) => boolean;
}) {
	return new BoundedDropOldestQueue<number>({
		maxItems: overrides?.maxItems ?? 3,
		maxBytes: overrides?.maxBytes ?? Number.POSITIVE_INFINITY,
		sizeOf,
		isPinned: overrides?.isPinned,
	});
}

describe("BoundedDropOldestQueue — drop-oldest by frame count", () => {
	it("keeps the newest N media frames, evicting the oldest", () => {
		const q = newQueue({ maxItems: 3 });
		expect(q.enqueue(1)).toEqual({ droppedItems: 0, droppedBytes: 0 });
		q.enqueue(2);
		q.enqueue(3);
		expect(q.length).toBe(3);
		// The 4th push evicts the oldest (1).
		expect(q.enqueue(4)).toEqual({ droppedItems: 1, droppedBytes: 1 });
		expect(q.peekAll()).toEqual([2, 3, 4]);
	});

	it("plateaus — 1000 enqueues never exceed the cap (bounded memory)", () => {
		const q = newQueue({ maxItems: 4 });
		for (let i = 0; i < 1000; i++) q.enqueue(i);
		expect(q.length).toBe(4);
		expect(q.byteLength).toBe(4);
		expect(q.peekAll()).toEqual([996, 997, 998, 999]);
	});
});

describe("BoundedDropOldestQueue — drop-oldest by byte budget", () => {
	it("evicts oldest until under the byte cap, keeping at least the newest frame", () => {
		const q = new BoundedDropOldestQueue<number>({
			maxItems: Number.POSITIVE_INFINITY,
			maxBytes: 10,
			sizeOf: (n) => n, // frame's byte size == its value
		});
		q.enqueue(4);
		q.enqueue(4);
		expect(q.byteLength).toBe(8);
		// +5 → 13 bytes > 10: evict oldest 4 → 9 bytes.
		expect(q.enqueue(5)).toEqual({ droppedItems: 1, droppedBytes: 4 });
		expect(q.byteLength).toBe(9);
		expect(q.peekAll()).toEqual([4, 5]);
	});

	it("keeps a single oversized frame rather than dropping to empty", () => {
		const q = new BoundedDropOldestQueue<number>({
			maxItems: Number.POSITIVE_INFINITY,
			maxBytes: 10,
			sizeOf: (n) => n,
		});
		expect(q.enqueue(50)).toEqual({ droppedItems: 0, droppedBytes: 0 });
		expect(q.length).toBe(1);
		expect(q.peekAll()).toEqual([50]);
	});
});

describe("BoundedDropOldestQueue — pinned init frame", () => {
	// Values >= 100 are "init" frames in this fixture.
	const isPinned = (n: number) => n >= 100;

	it("never drops the pinned init frame and dequeues it FIRST", () => {
		const q = newQueue({ maxItems: 2, isPinned });
		q.enqueue(100); // init
		q.enqueue(1);
		q.enqueue(2);
		q.enqueue(3); // evicts media 1, init untouched
		// init pending + 2 media = length 3 (init is pinned, not a media slot).
		expect(q.length).toBe(3);
		expect(q.dequeue()).toBe(100); // init first
		expect(q.dequeue()).toBe(2);
		expect(q.dequeue()).toBe(3);
		expect(q.dequeue()).toBeUndefined();
	});

	it("replaces an older pinned init with the newest one", () => {
		const q = newQueue({ maxItems: 3, isPinned });
		q.enqueue(100);
		q.enqueue(101); // newer init replaces 100
		q.enqueue(1);
		expect(q.dequeue()).toBe(101);
		expect(q.dequeue()).toBe(1);
	});

	it("re-arms the init send after a new init arrives post-dequeue", () => {
		const q = newQueue({ maxItems: 3, isPinned });
		q.enqueue(100);
		expect(q.dequeue()).toBe(100);
		q.enqueue(1);
		expect(q.dequeue()).toBe(1);
		// A fresh init (e.g. a source-change codec-config) must be sent again.
		q.enqueue(200);
		expect(q.dequeue()).toBe(200);
	});
});

describe("BoundedDropOldestQueue — never-drop control lane (WebRTC signaling)", () => {
	// Values in [500,600) are "control" frames (WebRTC signaling / preview-error).
	// A handshake frame must survive backpressure eviction — dropping an offer or
	// an ICE candidate breaks the WebRTC session (Todo 16, ADR-0006).
	const isControl = (n: number) => n >= 500 && n < 600;

	function controlQueue(maxItems: number) {
		return new BoundedDropOldestQueue<number>({
			maxItems,
			maxBytes: Number.POSITIVE_INFINITY,
			sizeOf,
			isControl,
		});
	}

	it("never evicts control frames under a media flood", () => {
		const q = controlQueue(3);
		q.enqueue(500); // webrtc-offer
		q.enqueue(501); // webrtc-ice
		q.enqueue(502); // webrtc-ice
		// A flood of media that would evict everything if these were media frames.
		for (let i = 0; i < 1000; i++) q.enqueue(i);
		const all = q.peekAll();
		expect(all).toContain(500);
		expect(all).toContain(501);
		expect(all).toContain(502);
	});

	it("preserves control-frame FIFO order and drains them FIRST", () => {
		const q = controlQueue(2);
		q.enqueue(1); // media
		q.enqueue(500); // offer
		q.enqueue(2); // media
		q.enqueue(501); // ice
		q.enqueue(3); // media
		// Control frames drain first, in the order they arrived.
		expect(q.dequeue()).toBe(500);
		expect(q.dequeue()).toBe(501);
		// Then the (bounded) media in order.
		expect(q.dequeue()).toBe(2);
		expect(q.dequeue()).toBe(3);
		expect(q.dequeue()).toBeUndefined();
	});

	it("counts control frames in length/byteLength and clear() frees them", () => {
		const q = controlQueue(4);
		q.enqueue(500);
		q.enqueue(501);
		expect(q.length).toBe(2);
		expect(q.byteLength).toBe(2);
		q.clear();
		expect(q.length).toBe(0);
		expect(q.byteLength).toBe(0);
		expect(q.peekAll()).toEqual([]);
	});

	it("coexists with a pinned init frame (control → pinned → media order)", () => {
		const q = new BoundedDropOldestQueue<number>({
			maxItems: 2,
			maxBytes: Number.POSITIVE_INFINITY,
			sizeOf,
			isPinned: (n) => n >= 100 && n < 200,
			isControl,
		});
		q.enqueue(100); // pinned init
		q.enqueue(500); // control
		q.enqueue(1); // media
		q.enqueue(2); // media
		q.enqueue(3); // media, evicts oldest media (1)
		expect(q.dequeue()).toBe(500); // control first
		expect(q.dequeue()).toBe(100); // then pinned init
		expect(q.dequeue()).toBe(2); // then bounded media
		expect(q.dequeue()).toBe(3);
		expect(q.dequeue()).toBeUndefined();
	});
});

describe("BoundedDropOldestQueue — teardown", () => {
	it("clear() frees all buffered bytes and frames", () => {
		const q = newQueue({ maxItems: 5, isPinned: (n) => n >= 100 });
		q.enqueue(100);
		q.enqueue(1);
		q.enqueue(2);
		expect(q.length).toBeGreaterThan(0);
		expect(q.byteLength).toBeGreaterThan(0);
		q.clear();
		expect(q.length).toBe(0);
		expect(q.byteLength).toBe(0);
		expect(q.peekAll()).toEqual([]);
		expect(q.dequeue()).toBeUndefined();
	});
});
