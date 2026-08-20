/**
 * A tick that carried no news must be a no-op.
 *
 * Every broadcast is `JSON.parse`d, so an unchanged modem or interface still
 * arrives as a brand-new object graph — and both merges then allocated a fresh
 * entry AND a fresh map for it. `getModems()`/`getNetif()` therefore returned a
 * different reference every 5s on a completely idle board, invalidating every
 * `$derived` beneath them and re-running each row's whole derivation block for
 * data that had not moved.
 *
 * This locks the opposite property: identical data in, identical references
 * out. It does NOT relax the key-set authority the merges already carry — an id
 * the frame stopped publishing is a change, and `netif-modem-staleness.test.ts`
 * remains the contract for that half.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers: { message?: (t: string, d: unknown, s?: number) => void } = {};

vi.mock("$lib/rpc/client", () => ({
	rpc: {},
	rpcClient: {
		onMessage: (fn: (t: string, d: unknown, s?: number) => void) => {
			handlers.message = fn;
		},
		onConnectionChange: () => undefined,
		connect: () => undefined,
		getSocket: () => undefined,
		sendLegacy: () => undefined,
	},
}));

import {
	getModems,
	getNetif,
	initSubscriptions,
	resetState,
} from "$lib/rpc/subscriptions.svelte";
import { isSameWireValue } from "$lib/rpc/value-identity";

/** A tick is a fresh parse of the same bytes — never the same object twice. */
function push(type: string, payload: unknown): void {
	handlers.message?.(type, JSON.parse(JSON.stringify(payload)));
}

const HILINK = {
	ifname: "enx0c5b8f279a64",
	name: "Huawei E3372",
	device_class: "router-ethernet",
	router_admin: {
		admin_url: "http://192.168.8.1",
		reachable: true,
		signal: { bars: 3, max_bars: 5, freshness: "live" },
	},
	status: { connection: "connected", signal: 62, roaming: false },
};
const QUECTEL = {
	ifname: "wwan0",
	name: "RM530N-GL",
	device_class: "usb",
	status: { connection: "searching", signal: 40, roaming: false },
};

const ETH0 = { ip: "192.168.78.132", tp: 5, enabled: true, tx_bps: 1200 };
const ZTE = { ip: "192.168.0.169", tp: 3, enabled: true, tx_bps: 900 };

describe("modem merge — an unchanged tick preserves object identity", () => {
	beforeEach(() => {
		resetState();
		initSubscriptions();
	});

	it("returns the SAME map and the SAME entries when nothing changed", () => {
		push("modems", { "0": QUECTEL, "1001": HILINK });
		const first = getModems();
		const firstHilink = first?.["1001"];

		push("modems", { "0": QUECTEL, "1001": HILINK });

		expect(getModems()).toBe(first);
		expect(getModems()?.["1001"]).toBe(firstHilink);
	});

	it("compares by VALUE, not by reference — nested blocks included", () => {
		push("modems", { "1001": HILINK });
		const before = getModems()?.["1001"];

		push("modems", { "1001": HILINK });

		expect(getModems()?.["1001"]).toBe(before);
		expect(before?.router_admin).toBe(getModems()?.["1001"]?.router_admin);
	});

	it("publishes a new entry the moment a single nested field moves", () => {
		push("modems", { "0": QUECTEL, "1001": HILINK });
		const before = getModems();

		push("modems", {
			"0": QUECTEL,
			"1001": {
				...HILINK,
				router_admin: {
					...HILINK.router_admin,
					signal: { bars: 1, max_bars: 5, freshness: "live" },
				},
			},
		});

		expect(getModems()).not.toBe(before);
		expect(getModems()?.["1001"]).not.toBe(before?.["1001"]);
		expect(getModems()?.["1001"]?.router_admin?.signal?.bars).toBe(1);
		expect(getModems()?.["0"]).toBe(before?.["0"]);
	});

	it("still drops an id the frame stopped publishing", () => {
		push("modems", { "0": QUECTEL, "1001": HILINK });
		const before = getModems();

		push("modems", { "0": QUECTEL });

		expect(getModems()).not.toBe(before);
		expect(Object.keys(getModems() ?? {})).toEqual(["0"]);
	});

	it("still publishes a new map when an id appears", () => {
		push("modems", { "0": QUECTEL });
		const before = getModems();

		push("modems", { "0": QUECTEL, "1001": HILINK });

		expect(getModems()).not.toBe(before);
		expect(getModems()?.["0"]).toBe(before?.["0"]);
	});
});

describe("netif merge — an unchanged tick preserves object identity", () => {
	beforeEach(() => {
		resetState();
		initSubscriptions();
	});

	it("returns the SAME map and the SAME entries when nothing changed", () => {
		push("netif", { eth0: ETH0, enx344b50000000: ZTE });
		const first = getNetif();
		const firstEth = first?.eth0;

		push("netif", { eth0: ETH0, enx344b50000000: ZTE });

		expect(getNetif()).toBe(first);
		expect(getNetif()?.eth0).toBe(firstEth);
	});

	it("publishes a new entry when a measured rate moves", () => {
		push("netif", { eth0: ETH0 });
		const before = getNetif();

		push("netif", { eth0: { ...ETH0, tx_bps: 4100 } });

		expect(getNetif()).not.toBe(before);
		expect(getNetif()?.eth0?.tx_bps).toBe(4100);
	});

	it("still drops an interface the frame stopped reporting", () => {
		push("netif", { eth0: ETH0, enx344b50000000: ZTE });
		const before = getNetif();

		push("netif", { eth0: ETH0 });

		expect(getNetif()).not.toBe(before);
		expect(Object.keys(getNetif() ?? {})).toEqual(["eth0"]);
	});
});

describe("isSameWireValue", () => {
	it("accepts structurally identical plain-JSON graphs", () => {
		expect(isSameWireValue(HILINK, JSON.parse(JSON.stringify(HILINK)))).toBe(
			true,
		);
		expect(
			isSameWireValue([1, { a: [true, null] }], [1, { a: [true, null] }]),
		).toBe(true);
	});

	it("rejects a differing value, an extra key, and a missing key", () => {
		expect(isSameWireValue({ a: 1 }, { a: 2 })).toBe(false);
		expect(isSameWireValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(isSameWireValue({ a: 1, b: 2 }, { a: 1 })).toBe(false);
	});

	it("never confuses an explicit undefined with an absent key", () => {
		expect(isSameWireValue({ a: 1, b: undefined }, { a: 1 })).toBe(false);
	});

	it("keeps an array distinct from an object with the same indices", () => {
		expect(isSameWireValue([1, 2], { 0: 1, 1: 2 })).toBe(false);
		expect(isSameWireValue([1, 2], [1, 2, 3])).toBe(false);
	});
});
