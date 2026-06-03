import { describe, expect, it } from "bun:test";
import { advanceSeq, broadcast } from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";

describe("advanceSeq", () => {
	it("returns a 1-based, independently increasing counter per type", () => {
		const map = new Map<string, number>();

		// netif counter increments independently: 1, 2
		expect(advanceSeq(map, "netif")).toBe(1);
		expect(advanceSeq(map, "netif")).toBe(2);

		// sensors counter is independent of netif: starts at 1
		expect(advanceSeq(map, "sensors")).toBe(1);
		expect(advanceSeq(map, "sensors")).toBe(2);

		// netif continues from where it left off (never a global counter)
		expect(advanceSeq(map, "netif")).toBe(3);
	});

	it("treats every message TYPE as its own monotonic stream", () => {
		const map = new Map<string, number>();
		for (const type of [
			"netif",
			"sensors",
			"gateways",
			"modems",
			"status",
			"config",
			"wifi",
			"heartbeat",
		]) {
			expect(advanceSeq(map, type)).toBe(1);
			expect(advanceSeq(map, type)).toBe(2);
		}
	});
});

describe("broadcast", () => {
	function makeClient(sent: string[]): AppWebSocket {
		return {
			data: { isAuthenticated: true, lastActive: 0 },
			send: (msg: string) => {
				sent.push(msg);
			},
		} as unknown as AppWebSocket;
	}

	it("includes a numeric top-level seq alongside the type key", () => {
		const sent: string[] = [];
		const client = makeClient(sent);
		const { addClient, removeClient } = require("../rpc/events.ts");
		addClient(client);
		try {
			broadcast("status", { foo: "bar" });
		} finally {
			removeClient(client);
		}

		expect(sent).toHaveLength(1);
		const parsed = JSON.parse(sent[0] as string);
		expect(typeof parsed.seq).toBe("number");
		expect(parsed.status).toEqual({ foo: "bar" });
	});

	it("emits an independently increasing seq per broadcast type", () => {
		const sent: string[] = [];
		const client = makeClient(sent);
		const { addClient, removeClient } = require("../rpc/events.ts");
		addClient(client);
		try {
			broadcast("heartbeat", { a: 1 });
			const first = JSON.parse(sent[sent.length - 1] as string).seq;
			broadcast("heartbeat", { a: 2 });
			const second = JSON.parse(sent[sent.length - 1] as string).seq;
			expect(second).toBe(first + 1);
		} finally {
			removeClient(client);
		}
	});
});
