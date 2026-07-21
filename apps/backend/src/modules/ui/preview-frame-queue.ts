/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * Bounded drop-oldest queue for the `/preview` proxy's slow-consumer buffering.
 *
 * When the downstream (browser) socket can't drain fast enough, held frames are
 * queued here. Rather than close the socket on overflow (the old behaviour), the
 * queue drops the OLDEST media frames once it exceeds either the frame-count or
 * the byte cap — so it plateaus under a permanently-slow consumer instead of
 * tearing the preview down, and the browser resumes at the freshest media (a
 * live-edge skip-on-lag, paired with the frontend's live-edge seek policy).
 *
 * A single PINNED frame (the newest MSE codec-config / init segment) is retained
 * separately: it is never dropped and is dequeued FIRST, so the latest fragments
 * stay decodable after any eviction. Pure and side-effect-free so the policy is
 * unit-testable in isolation (`preview-frame-queue.test.ts`).
 */

export interface BoundedDropOldestQueueOptions<T> {
	/** Hard cap on queued MEDIA frames (the pinned init frame does not count). */
	maxItems: number;
	/** Hard cap on queued MEDIA bytes (the pinned init frame does not count). */
	maxBytes: number;
	/** Byte size of one frame — used for the byte budget. */
	sizeOf: (item: T) => number;
	/**
	 * Classify a frame as the pinned init frame (kept, never dropped, sent first).
	 * When omitted, no frame is pinned and every frame is droppable media.
	 */
	isPinned?: (item: T) => boolean;
}

/** How many oldest media frames/bytes an `enqueue` evicted (0 when under cap). */
export interface EnqueueResult {
	droppedItems: number;
	droppedBytes: number;
}

export class BoundedDropOldestQueue<T> {
	private readonly maxItems: number;
	private readonly maxBytes: number;
	private readonly sizeOf: (item: T) => number;
	private readonly isPinned: (item: T) => boolean;

	private media: T[] = [];
	private mediaBytes = 0;
	private pinned: T | null = null;
	private pinnedPending = false;

	constructor(options: BoundedDropOldestQueueOptions<T>) {
		this.maxItems = options.maxItems;
		this.maxBytes = options.maxBytes;
		this.sizeOf = options.sizeOf;
		this.isPinned = options.isPinned ?? (() => false);
	}

	/**
	 * Enqueue a frame. A pinned (init) frame replaces any older pinned frame and
	 * is never dropped. A media frame is appended, then the oldest media frames are
	 * evicted while the queue exceeds the frame-count OR byte cap — always keeping
	 * at least the just-enqueued newest frame.
	 */
	enqueue(item: T): EnqueueResult {
		if (this.isPinned(item)) {
			this.pinned = item;
			this.pinnedPending = true;
			return { droppedItems: 0, droppedBytes: 0 };
		}

		this.media.push(item);
		this.mediaBytes += this.sizeOf(item);

		let droppedItems = 0;
		let droppedBytes = 0;
		while (
			(this.media.length > this.maxItems || this.mediaBytes > this.maxBytes) &&
			this.media.length > 1
		) {
			const evicted = this.media.shift();
			if (evicted === undefined) {
				break;
			}
			this.mediaBytes -= this.sizeOf(evicted);
			droppedItems += 1;
			droppedBytes += this.sizeOf(evicted);
		}
		return { droppedItems, droppedBytes };
	}

	/**
	 * Dequeue the next frame to forward: the pending pinned init frame first (once),
	 * then the oldest media frame. Returns `undefined` when empty.
	 */
	dequeue(): T | undefined {
		if (this.pinnedPending && this.pinned !== null) {
			this.pinnedPending = false;
			return this.pinned;
		}
		const next = this.media.shift();
		if (next !== undefined) {
			this.mediaBytes -= this.sizeOf(next);
		}
		return next;
	}

	/** Total queued frames, including a pending pinned init frame. */
	get length(): number {
		return this.media.length + (this.pinnedPending ? 1 : 0);
	}

	/** Total queued bytes, including a pending pinned init frame. */
	get byteLength(): number {
		return (
			this.mediaBytes +
			(this.pinnedPending && this.pinned !== null
				? this.sizeOf(this.pinned)
				: 0)
		);
	}

	/** Test/introspection: the queued frames in dequeue order (pinned first). */
	peekAll(): T[] {
		const out: T[] = [];
		if (this.pinnedPending && this.pinned !== null) {
			out.push(this.pinned);
		}
		out.push(...this.media);
		return out;
	}

	/** Free every buffered frame and byte (teardown). */
	clear(): void {
		this.media = [];
		this.mediaBytes = 0;
		this.pinned = null;
		this.pinnedPending = false;
	}
}
