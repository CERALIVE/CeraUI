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

	sent: string[] = [];

	send(data: string): void {
		this.sent.push(data);
	}

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
		vi.clearAllTimers();
		vi.useRealTimers();
		globalThis.WebSocket = realWebSocket;
	});

	it("rejects reopening and delivering frames through a closed, reused socket", async () => {
		const { rpcClient } = await import("$lib/rpc/client");
		const messages = vi.fn();
		rpcClient.onMessage(messages);
		rpcClient.connect();
		const stale = FakeWebSocket.instances[0];
		if (!stale) throw new Error("missing initial socket");
		stale.open();
		stale.close();
		messages.mockClear();

		// Reusing the transport cannot reclaim ownership, even if it claims OPEN.
		stale.open();
		stale.onmessage?.({
			data: JSON.stringify({ netif: { eth0: { enabled: false } } }),
		});
		expect(rpcClient.getSocket()).toBeNull();
		expect(rpcClient.getConnectionState()).toBe("disconnected");
		expect(messages).not.toHaveBeenCalled();

		rpcClient.connect();
		const current = FakeWebSocket.instances[1];
		if (!current) throw new Error("missing replacement socket");
		current.open();
		stale.open();
		stale.onmessage?.({
			data: JSON.stringify({ netif: { eth0: { enabled: false } } }),
		});
		stale.close();
		expect(rpcClient.getSocket()).toBe(current);
		expect(rpcClient.getConnectionState()).toBe("connected");
		expect(messages).not.toHaveBeenCalled();
		current.onmessage?.({
			data: JSON.stringify({ netif: { eth0: { enabled: true } } }),
		});
		expect(messages).toHaveBeenCalledWith(
			"netif",
			{ eth0: { enabled: true } },
			undefined,
		);
		vi.advanceTimersByTime(2000);
		expect(FakeWebSocket.instances).toHaveLength(2);
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

	it("ignores a delayed close from the replaced socket without losing a current request", async () => {
		const { rpcClient } = await import("$lib/rpc/client");
		rpcClient.connect();
		const previous = FakeWebSocket.instances[0];
		expect(previous).toBeDefined();
		previous?.open();
		const delayedClose = previous?.onclose;
		previous?.close();

		rpcClient.connect();
		const current = FakeWebSocket.instances[1];
		expect(current).toBeDefined();
		current?.open();
		const outcome = rpcClient.call(["status", "getStatus"]).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		const request = JSON.parse(current?.sent[0] ?? "null") as { id: string };

		// A saved callback represents an event delivered after the replacement
		// already owns the transport. It must neither reject its call nor retry.
		expect(delayedClose).toBeTypeOf("function");
		delayedClose?.();
		expect(rpcClient.getSocket()).toBe(current);
		expect(rpcClient.getConnectionState()).toBe("connected");
		current?.onmessage?.({
			data: JSON.stringify({ id: request.id, result: { temperature: 42 } }),
		});
		await expect(outcome).resolves.toEqual({ value: { temperature: 42 } });
		vi.advanceTimersByTime(2000);
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	it("stops every heartbeat after replacing a closing socket and disconnecting", async () => {
		const { rpcClient } = await import("$lib/rpc/client");
		rpcClient.connect();
		const previous = FakeWebSocket.instances[0];
		if (!previous) throw new Error("missing initial socket");
		previous.open();
		const delayedClose = previous.onclose;
		previous.readyState = FakeWebSocket.CLOSING;

		rpcClient.connect();
		const current = FakeWebSocket.instances[1];
		if (!current) throw new Error("missing replacement socket");
		current.open();
		delayedClose?.();
		rpcClient.disconnect();

		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(30000);
		expect(previous.sent).toEqual([]);
		expect(current.sent).toEqual([]);
	});

	it("does not publish a delayed broadcast from the replaced socket", async () => {
		const { rpcClient } = await import("$lib/rpc/client");
		const messages = vi.fn();
		rpcClient.onMessage(messages);
		rpcClient.connect();
		const previous = FakeWebSocket.instances[0];
		previous?.open();
		const delayedMessage = previous?.onmessage;
		previous?.close();
		rpcClient.connect();
		const current = FakeWebSocket.instances[1];
		current?.open();
		current?.onmessage?.({
			data: JSON.stringify({ config: { max_br: 5000 }, seq: 0 }),
		});
		expect(messages).toHaveBeenLastCalledWith("config", { max_br: 5000 }, 0);
		messages.mockClear();

		expect(delayedMessage).toBeTypeOf("function");
		delayedMessage?.({
			data: JSON.stringify({ config: { max_br: 1000 }, seq: 99 }),
		});
		expect(messages).not.toHaveBeenCalled();
		current?.onmessage?.({
			data: JSON.stringify({ config: { max_br: 6000 }, seq: 1 }),
		});
		expect(messages).toHaveBeenLastCalledWith("config", { max_br: 6000 }, 1);
	});

	it("does not let a delayed error demote the connected replacement", async () => {
		const { rpcClient } = await import("$lib/rpc/client");
		rpcClient.connect();
		const previous = FakeWebSocket.instances[0];
		previous?.open();
		const delayedError = previous?.onerror;
		previous?.close();
		rpcClient.connect();
		const current = FakeWebSocket.instances[1];
		current?.open();
		expect(rpcClient.isConnected()).toBe(true);

		expect(delayedError).toBeTypeOf("function");
		delayedError?.();
		expect(rpcClient.getConnectionState()).toBe("connected");
		current?.onerror?.();
		expect(rpcClient.getConnectionState()).toBe("error");
	});

	it("does not let a delayed open announce the replacement before it opens", async () => {
		const { rpcClient } = await import("$lib/rpc/client");
		rpcClient.connect();
		const previous = FakeWebSocket.instances[0];
		const delayedOpen = previous?.onopen;
		previous?.close();
		rpcClient.connect();
		const current = FakeWebSocket.instances[1];
		expect(current?.readyState).toBe(FakeWebSocket.CONNECTING);

		expect(delayedOpen).toBeTypeOf("function");
		delayedOpen?.();
		expect(rpcClient.getConnectionState()).toBe("connecting");
		current?.open();
		expect(rpcClient.isConnected()).toBe(true);
	});
});
