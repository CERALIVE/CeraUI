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
import { afterEach, describe, expect, it, vi } from "vitest";

import { rpc, rpcClient } from "./client";

afterEach(() => vi.restoreAllMocks());

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
});
