/*
  Regression lock for per-adapter hotspot identity.

  A test device accumulated SIX NetworkManager AP profiles (`Hotspot`,
  `Hotspot-1` … `Hotspot-5`), each with a DIFFERENT SSID and password, because
  every hotspot start took the "no hotspot connection yet" branch and generated a
  fresh pair. Two independent causes, both reproduced below:

    1. Adapters were keyed on the OPERATIONAL MAC address, which NetworkManager
       randomizes while scanning. A backend restart (or a scan) re-keyed the
       registry, so the adopted profile was lost and a new one was minted; the
       SSID was also derived from whatever randomized value happened to be live.
    2. `802-11-wireless.mac-address` was pinned to that same randomized value.
       NetworkManager matches that property against the adapter's PERMANENT
       address, so the profile could never be activated again — the board's
       journal recorded `result="fail" reason="… device MAC address does not
       match the profile"` on every start.
*/

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	getHotspotCredentials,
	rememberHotspotCredentials,
	resetHotspotCredentialsForTest,
} from "../modules/wifi/hotspot-credentials.ts";
import {
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import {
	addWifiInterface,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import { startHotspotForInterface } from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	findHotspotConnForAdapter,
	type HotspotProfileDeps,
	pruneDuplicateHotspotConns,
	shouldAdoptHotspotConn,
} from "../modules/wifi/wifi-hotspot-discovery.ts";
import type {
	HotspotActivationDeps,
	WifiInterfaceWithHotspot,
} from "../modules/wifi/wifi-hotspot-types.ts";
import {
	normalizeMacAddress,
	resetWifiPermanentMacCache,
	resolveWifiPermanentMac,
	setPermanentMacReaderForTest,
} from "../modules/wifi/wifi-permanent-mac.ts";

/** The reference board's real permanent address (D-Bus `PermHwAddress`). */
const PERM_MAC = "58:02:05:e1:79:1c";
/** One of the scan-time randomized addresses observed on that same board. */
const RANDOM_MAC = "26:c3:93:b6:9c:a7";
const SECOND_PERM_MAC = "dc:a6:32:aa:bb:cc";

function makeHotspotIface(
	over: { ifname?: string; hotspotConn?: string } = {},
): WifiInterfaceWithHotspot {
	return {
		id: 0,
		ifname: over.ifname ?? "wlan0",
		conn: null,
		hw: "Realtek RTL8852BE",
		available: new Map(),
		saved: {},
		hotspot: {
			...(over.hotspotConn ? { conn: over.hotspotConn } : {}),
			availableChannels: ["auto"],
			warnings: {},
		},
	};
}

type Recorder = {
	deps: HotspotActivationDeps;
	created: Array<{ ssid: string; password: string }>;
	activated: string[];
	setFields: Array<[string, Record<string, string>]>;
	pruned: Array<[string, string]>;
	store: Map<string, { ssid: string; password: string; conn?: string }>;
};

function makeRecorder(over: Partial<HotspotActivationDeps> = {}): Recorder {
	const created: Recorder["created"] = [];
	const activated: string[] = [];
	const setFields: Recorder["setFields"] = [];
	const pruned: Recorder["pruned"] = [];
	const store: Recorder["store"] = new Map();

	let generated = 0;
	const deps: HotspotActivationDeps = {
		nmConnect: async (uuid) => {
			activated.push(uuid);
			return true;
		},
		nmConnSetFields: async (uuid, fields) => {
			setFields.push([uuid, fields]);
			return true;
		},
		nmHotspot: async (_device, ssid, password) => {
			created.push({ ssid, password });
			generated += 1;
			return `generated-uuid-${generated}`;
		},
		wifiUpdateSavedConns: async () => {},
		broadcastState: () => {},
		setDupIpSuppression: () => {},
		credentials: {
			get: (mac) => store.get(mac),
			remember: (mac, creds) => {
				store.set(mac, { ...creds });
			},
		},
		findHotspotConn: async () => undefined,
		pruneHotspotConns: async (mac, keep) => {
			pruned.push([mac, keep]);
		},
		...over,
	};

	return { deps, created, activated, setFields, pruned, store };
}

beforeEach(() => {
	setWifiState({});
	onWifiChange(() => {});
	resetHotspotCredentialsForTest();
	resetWifiPermanentMacCache();
});

afterEach(() => {
	setPermanentMacReaderForTest(null);
	resetWifiPermanentMacCache();
	resetHotspotCredentialsForTest();
});

// ─── 1. adapter identity is the PERMANENT address ────────────────────────────

describe("permanent MAC resolution", () => {
	test("prefers the kernel permanent address over the current one", async () => {
		setPermanentMacReaderForTest(async () => `${PERM_MAC.toUpperCase()}\n`);

		expect(await resolveWifiPermanentMac("wlan0", RANDOM_MAC)).toBe(PERM_MAC);
	});

	test("a randomized address never re-keys the adapter across polls", async () => {
		setPermanentMacReaderForTest(async () => PERM_MAC);

		const first = await resolveWifiPermanentMac("wlan0", PERM_MAC);
		const duringScan = await resolveWifiPermanentMac("wlan0", RANDOM_MAC);

		expect(duringScan).toBe(first);
	});

	test("a transient sysfs failure holds the last permanent address", async () => {
		setPermanentMacReaderForTest(async () => PERM_MAC);
		await resolveWifiPermanentMac("wlan0", PERM_MAC);

		setPermanentMacReaderForTest(async () => undefined);
		expect(await resolveWifiPermanentMac("wlan0", RANDOM_MAC)).toBe(PERM_MAC);
	});

	test("with no permanent address at all it degrades to the current one", async () => {
		setPermanentMacReaderForTest(async () => undefined);

		expect(await resolveWifiPermanentMac("wlan0", RANDOM_MAC)).toBe(RANDOM_MAC);
	});

	test("rejects malformed and all-zero addresses", () => {
		expect(normalizeMacAddress("00:00:00:00:00:00")).toBeUndefined();
		expect(normalizeMacAddress("not-a-mac")).toBeUndefined();
		expect(normalizeMacAddress(" 58:02:05:E1:79:1C\n")).toBe(PERM_MAC);
	});
});

// ─── 2. a restart reuses the identity instead of minting a new one ───────────

describe("hotspot start — identity reuse", () => {
	test("first-ever start generates from the permanent MAC and persists it", async () => {
		const rec = makeRecorder();
		const iface = makeHotspotIface();

		const result = await startHotspotForInterface(PERM_MAC, iface, rec.deps);

		expect(result.success).toBe(true);
		expect(rec.created).toHaveLength(1);
		// SSID suffix is the PERMANENT address's last two octets, never a scan value.
		expect(rec.created[0]?.ssid).toBe("CERALIVE_791c");
		expect(rec.store.get(PERM_MAC)?.ssid).toBe("CERALIVE_791c");
		expect(rec.store.get(PERM_MAC)?.password).toBe(rec.created[0]?.password);
	});

	test("a backend restart reuses the SAME ssid/password and creates NO new profile", async () => {
		const first = makeRecorder();
		await startHotspotForInterface(PERM_MAC, makeHotspotIface(), first.deps);

		const persisted = first.store.get(PERM_MAC);
		expect(persisted).toBeDefined();

		// Simulate the restart: fresh in-memory interface (no hotspot.conn), the
		// durable store survives, and NetworkManager still holds the profile.
		const second = makeRecorder({
			findHotspotConn: async (mac, stored) => {
				expect(mac).toBe(PERM_MAC);
				expect(stored?.ssid).toBe(persisted?.ssid);
				return {
					uuid: "generated-uuid-1",
					ssid: stored?.ssid ?? "",
					password: stored?.password ?? "",
					channel: "auto",
				};
			},
		});
		second.store.set(PERM_MAC, {
			...(persisted as { ssid: string; password: string }),
		});

		const restarted = makeHotspotIface();
		const result = await startHotspotForInterface(
			PERM_MAC,
			restarted,
			second.deps,
		);

		expect(result.success).toBe(true);
		// The decisive assertion: NO new NetworkManager profile was created.
		expect(second.created).toHaveLength(0);
		expect(second.activated).toEqual(["generated-uuid-1"]);
		expect(restarted.hotspot.name).toBe(persisted?.ssid);
		expect(restarted.hotspot.password).toBe(persisted?.password);
	});

	test("an externally deleted profile is recreated with the SAME credentials", async () => {
		const rec = makeRecorder();
		rec.store.set(PERM_MAC, {
			ssid: "CERALIVE_791c",
			password: "persisted-secret",
			conn: "deleted-uuid",
		});

		const result = await startHotspotForInterface(
			PERM_MAC,
			makeHotspotIface(),
			rec.deps,
		);

		expect(result.success).toBe(true);
		expect(rec.created).toEqual([
			{ ssid: "CERALIVE_791c", password: "persisted-secret" },
		]);
	});

	test("the profile is pinned to the permanent MAC, and repaired BEFORE activation", async () => {
		const order: string[] = [];
		const rec = makeRecorder({
			findHotspotConn: async () => ({
				uuid: "orphan-uuid",
				ssid: "CERALIVE_9ca7",
				password: "old-secret",
				channel: "auto",
			}),
			nmConnSetFields: async (uuid, fields) => {
				const mac = fields["802-11-wireless.mac-address"];
				order.push(mac ? `bind:${uuid}:${mac}` : `autoconnect:${uuid}`);
				return true;
			},
			nmConnect: async (uuid) => {
				order.push(`up:${uuid}`);
				return true;
			},
		});

		await startHotspotForInterface(PERM_MAC, makeHotspotIface(), rec.deps);

		// NetworkManager matches mac-address against the PERMANENT address, so the
		// repair has to land before the activation it would otherwise reject —
		// while autoconnect must wait until the hotspot is proven to come up, or
		// NetworkManager races its own auto-activation against the explicit up.
		expect(order).toEqual([
			`bind:orphan-uuid:${PERM_MAC}`,
			"up:orphan-uuid",
			"autoconnect:orphan-uuid",
		]);
	});

	test("autoconnect is never armed on a profile that failed to come up", async () => {
		const armed: string[] = [];
		const rec = makeRecorder({
			findHotspotConn: async () => ({
				uuid: "orphan-uuid",
				ssid: "CERALIVE_9ca7",
				password: "old-secret",
				channel: "auto",
			}),
			nmConnSetFields: async (uuid, fields) => {
				if (fields["connection.autoconnect"] === "yes") armed.push(uuid);
				return true;
			},
			nmConnect: async () => false,
		});

		await startHotspotForInterface(PERM_MAC, makeHotspotIface(), rec.deps);

		expect(armed).toEqual([]);
	});

	test("a failed activation of an existing profile still rolls back", async () => {
		const rec = makeRecorder({
			findHotspotConn: async () => ({
				uuid: "orphan-uuid",
				ssid: "CERALIVE_9ca7",
				password: "old-secret",
				channel: "auto",
			}),
			nmConnect: async () => false,
		});

		const result = await startHotspotForInterface(
			PERM_MAC,
			makeHotspotIface(),
			rec.deps,
		);

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toBe("activation-failed");
		expect(rec.created).toHaveLength(0);
	});
});

// ─── 3. multi-adapter isolation ──────────────────────────────────────────────

describe("hotspot identity — multiple adapters", () => {
	test("two adapters keep two independent, non-colliding identities", async () => {
		const rec = makeRecorder();

		await startHotspotForInterface(PERM_MAC, makeHotspotIface(), rec.deps);
		await startHotspotForInterface(
			SECOND_PERM_MAC,
			makeHotspotIface({ ifname: "wlan1" }),
			rec.deps,
		);

		const a = rec.store.get(PERM_MAC);
		const b = rec.store.get(SECOND_PERM_MAC);

		expect(a?.ssid).toBe("CERALIVE_791c");
		expect(b?.ssid).toBe("CERALIVE_bbcc");
		expect(a?.password).not.toBe(b?.password);
		expect(a?.conn).not.toBe(b?.conn);
	});

	test("both identities survive a restart, each adapter keeping its own", async () => {
		const rec = makeRecorder();
		await startHotspotForInterface(PERM_MAC, makeHotspotIface(), rec.deps);
		await startHotspotForInterface(
			SECOND_PERM_MAC,
			makeHotspotIface({ ifname: "wlan1" }),
			rec.deps,
		);
		const before = new Map(rec.store);

		const after = makeRecorder({
			findHotspotConn: async (_mac, stored) =>
				stored?.conn
					? {
							uuid: stored.conn,
							ssid: stored.ssid,
							password: stored.password,
							channel: "auto",
						}
					: undefined,
		});
		for (const [mac, creds] of before) after.store.set(mac, { ...creds });

		const ifaceA = makeHotspotIface();
		const ifaceB = makeHotspotIface({ ifname: "wlan1" });
		await startHotspotForInterface(PERM_MAC, ifaceA, after.deps);
		await startHotspotForInterface(SECOND_PERM_MAC, ifaceB, after.deps);

		expect(after.created).toHaveLength(0);
		expect(ifaceA.hotspot.name).toBe(before.get(PERM_MAC)?.ssid);
		expect(ifaceB.hotspot.name).toBe(before.get(SECOND_PERM_MAC)?.ssid);
		expect(ifaceA.hotspot.password).not.toBe(ifaceB.hotspot.password);
	});
});

// ─── 4. durable store round-trip ─────────────────────────────────────────────

describe("hotspot credentials store", () => {
	test("keys are normalized so a case difference is the same adapter", () => {
		rememberHotspotCredentials(PERM_MAC.toUpperCase(), {
			ssid: "CERALIVE_791c",
			password: "secret",
		});

		expect(getHotspotCredentials(PERM_MAC)?.ssid).toBe("CERALIVE_791c");
	});

	test("an incomplete credential pair is never recorded", () => {
		rememberHotspotCredentials(PERM_MAC, {
			ssid: "CERALIVE_791c",
			password: "",
		});

		expect(getHotspotCredentials(PERM_MAC)).toBeUndefined();
	});

	test("adapters do not overwrite each other", () => {
		rememberHotspotCredentials(PERM_MAC, { ssid: "a", password: "pa" });
		rememberHotspotCredentials(SECOND_PERM_MAC, { ssid: "b", password: "pb" });

		expect(getHotspotCredentials(PERM_MAC)?.ssid).toBe("a");
		expect(getHotspotCredentials(SECOND_PERM_MAC)?.ssid).toBe("b");
	});
});

// ─── 5. deterministic profile lookup + duplicate consolidation ───────────────

type FakeProfile = {
	uuid: string;
	name: string;
	mode: string;
	ssid: string;
	psk: string;
	mac: string;
};

function makeProfileDeps(profiles: FakeProfile[]): {
	deps: HotspotProfileDeps;
	deleted: string[];
} {
	const deleted: string[] = [];
	const deps: HotspotProfileDeps = {
		getApProfileFields: async (uuid) => {
			const p = profiles.find((entry) => entry.uuid === uuid);
			if (!p) return undefined;
			return [p.mode, p.ssid, p.psk, "", "", p.mac] as const;
		},
		listConnections: async (fields) =>
			profiles.map((p) =>
				fields.includes("name")
					? `${p.uuid}:802-11-wireless:${p.name}`
					: `${p.uuid}:802-11-wireless`,
			),
		deleteConnection: async (uuid) => {
			deleted.push(uuid);
			return true;
		},
	};
	return { deps, deleted };
}

describe("findHotspotConnForAdapter", () => {
	test("matches on the adapter's permanent MAC, not on profile order or name", async () => {
		const { deps } = makeProfileDeps([
			{
				uuid: "orphan",
				name: "Hotspot-1",
				mode: "ap",
				ssid: "CERALIVE_ce62",
				psk: "x",
				mac: RANDOM_MAC,
			},
			{
				uuid: "ours",
				name: "Hotspot-5",
				mode: "ap",
				ssid: "CERALIVE_791c",
				psk: "y",
				mac: PERM_MAC.toUpperCase(),
			},
		]);

		const found = await findHotspotConnForAdapter(PERM_MAC, undefined, deps);

		expect(found?.uuid).toBe("ours");
		expect(found?.password).toBe("y");
	});

	test("a station profile is never adopted as a hotspot", async () => {
		const { deps } = makeProfileDeps([
			{
				uuid: "home",
				name: "HomeWifi",
				mode: "infrastructure",
				ssid: "Home",
				psk: "z",
				mac: PERM_MAC,
			},
		]);

		expect(
			await findHotspotConnForAdapter(PERM_MAC, undefined, deps),
		).toBeUndefined();
	});

	test("falls back to the persisted SSID for a profile with a stale binding", async () => {
		const { deps } = makeProfileDeps([
			{
				uuid: "legacy",
				name: "Hotspot",
				mode: "ap",
				ssid: "CERALIVE_eeca",
				psk: "legacy-secret",
				mac: RANDOM_MAC,
			},
		]);

		const found = await findHotspotConnForAdapter(
			PERM_MAC,
			{ ssid: "CERALIVE_eeca", password: "legacy-secret" },
			deps,
		);

		expect(found?.uuid).toBe("legacy");
	});
});

describe("shouldAdoptHotspotConn", () => {
	test("the persisted identity arbitrates between duplicate profiles", () => {
		const stored = { ssid: "CERALIVE_791c", password: "p", conn: "ours" };

		expect(shouldAdoptHotspotConn("ours", stored)).toBe(true);
		// The exact regression: a sweep over duplicates must not let whichever
		// profile nmcli enumerated first change the adapter's SSID.
		expect(shouldAdoptHotspotConn("duplicate", stored)).toBe(false);
	});

	test("the connection NetworkManager is actually running always wins", () => {
		const stored = { ssid: "CERALIVE_791c", password: "p", conn: "ours" };

		expect(shouldAdoptHotspotConn("running", stored, { active: true })).toBe(
			true,
		);
	});

	test("with no persisted identity any AP profile may claim the adapter", () => {
		expect(shouldAdoptHotspotConn("anything", undefined)).toBe(true);
		expect(
			shouldAdoptHotspotConn("anything", { ssid: "s", password: "p" }),
		).toBe(true);
	});
});

describe("pruneDuplicateHotspotConns", () => {
	afterEach(() => {
		removeWifiInterface(PERM_MAC);
		removeWifiInterface(SECOND_PERM_MAC);
	});

	test("removes superseded generated profiles and keeps the active one", async () => {
		addWifiInterface(PERM_MAC, makeHotspotIface({ hotspotConn: "keep" }));
		const { deps, deleted } = makeProfileDeps([
			{
				uuid: "keep",
				name: "Hotspot-5",
				mode: "ap",
				ssid: "CERALIVE_791c",
				psk: "y",
				mac: PERM_MAC,
			},
			{
				uuid: "orphan-a",
				name: "Hotspot-1",
				mode: "ap",
				ssid: "CERALIVE_ce62",
				psk: "x",
				mac: RANDOM_MAC,
			},
			{
				uuid: "orphan-b",
				name: "Hotspot",
				mode: "ap",
				ssid: "CERALIVE_eeca",
				psk: "x",
				mac: PERM_MAC,
			},
			{
				uuid: "home",
				name: "HomeWifi",
				mode: "infrastructure",
				ssid: "Home",
				psk: "z",
				mac: PERM_MAC,
			},
		]);

		const removed = await pruneDuplicateHotspotConns(PERM_MAC, "keep", deps);

		expect(removed.sort()).toEqual(["orphan-a", "orphan-b"]);
		expect(deleted).not.toContain("keep");
		expect(deleted).not.toContain("home");
	});

	test("never removes another present adapter's hotspot profile", async () => {
		addWifiInterface(PERM_MAC, makeHotspotIface({ hotspotConn: "keep" }));
		addWifiInterface(SECOND_PERM_MAC, makeHotspotIface({ ifname: "wlan1" }));
		const { deps, deleted } = makeProfileDeps([
			{
				uuid: "keep",
				name: "Hotspot",
				mode: "ap",
				ssid: "CERALIVE_791c",
				psk: "y",
				mac: PERM_MAC,
			},
			{
				uuid: "other-adapter",
				name: "Hotspot-1",
				mode: "ap",
				ssid: "CERALIVE_bbcc",
				psk: "y",
				mac: SECOND_PERM_MAC,
			},
		]);

		const removed = await pruneDuplicateHotspotConns(PERM_MAC, "keep", deps);

		expect(removed).toEqual([]);
		expect(deleted).toEqual([]);
	});

	test("a hand-made AP profile is left alone", async () => {
		addWifiInterface(PERM_MAC, makeHotspotIface({ hotspotConn: "keep" }));
		const { deps, deleted } = makeProfileDeps([
			{
				uuid: "keep",
				name: "Hotspot",
				mode: "ap",
				ssid: "CERALIVE_791c",
				psk: "y",
				mac: PERM_MAC,
			},
			{
				uuid: "manual",
				name: "My Field AP",
				mode: "ap",
				ssid: "FieldAP",
				psk: "y",
				mac: PERM_MAC,
			},
		]);

		await pruneDuplicateHotspotConns(PERM_MAC, "keep", deps);

		expect(deleted).toEqual([]);
	});
});
