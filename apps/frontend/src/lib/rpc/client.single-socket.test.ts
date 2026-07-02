import { afterEach, describe, expect, it } from "vitest";

import { rpcClient } from "$lib/rpc/client";

type SocketPoke = { socket: { readyState: number } | null };

function setSocket(readyState: number | null): void {
	(rpcClient as unknown as SocketPoke).socket =
		readyState === null ? null : { readyState };
}

describe("RPCClient single-socket invariant (dev)", () => {
	afterEach(() => {
		setSocket(null);
	});

	it("throws when connect() is called while a socket is already OPEN", () => {
		setSocket(WebSocket.OPEN);
		expect(() => rpcClient.connect()).toThrow(/single-socket invariant/i);
	});

	it("throws when connect() is called while a socket is CONNECTING", () => {
		setSocket(WebSocket.CONNECTING);
		expect(() => rpcClient.connect()).toThrow(/single-socket invariant/i);
	});

	it("does not throw when no socket exists (no concurrent construction)", () => {
		setSocket(null);
		expect(() => rpcClient.connect()).not.toThrow();
	});
});
