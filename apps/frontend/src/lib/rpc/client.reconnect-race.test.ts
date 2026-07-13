import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

	constructor(public readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	send(): void {}

	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.();
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}
}

describe("RPCClient reconnect-timer race", () => {
	const realWebSocket = globalThis.WebSocket;

	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers();
		FakeWebSocket.instances = [];
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	});

	afterEach(() => {
		vi.useRealTimers();
		globalThis.WebSocket = realWebSocket;
	});

	it("cancels the stale auto-reconnect timer when a manual connect wins the race", async () => {
		const { rpcClient } = await import("$lib/rpc/client");

		// Boot → open socket #0.
		rpcClient.connect();
		expect(FakeWebSocket.instances).toHaveLength(1);
		FakeWebSocket.instances[0]?.open();

		// Socket drops → onclose schedules an auto-reconnect timer (backoff window).
		FakeWebSocket.instances[0]?.close();

		// User clicks Retry BEFORE the backoff fires → manual connect opens socket #1.
		rpcClient.connect();
		expect(FakeWebSocket.instances).toHaveLength(2);
		FakeWebSocket.instances[1]?.open();

		// Advance past the first-attempt backoff (700–1300ms). The stale timer must
		// have been cancelled by the manual connect: no throw, no third socket.
		expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
		expect(FakeWebSocket.instances).toHaveLength(2);
	});
});
