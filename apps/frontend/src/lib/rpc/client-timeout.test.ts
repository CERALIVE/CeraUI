// @vitest-environment node
/**
 * Locks the per-procedure client-call timeout override (Todo 29).
 *
 * `streaming.start` awaits the backend bounded connect-retry (up to a 60s budget),
 * so the 30s default `RPCClient.call` timeout would reject a still-valid in-flight
 * start and drop the terminal typed `failure` payload. The proxy must call
 * `streaming.start` with a timeout ABOVE the retry budget; other procedures keep
 * the default (no explicit timeout arg).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionResetError, rpc, rpcClient } from "./client";

vi.mock("../env", () => ({
	getRpcSocketUrl: () => "ws://test.local/ws",
}));

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState: number = FakeWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	send(): void {}

	close(): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.();
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}
}

const realWebSocket = globalThis.WebSocket;

beforeEach(() => {
	FakeWebSocket.instances = [];
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
	rpcClient.disconnect();
	globalThis.WebSocket = realWebSocket;
	vi.restoreAllMocks();
});

describe("RPC per-procedure timeout", () => {
	it("calls streaming.start with a timeout above the 60s retry budget", () => {
		const spy = vi
			.spyOn(rpcClient, "call")
			.mockResolvedValue({ success: false } as never);
		void rpc.streaming.start({} as never);
		expect(spy).toHaveBeenCalledTimes(1);
		const timeout = spy.mock.calls[0]?.[2] as number | undefined;
		expect(typeof timeout).toBe("number");
		expect(timeout).toBeGreaterThan(60_000);
	});

	it("leaves other procedures on the default timeout (no explicit arg)", () => {
		const spy = vi
			.spyOn(rpcClient, "call")
			.mockResolvedValue({ success: true } as never);
		void rpc.streaming.stop();
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[2]).toBeUndefined();
	});

	it("rejects every pending promise with ConnectionResetError within 50ms of socket close", async () => {
		rpcClient.connect();
		const socket = FakeWebSocket.instances[0];
		socket?.open();

		const pending = [rpc.streaming.stop(), rpc.streaming.start({} as never)];
		const outcome = Promise.race([
			Promise.allSettled(pending),
			new Promise<"still-pending">((resolve) =>
				setTimeout(() => resolve("still-pending"), 50),
			),
		]);

		socket?.close();
		const settled = await outcome;

		expect(settled).not.toBe("still-pending");
		if (settled === "still-pending") return;
		expect(settled).toHaveLength(2);
		for (const result of settled) {
			expect(result.status).toBe("rejected");
			if (result.status === "rejected") {
				expect(result.reason).toBeInstanceOf(ConnectionResetError);
			}
		}
	});
});
