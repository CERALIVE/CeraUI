/**
 * Regression lock for the stale "No address yet" defect (todo 53).
 *
 * Both wire maps are FULL SNAPSHOTS of their key set — `netIfBuildMsg()` walks
 * every interface, and `projectModemWire()`/`buildModemsMessage()` emit an entry
 * for every device, narrowing only what an entry CONTAINS. Both frontend merges
 * used to seed themselves from the previous map, so a key the backend stopped
 * publishing was never removed.
 *
 * That latch is operator-visible in two ways, and the second is the reported
 * bug: a modem row resolves its address by `netif[modem.ifname]`, so a modem id
 * that outlived its hardware kept rendering an `ifname` no interface answers to
 * — and reported "No address yet, so this link can't join the bonding pool"
 * about a link that was simply gone. The bench pair (`enx0c5b8f279a64` /
 * `eth1`, one factory MAC between them) renames on every replug, which is
 * exactly how a modem row acquires a dead `ifname` while the device is fine.
 *
 * Proven on the board before the fix: downing `eth1` removed it from the wire
 * and the UI went on rendering it at `192.168.8.100`.
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
} from "../lib/rpc/subscriptions.svelte.ts";

const HILINK = {
	ip: "192.168.8.100",
	tp: 0,
	enabled: false,
	error: "duplicate IPv4 addr",
} as const;
const ETH0 = { ip: "192.168.78.132", tp: 5, enabled: true } as const;
const ZTE = { ip: "192.168.0.169", tp: 3, enabled: true } as const;

describe("netif ingestion — the key set is authoritative", () => {
	beforeEach(() => {
		resetState();
		initSubscriptions();
	});

	it("drops an interface the next frame no longer reports", () => {
		handlers.message?.("netif", { eth0: ETH0, eth1: HILINK });
		expect(getNetif()?.eth1?.ip).toBe("192.168.8.100");

		handlers.message?.("netif", { eth0: ETH0 });

		expect(getNetif()?.eth1).toBeUndefined();
		expect(getNetif()?.eth0?.ip).toBe("192.168.78.132");
	});

	it("still preserves an optional field a later frame omits", () => {
		handlers.message?.("netif", {
			enx344b50000000: {
				...ZTE,
				router_cellular: {
					vendor: "ZTE",
					model: "ZTE Mobile Boardband",
					vid_pid: "19d2:1405",
					kind: "router-cellular",
					duplicate_model: false,
				},
			},
		});
		handlers.message?.("netif", { enx344b50000000: { ...ZTE, tp: 9 } });

		const row = getNetif()?.enx344b50000000;
		expect(row?.tp).toBe(9);
		expect(row?.router_cellular?.vid_pid).toBe("19d2:1405");
	});

	it("re-adds an interface that comes back", () => {
		handlers.message?.("netif", { eth0: ETH0, eth1: HILINK });
		handlers.message?.("netif", { eth0: ETH0 });
		handlers.message?.("netif", { eth0: ETH0, eth1: HILINK });

		expect(getNetif()?.eth1?.ip).toBe("192.168.8.100");
	});

	it("an empty frame clears every row rather than freezing the last one", () => {
		handlers.message?.("netif", { eth0: ETH0 });
		handlers.message?.("netif", {});

		expect(getNetif()?.eth0).toBeUndefined();
	});
});

describe("modems ingestion — the id set is authoritative", () => {
	beforeEach(() => {
		resetState();
		initSubscriptions();
	});

	it("drops a modem id the next roster no longer carries", () => {
		handlers.message?.("status", {
			modems: {
				2: {
					ifname: "wwan0",
					name: "RM530N-GL",
					network_type: { supported: [], active: null },
				},
				4: {
					ifname: "wwan1",
					name: "SIM7600G-H",
					network_type: { supported: [], active: null },
				},
			},
		});
		expect(Object.keys(getModems() ?? {})).toEqual(["2", "4"]);

		handlers.message?.("status", {
			modems: {
				2: {
					ifname: "wwan0",
					name: "RM530N-GL",
					network_type: { supported: [], active: null },
				},
			},
		});

		expect(Object.keys(getModems() ?? {})).toEqual(["2"]);
	});

	it("keeps merging fields a status-only push omits", () => {
		handlers.message?.("status", {
			modems: {
				2: {
					ifname: "wwan0",
					name: "RM530N-GL",
					network_type: { supported: [], active: null },
					status: { connection: "searching", signal: 81 },
					sim_lock: { required: "sim-pin", remainingAttempts: 3 },
				},
			},
		});
		handlers.message?.("status", {
			modems: { 2: { status: { connection: "registered", signal: 84 } } },
		});

		const modem = getModems()?.["2"];
		expect(modem?.name).toBe("RM530N-GL");
		expect(modem?.ifname).toBe("wwan0");
		expect(modem?.status?.connection).toBe("registered");
		expect(modem?.sim_lock?.required).toBe("sim-pin");
	});

	// The reported symptom, end to end: the roster drops the device, so no row
	// survives to resolve a dead `ifname` against a netif map that never had it.
	it("a removed modem cannot outlive its interface and claim no-address", () => {
		handlers.message?.("netif", { eth0: ETH0, enx0c5b8f279a64: HILINK });
		handlers.message?.("status", {
			modems: {
				1000: {
					ifname: "enx0c5b8f279a64",
					name: "E3372",
					network_type: { supported: [], active: null },
					device_class: "router-ethernet",
				},
			},
		});
		expect(getModems()?.["1000"]?.ifname).toBe("enx0c5b8f279a64");

		handlers.message?.("netif", { eth0: ETH0, eth1: HILINK });
		handlers.message?.("status", {
			modems: {
				1001: {
					ifname: "eth1",
					name: "E3372",
					network_type: { supported: [], active: null },
					device_class: "router-ethernet",
				},
			},
		});

		expect(getModems()?.["1000"]).toBeUndefined();
		const survivor = getModems()?.["1001"];
		expect(survivor?.ifname).toBe("eth1");
		expect(getNetif()?.[survivor?.ifname ?? ""]?.ip).toBe("192.168.8.100");
	});
});
