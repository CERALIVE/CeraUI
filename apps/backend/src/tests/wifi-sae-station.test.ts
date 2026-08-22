/*
  WPA3-SAE station join — the profile is BUILT with `key-mgmt sae`, and only
  when the AP leaves no other leg.

  `nmcli device wifi connect` has no argument that can state a key management,
  so a SAE-only AP cannot be joined through it: NetworkManager picks, and a
  profile that came out `wpa-psk` has already failed to activate by the time
  anything could correct it. The SAE join therefore takes the two-step form that
  CAN state it — `connection add … 802-11-wireless-security.key-mgmt sae` then
  `connection up`.

  Everything else keeps the single-step path BYTE-FOR-BYTE, which is the half
  worth locking hardest: a WPA2 network, an open network, an enterprise network
  and — the one that is easy to get wrong — a WPA2/WPA3 TRANSITION network,
  which accepts a plain WPA2 association and would be broken by a pinned `sae`.

  The whole join is driven over the injected nmcli runner, so no NetworkManager
  is touched and every assertion is on argv.
*/

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	classifyWifiStationSecurity,
	requiresSaeKeyMgmt,
	wifiJoinRefusal,
} from "@ceraui/rpc";
import type { MessageSocket } from "../modules/ui/message-socket.ts";
import {
	handleWifi,
	type NmcliRun,
	setWifiJoinNmcliRunner,
	wifiDeleteFailedConns,
} from "../modules/wifi/wifi.ts";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import {
	getWifiIdToMacAddress,
	type MacAddress,
	type WifiInterface,
} from "../modules/wifi/wifi-interfaces.ts";
import {
	planWifiStationJoin,
	SAE_STATION_NM_FIELDS,
	stationSecurityFields,
} from "../modules/wifi/wifi-station-security.ts";

const ADAPTER: MacAddress = "aa:bb:cc:dd:ee:77";
const IFNAME = "wlan0";
const SSID = "CeraLive-WPA3";
const PASSWORD = "correct horse battery";
const NEW_UUID = "6f0c2f4a-9d2e-4b0f-9a11-0b6a1c9d5e33";

/** nmcli's own confirmation lines, verbatim in shape. */
const ADDED = `Connection '${SSID}' (${NEW_UUID}) successfully added.\n`;
const ACTIVATED =
	"Connection successfully activated (D-Bus active path: /org/freedesktop/NetworkManager/ActiveConnection/9)\n";
const CONNECTED = `Device '${IFNAME}' successfully activated with '${NEW_UUID}'.\n`;

function makeInterface(): WifiInterface {
	return {
		id: 0,
		ifname: IFNAME,
		conn: null,
		hw: "Test Adapter",
		available: new Map(),
		saved: {},
		savedAll: {},
	};
}

let calls: string[][] = [];
let replies: NmcliRun[] = [];

function socket(): MessageSocket {
	return { send: () => {} };
}

/** Drive the real `handleWifi` join path and return every nmcli argv it issued. */
async function join(security: string | undefined): Promise<string[][]> {
	handleWifi(socket(), {
		new: {
			device: 0,
			ssid: SSID,
			password: PASSWORD,
			...(security !== undefined ? { security } : {}),
		},
	});
	// `wifiNew` dispatches its work with `void`; let the microtask chain settle.
	for (let i = 0; i < 20; i++) await Promise.resolve();
	return calls;
}

beforeEach(() => {
	calls = [];
	replies = [];
	addWifiInterface(ADAPTER, makeInterface());
	getWifiIdToMacAddress()[0] = ADAPTER;
	setWifiJoinNmcliRunner(async (args) => {
		calls.push(args);
		// The default reply is a clean exit that names no uuid, so an argv-only
		// test settles at the "nothing to activate" warn and never reaches the
		// post-success tail (which would spawn a real nmcli).
		return replies.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
	});
});

afterEach(() => {
	setWifiJoinNmcliRunner(null);
	delete getWifiIdToMacAddress()[0];
	removeWifiInterface(ADAPTER);
	// `bun test` is ONE process: a leaked adapter joins every later file's
	// `status` snapshot (see the notepad's leaked-module-state note).
	expect(getWifiInterfacesByMacAddress()[ADAPTER]).toBeUndefined();
});

describe("the shared SAE rule", () => {
	test.each([
		["", "open"],
		["WPA2", "other"],
		["WPA1 WPA2", "other"],
		["WPA2-Personal", "other"],
		["WPA2 802.1X", "other"],
		["WPA3", "sae-only"],
		["SAE", "sae-only"],
		["WPA3-Personal", "sae-only"],
		["WPA2 WPA3", "sae-transition"],
		["WPA1 WPA2 WPA3", "sae-transition"],
		["WPA3-Enterprise", "other"],
		["WPA3 802.1X", "other"],
		["OWE", "other"],
	])("classifies %p as %p", (security, expected) => {
		expect(classifyWifiStationSecurity(security)).toBe(expected as never);
	});

	test("only a SAE-ONLY network pins key-mgmt", () => {
		expect(requiresSaeKeyMgmt("WPA3")).toBe(true);
		// A transition AP accepts a plain WPA2 association — pinning `sae` there
		// would refuse the leg a SAE-incapable adapter actually uses.
		expect(requiresSaeKeyMgmt("WPA2 WPA3")).toBe(false);
		expect(requiresSaeKeyMgmt("WPA2")).toBe(false);
		expect(requiresSaeKeyMgmt(undefined)).toBe(false);
	});

	test("the nmcli field set carries key-mgmt AND pmf, together", () => {
		// SAE mandates protected management frames; a `sae` profile left on
		// `pmf: disable` is refused by NetworkManager at activation.
		expect(stationSecurityFields("WPA3")).toEqual({
			"802-11-wireless-security.key-mgmt": "sae",
			"802-11-wireless-security.pmf": "required",
		});
		expect(stationSecurityFields("WPA2")).toEqual({});
		expect(stationSecurityFields("WPA2 WPA3")).toEqual({});
	});

	test("a join refusal needs POSITIVE disproof — `unknown` fails open", () => {
		expect(wifiJoinRefusal("WPA3", "unsupported")).toBe("sae-unsupported");
		// The shipped fleet's answer under NM 1.42.4.
		expect(wifiJoinRefusal("WPA3", "unknown")).toBeUndefined();
		expect(wifiJoinRefusal("WPA3", "supported")).toBeUndefined();
		expect(wifiJoinRefusal("WPA3", undefined)).toBeUndefined();
		// A transition network has a WPA2 leg, so it is never withheld.
		expect(wifiJoinRefusal("WPA2 WPA3", "unsupported")).toBeUndefined();
		expect(wifiJoinRefusal("WPA2", "unsupported")).toBeUndefined();
	});
});

describe("a SAE-only network is BUILT with key-mgmt sae", () => {
	test("the profile field set includes sae, with pmf beside it", async () => {
		replies = [
			{ stdout: ADDED, stderr: "", exitCode: 0 },
			{ stdout: ACTIVATED, stderr: "", exitCode: 0 },
		];

		const issued = await join("WPA3");

		expect(issued).toHaveLength(2);
		const add = issued[0] as string[];
		expect(add.slice(0, 2)).toEqual(["connection", "add"]);

		// The assertion that matters: the field set nmcli is handed pins SAE.
		const fields = argvFields(add);
		expect(fields["802-11-wireless-security.key-mgmt"]).toBe("sae");
		expect(fields["802-11-wireless-security.pmf"]).toBe("required");
		expect(fields["802-11-wireless-security.psk"]).toBe(PASSWORD);
		expect(fields.type).toBe("wifi");
		expect(fields.ifname).toBe(IFNAME);
		expect(fields.ssid).toBe(SSID);

		// …and it is the profile just built that gets activated.
		expect(issued[1]).toEqual(["-w", "15", "conn", "up", NEW_UUID]);
	});

	test("nmcli reads `type` first, so it must be the first pair", () => {
		const plan = planWifiStationJoin({
			ssid: SSID,
			ifname: IFNAME,
			password: PASSWORD,
			security: "WPA3",
		});
		if (plan.mode !== "sae") throw new Error("expected the sae plan");
		expect(plan.addArgs.slice(0, 4)).toEqual([
			"connection",
			"add",
			"type",
			"wifi",
		]);
	});

	test("a passwordless SAE request degrades rather than building a keyless profile", () => {
		const plan = planWifiStationJoin({
			ssid: SSID,
			ifname: IFNAME,
			security: "WPA3",
		});
		expect(plan.mode).toBe("nm-auto");
	});

	test("a failed activation reports the typed auth refusal, not a generic one", async () => {
		replies = [
			{ stdout: ADDED, stderr: "", exitCode: 0 },
			{
				stdout: "",
				stderr: "Error: Secrets were required, but not provided.",
				exitCode: 4,
			},
		];
		const sent: { wifi?: { new?: { error?: string } } }[] = [];

		handleWifi(
			{ send: (message: string) => sent.push(JSON.parse(message)) },
			{ new: { device: 0, ssid: SSID, password: PASSWORD, security: "WPA3" } },
		);
		// The failure path awaits `wifiDeleteFailedConns()` before it answers, so
		// this settles on a real timer rather than a microtask drain.
		await waitFor(() => sent.length > 0);

		expect(sent.at(-1)?.wifi?.new?.error).toBe("auth");
	});
});

describe("everything else keeps the single-step path, unchanged", () => {
	test.each([
		["a WPA2 network", "WPA2"],
		["a WPA2/WPA3 transition network", "WPA2 WPA3"],
		["an enterprise network", "WPA2 802.1X"],
		["an open network", ""],
		["a client that states no security at all", undefined],
	])("%s issues ONE `device wifi connect` and never `sae`", async (_, sec) => {
		const issued = await join(sec as string | undefined);

		expect(issued).toHaveLength(1);
		expect(issued[0]).toEqual([
			"-w",
			"15",
			"device",
			"wifi",
			"connect",
			SSID,
			"ifname",
			IFNAME,
			"password",
			PASSWORD,
		]);
		expect(JSON.stringify(issued)).not.toContain("sae");
		expect(JSON.stringify(issued)).not.toContain("connection");
	});

	test("a WPA2 join still reports success off nmcli's own activation line", async () => {
		replies = [{ stdout: CONNECTED, stderr: "", exitCode: 0 }];
		const sent: { wifi?: { new?: { success?: boolean } } }[] = [];

		handleWifi(
			{ send: (message: string) => sent.push(JSON.parse(message)) },
			{ new: { device: 0, ssid: SSID, password: PASSWORD, security: "WPA2" } },
		);
		await waitFor(() => sent.length > 0);

		expect(sent.at(-1)?.wifi?.new?.success).toBe(true);
	});
});

test("adapter id 0 is a real adapter, not an absent one", async () => {
	// `wifiIfId` starts at 0, so a truthiness guard on `device` drops the FIRST
	// adapter of every single-radio board — and the procedure's mock branch
	// fabricates success regardless, which is how it stayed invisible.
	expect(await join("WPA2")).toHaveLength(1);
});

/*
  The cleanup `runWifiNew` awaits before it can report a failed join.

  `nmConnsGet` signals its own failure by resolving `undefined` rather than
  throwing — which is exactly what a host with no `nmcli` on `$PATH` produces —
  so the sweep must treat a non-list as "nothing to enumerate". It used to cast
  the result to an array and iterate it, and the resulting
  `undefined is not an object` escaped through the very failure path that owed
  the operator a typed refusal.
*/
describe("wifiDeleteFailedConns", () => {
	const listed = [
		"keep-me:802-11-wireless:1712345678",
		"never-activated:802-11-wireless:0",
		"a-modem:gsm:0",
		"",
	];

	test("an unlistable nmcli is survived, and deletes nothing", async () => {
		const deleted: string[] = [];

		await wifiDeleteFailedConns({
			listConns: async () => undefined,
			deleteConn: async (uuid) => {
				deleted.push(uuid);
				return true;
			},
		});

		expect(deleted).toEqual([]);
	});

	test("a listable nmcli still deletes exactly the never-activated wifi profiles", async () => {
		const deleted: string[] = [];

		await wifiDeleteFailedConns({
			listConns: async (fields) => {
				expect(fields).toBe("uuid,type,timestamp");
				return listed;
			},
			deleteConn: async (uuid) => {
				deleted.push(uuid);
				return true;
			},
		});

		expect(deleted).toEqual(["never-activated"]);
	});
});

test("the SAE field record is the one both halves share", () => {
	// A second spelling of these two fields is how the AP and station sides
	// drift; `stationSecurityFields` returns a copy of exactly this record.
	expect(stationSecurityFields("WPA3")).toEqual({ ...SAE_STATION_NM_FIELDS });
});

async function waitFor(done: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!done()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for a frame");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** `[k1, v1, k2, v2, …]` after the leading verb pair. */
function argvFields(argv: string[]): Record<string, string> {
	const fields: Record<string, string> = {};
	for (let i = 2; i < argv.length; i += 2) {
		const key = argv[i];
		const value = argv[i + 1];
		if (key !== undefined && value !== undefined) fields[key] = value;
	}
	return fields;
}
