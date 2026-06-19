import { afterEach, describe, expect, it } from "bun:test";
import {
	addClient,
	broadcast,
	getClients,
	removeClient,
} from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";

function makeClient(send: (msg: string) => unknown): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: 0 },
		send,
	} as unknown as AppWebSocket;
}

afterEach(() => {
	for (const client of [...getClients()]) removeClient(client);
});

describe("broadcast: per-client backpressure isolation", () => {
	it("a throwing client does not stop the others from receiving", () => {
		const a: string[] = [];
		const c: string[] = [];
		const clientA = makeClient((m) => {
			a.push(m);
		});
		const clientB = makeClient(() => {
			throw new Error("broken pipe");
		});
		const clientC = makeClient((m) => {
			c.push(m);
		});
		addClient(clientA);
		addClient(clientB);
		addClient(clientC);

		expect(() => broadcast("status", { foo: 1 })).not.toThrow();

		expect(a).toHaveLength(1);
		expect(c).toHaveLength(1);
	});

	it("a slow client (pending send) does not block dispatch to the others", () => {
		const fast: string[] = [];
		const slow = makeClient(() => new Promise<void>(() => undefined));
		const clientFast = makeClient((m) => {
			fast.push(m);
		});
		addClient(slow);
		addClient(clientFast);

		broadcast("status", { foo: 2 });

		// The fast client received synchronously even though the slow client's
		// send is still pending — the slow send never gated the others.
		expect(fast).toHaveLength(1);
	});

	it("swallows an async send rejection without disturbing the others", async () => {
		const ok: string[] = [];
		const rejecting = makeClient(() => Promise.reject(new Error("async fail")));
		const good = makeClient((m) => {
			ok.push(m);
		});
		addClient(rejecting);
		addClient(good);

		expect(() => broadcast("status", { foo: 3 })).not.toThrow();
		expect(ok).toHaveLength(1);

		// Let the allSettled microtask + failure logging settle; a missing
		// allSettled would surface here as an unhandled rejection.
		await new Promise((r) => setTimeout(r, 0));
	});

	it("preserves per-type seq ordering across broadcasts despite a failing client", () => {
		const seqs: number[] = [];
		const good = makeClient((m) => {
			seqs.push(JSON.parse(m).seq as number);
		});
		const bad = makeClient(() => {
			throw new Error("down");
		});
		addClient(good);
		addClient(bad);

		broadcast("netif", { a: 1 });
		broadcast("netif", { a: 2 });
		broadcast("netif", { a: 3 });

		expect(seqs).toHaveLength(3);
		expect(seqs[1]).toBe((seqs[0] as number) + 1);
		expect(seqs[2]).toBe((seqs[1] as number) + 1);
	});
});
