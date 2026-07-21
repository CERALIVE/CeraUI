/*
 * Todo 14 (CeraUI half), part (e) — proxy bounded-memory + teardown.
 *
 * A slow-consumer fake (downstream `getBufferedAmount()` stays permanently above
 * the high-water mark) proves the paused proxy queue PLATEAUS instead of growing
 * without bound, keeps the newest init segment, and NEVER closes the socket on
 * overflow. `legacyForward` below reproduces the pre-fix close-on-overflow
 * semantics to lock the bound the old code provably violated ("stays open under a
 * slow consumer"). A teardown check proves closing the pair frees every buffer.
 */
import { describe, expect, it } from "bun:test";

import {
	closeDown,
	createPreviewProxyState,
	forward,
	freePreviewProxyState,
	PREVIEW_BACKPRESSURE_HWM_BYTES,
	PREVIEW_MAX_PENDING_BYTES,
	PREVIEW_MAX_PENDING_FRAMES,
	type PreviewDownSocket,
	resume,
} from "../modules/ui/preview-proxy.ts";

type Frame = string | ArrayBuffer;

/** Downstream whose buffer never drains — models a permanently-slow browser. */
class SlowConsumerSocket implements PreviewDownSocket {
	sent: Frame[] = [];
	closed: { code?: number; reason?: string } | null = null;
	buffered = PREVIEW_BACKPRESSURE_HWM_BYTES + 1;

	send(data: Frame): number {
		this.sent.push(data);
		return this.buffered;
	}
	getBufferedAmount(): number {
		return this.buffered;
	}
	close(code?: number, reason?: string): void {
		this.closed = { code, reason };
	}
}

function fakeUpstream(): { close: () => void; closedCount: number } {
	const up = { closedCount: 0, close: () => {} };
	up.close = () => {
		up.closedCount += 1;
	};
	return up;
}

function mediaFrame(bytes: number): ArrayBuffer {
	return new Uint8Array(bytes).buffer;
}

const INIT_FRAME = JSON.stringify({
	type: "codec-config",
	codec: "avc1.42001f",
});

describe("preview proxy — bounded memory under a slow consumer", () => {
	it("plateaus the paused queue and never closes on overflow", () => {
		const up = fakeUpstream();
		const state = createPreviewProxyState(up as unknown as WebSocket);
		const ws = new SlowConsumerSocket();

		forward(ws, state, INIT_FRAME);
		for (let i = 0; i < 5000; i++) {
			forward(ws, state, mediaFrame(1024));
		}

		// Bounded — the queue never grew past the caps (+1 for the pinned init).
		expect(state.queue.length).toBeLessThanOrEqual(
			PREVIEW_MAX_PENDING_FRAMES + 1,
		);
		expect(state.queue.byteLength).toBeLessThanOrEqual(
			PREVIEW_MAX_PENDING_BYTES + Buffer.byteLength(INIT_FRAME),
		);
		// The socket stayed OPEN — the bound the old close-on-overflow violated.
		expect(ws.closed).toBeNull();
		expect(state.downClosed).toBe(false);
		expect(up.closedCount).toBe(0);
	});

	it("keeps the newest init segment through thousands of media evictions", () => {
		const up = fakeUpstream();
		const state = createPreviewProxyState(up as unknown as WebSocket);
		const ws = new SlowConsumerSocket();

		// First media frame is sent directly and trips the pause; the init frame
		// then arrives while paused (as a source-change codec-config would) so it is
		// queued and pinned.
		forward(ws, state, mediaFrame(1024));
		forward(ws, state, INIT_FRAME);
		for (let i = 0; i < 5000; i++) {
			forward(ws, state, mediaFrame(1024));
		}

		// The pinned init frame survived and is queued to be sent FIRST on drain.
		expect(state.queue.peekAll()[0]).toBe(INIT_FRAME);
	});

	it("drains the plateaued queue once the consumer catches up", () => {
		const up = fakeUpstream();
		const state = createPreviewProxyState(up as unknown as WebSocket);
		const ws = new SlowConsumerSocket();

		forward(ws, state, mediaFrame(1024)); // sent directly, trips pause
		forward(ws, state, INIT_FRAME); // queued + pinned while paused
		for (let i = 0; i < 1000; i++) {
			forward(ws, state, mediaFrame(1024));
		}
		expect(state.paused).toBe(true);
		const queuedBefore = state.queue.length;
		expect(queuedBefore).toBeGreaterThan(0);

		// The browser catches up (buffer empties): resume flushes the queue and
		// forwards the pinned init frame first.
		ws.buffered = 0;
		const sentBefore = ws.sent.length;
		resume(ws, state);

		expect(state.queue.length).toBe(0);
		expect(state.paused).toBe(false);
		expect(ws.sent.length).toBe(sentBefore + queuedBefore);
		expect(ws.sent[sentBefore]).toBe(INIT_FRAME);
	});
});

describe("preview proxy — legacy close-on-overflow (bound the old code violated)", () => {
	// Faithful reproduction of the PRE-fix forward: unbounded push while paused,
	// then a hard close once the pending array exceeds the 512-frame cap.
	function legacyForward(
		ws: SlowConsumerSocket,
		pending: Frame[],
		state: { paused: boolean; closed: boolean },
		data: Frame,
	): void {
		if (state.closed) return;
		if (state.paused) {
			pending.push(data);
			if (pending.length > 512) {
				state.closed = true;
				ws.close(4502, "backpressure_overflow");
			}
			return;
		}
		ws.send(data);
		if (ws.getBufferedAmount() > PREVIEW_BACKPRESSURE_HWM_BYTES) {
			state.paused = true;
		}
	}

	it("the old behavior CLOSES the socket under the same slow consumer", () => {
		const ws = new SlowConsumerSocket();
		const pending: Frame[] = [];
		const state = { paused: false, closed: false };
		for (let i = 0; i < 5000; i++)
			legacyForward(ws, pending, state, mediaFrame(1024));

		// The old code tore the socket down (backpressure_overflow) — exactly the
		// "stays open" bound the new bounded drop-oldest queue satisfies above.
		expect(state.closed).toBe(true);
		expect(ws.closed?.reason).toBe("backpressure_overflow");
	});
});

describe("preview proxy — teardown frees all buffers", () => {
	it("freePreviewProxyState clears the queue and closes upstream", () => {
		const up = fakeUpstream();
		const state = createPreviewProxyState(up as unknown as WebSocket);
		const ws = new SlowConsumerSocket();

		forward(ws, state, INIT_FRAME);
		for (let i = 0; i < 1000; i++) forward(ws, state, mediaFrame(1024));
		expect(state.queue.byteLength).toBeGreaterThan(0);

		freePreviewProxyState(state);

		expect(state.queue.length).toBe(0);
		expect(state.queue.byteLength).toBe(0);
		expect(state.downClosed).toBe(true);
		expect(up.closedCount).toBe(1);
	});

	it("closeDown also frees the queue (controlled-close path)", () => {
		const up = fakeUpstream();
		const state = createPreviewProxyState(up as unknown as WebSocket);
		const ws = new SlowConsumerSocket();

		forward(ws, state, INIT_FRAME);
		for (let i = 0; i < 1000; i++) forward(ws, state, mediaFrame(1024));

		closeDown(ws, state, 1000, "upstream_closed");

		expect(state.queue.byteLength).toBe(0);
		expect(state.downClosed).toBe(true);
		expect(ws.closed?.code).toBe(1000);
	});
});
