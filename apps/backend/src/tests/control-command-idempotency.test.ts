import { afterEach, describe, expect, test } from "bun:test";

import {
	createSeenCidStore,
	resetSharedSeenCidStore,
} from "../modules/remote-control/command-idempotency.ts";
import { routeCommand } from "../modules/remote-control/command-router.ts";
import type {
	Command,
	DeliveryAck,
	Result,
} from "../modules/remote-control/protocol.ts";
import { resetSelfFencingState } from "../modules/remote-control/self-fencing.ts";

function makeCommand(overrides: Partial<Command>): Command {
	return {
		v: 1,
		kind: "command",
		type: "streaming.getConfig",
		cid: "11111111-1111-4111-8111-111111111111",
		role: "owner",
		...overrides,
	};
}

afterEach(() => {
	resetSelfFencingState();
	resetSharedSeenCidStore();
});

describe("seen-cid store (spec §6.1 idempotency)", () => {
	test("first sighting records, repeat within TTL is a duplicate", () => {
		const store = createSeenCidStore({ now: () => 1000, ttlMs: 60_000 });
		expect(store.checkAndRemember("cid-a")).toBe(false);
		expect(store.checkAndRemember("cid-a")).toBe(true);
		expect(store.checkAndRemember("cid-b")).toBe(false);
	});

	test("a cid is forgotten once its TTL elapses", () => {
		let clock = 1000;
		const store = createSeenCidStore({ now: () => clock, ttlMs: 5_000 });
		expect(store.checkAndRemember("cid-a")).toBe(false);
		clock = 6_001;
		expect(store.checkAndRemember("cid-a")).toBe(false);
	});

	test("the set is bounded by the size cap (oldest evicted first)", () => {
		const store = createSeenCidStore({
			now: () => 1000,
			ttlMs: 60_000,
			max: 2,
		});
		store.checkAndRemember("a");
		store.checkAndRemember("b");
		store.checkAndRemember("c");
		expect(store.size()).toBe(2);
		// "a" was the oldest and is evicted, so it reads as unseen again.
		expect(store.checkAndRemember("a")).toBe(false);
	});
});

describe("command idempotency + delivery.ack (spec §6.1)", () => {
	function harness() {
		const results: Result[] = [];
		const acks: DeliveryAck[] = [];
		let dispatched = 0;
		return {
			results,
			acks,
			dispatchedCount: () => dispatched,
			deps: {
				sendResult: (frame: Result) => {
					results.push(frame);
					return true;
				},
				sendDeliveryAck: (frame: DeliveryAck) => {
					acks.push(frame);
					return true;
				},
				seenCids: createSeenCidStore(),
				dispatch: {
					"streaming.getConfig": async () => {
						dispatched += 1;
						return { applied: { ok: true } };
					},
				},
			},
		};
	}

	test("emits a delivery.ack echoing the command type + cid on receipt", async () => {
		const h = harness();
		await routeCommand(
			makeCommand({ cid: "22222222-2222-4222-8222-222222222222" }),
			h.deps,
		);
		expect(h.acks).toHaveLength(1);
		expect(h.acks[0]?.kind).toBe("delivery.ack");
		expect(h.acks[0]?.type).toBe("streaming.getConfig");
		expect(h.acks[0]?.cid).toBe("22222222-2222-4222-8222-222222222222");
	});

	test("a replayed cid is acknowledged again but executed only once", async () => {
		const h = harness();
		const frame = makeCommand({ cid: "33333333-3333-4333-8333-333333333333" });

		await routeCommand(frame, h.deps);
		await routeCommand(frame, h.deps);

		// Both deliveries are acknowledged (so the hub stops retrying), but the
		// command runs exactly once and only the first emits a result.
		expect(h.acks).toHaveLength(2);
		expect(h.dispatchedCount()).toBe(1);
		expect(h.results).toHaveLength(1);
	});

	test("distinct cids each execute once", async () => {
		const h = harness();
		await routeCommand(
			makeCommand({ cid: "44444444-4444-4444-8444-444444444444" }),
			h.deps,
		);
		await routeCommand(
			makeCommand({ cid: "55555555-5555-4555-8555-555555555555" }),
			h.deps,
		);
		expect(h.dispatchedCount()).toBe(2);
	});
});
