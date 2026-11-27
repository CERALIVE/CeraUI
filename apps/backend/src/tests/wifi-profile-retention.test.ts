import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import * as retry from "../helpers/retry.ts";
import * as runner from "../helpers/run.ts";
import * as nm from "../modules/network/network-manager.ts";
import * as websocket from "../modules/ui/websocket-server.ts";
import {
	handleWifi,
	type NmcliRun,
	setWifiJoinNmcliRunner,
	wifiBuildMsg,
} from "../modules/wifi/wifi.ts";
import {
	addWifiInterface,
	removeWifiInterface,
	wifiUpdateScanResult,
} from "../modules/wifi/wifi-connections.ts";
import {
	getWifiIdToMacAddress,
	type WifiInterface,
} from "../modules/wifi/wifi-interfaces.ts";
import { nmcliFieldOutput } from "./helpers/nmcli-field-output.ts";

const MAC = "02:00:00:00:51:00";
const SSID = "Fixture-Network";
const SAVED = "00000000-0000-4000-8000-000000000051";
const FRESH = "00000000-0000-4000-8000-000000000052";
const FIRST = "00000000-0000-4000-8000-000000000053";
const SECOND = "00000000-0000-4000-8000-000000000054";
const PASSWORD = "fixture-correct-password";
const SECURED_AP = "02:00:00:00:51:01";
const OPEN_AP = "02:00:00:00:51:02";
const OK: NmcliRun = { stdout: "", stderr: "", exitCode: 0 };
const REFUSED: NmcliRun = {
	stdout: "",
	stderr: "Error: Secrets were required, but not provided.",
	exitCode: 4,
};

type Profile = {
	keyMgmt: string;
	psk?: string;
	wepKey?: string;
};

let profiles: Map<string, Profile>;
let adapter: WifiInterface;
let restore = () => {};

function activate(uuid: string, security: string): NmcliRun {
	const profile = profiles.get(uuid);
	const compatible =
		security === "WEP"
			? profile?.keyMgmt === "none" && profile.wepKey === PASSWORD
			: profile?.keyMgmt === "wpa-psk" && profile.psk === PASSWORD;
	return compatible
		? {
				...OK,
				stdout: `Device 'wlan0' successfully activated with '${uuid}'.`,
			}
		: REFUSED;
}

function useTransport(security: string) {
	setWifiJoinNmcliRunner(async (args) => {
		if (args[0] === "connection" && args[1] === "modify") {
			const uuid = args[3];
			const profile = uuid ? profiles.get(uuid) : undefined;
			if (!profile) throw new Error("Unknown fixture profile");
			if (args[4] !== "802-11-wireless-security.psk")
				throw new Error("Unexpected credential field");
			profile.psk = args[5];
			return OK;
		}
		if (args.includes("connect")) {
			if (/802\.1X|ENTERPRISE|^$/i.test(security)) return REFUSED;
			const password = args[args.indexOf("password") + 1];
			// NM auto-selection can provision the requested security without
			// changing an incompatible existing profile.
			profiles.set(
				FRESH,
				security === "WEP"
					? { keyMgmt: "none", wepKey: password }
					: { keyMgmt: "wpa-psk", psk: password },
			);
			return activate(FRESH, security);
		}
		if (args.includes("up")) {
			const uuid = args[args.indexOf("uuid") + 1];
			if (!uuid) throw new Error("Missing fixture UUID");
			return activate(uuid, security);
		}
		throw new Error("Unexpected join command");
	});
}

function join(
	ssid = SSID,
	security = "WPA2",
	password = PASSWORD,
	bssid?: string,
) {
	const terminal = Promise.withResolvers<{
		success?: boolean;
		error?: string;
		device: number;
	}>();
	void handleWifi(
		{ send: (frame) => terminal.resolve(JSON.parse(frame).wifi.new) },
		{
			new: { device: 0, ssid, password, security, ...(bssid ? { bssid } : {}) },
		},
	);
	return terminal.promise;
}

beforeEach(() => {
	profiles = new Map();
	adapter = {
		id: 0,
		ifname: "wlan0",
		conn: null,
		hw: "Fixture Adapter",
		available: new Map(),
		saved: { [SSID]: SAVED },
		savedAll: { [SSID]: [SAVED] },
	};
	addWifiInterface(MAC, adapter);
	getWifiIdToMacAddress()[0] = MAC;
	const binding = spyOn(nm, "nmConnSetWifiMacAddress").mockResolvedValue(true);
	const listing = spyOn(nm, "nmConnsGet").mockResolvedValue([""]);
	const scan = spyOn(nm, "nmScanResults").mockResolvedValue([""]);
	const deletion = spyOn(nm, "nmConnDelete").mockImplementation(async (uuid) =>
		profiles.delete(uuid),
	);
	const broadcast = spyOn(websocket, "broadcastMsg").mockImplementation(
		() => {},
	);
	const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
		throw new Error("Unexpected native command");
	});
	restore = () => {
		try {
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			binding.mockRestore();
			listing.mockRestore();
			scan.mockRestore();
			deletion.mockRestore();
			broadcast.mockRestore();
			spawn.mockRestore();
		}
	};
});

afterEach(() => {
	setWifiJoinNmcliRunner(null);
	restore();
	removeWifiInterface(MAC);
	delete getWifiIdToMacAddress()[0];
});

test.each(["missing BSSID", "conflicting BSSID", "Suite B flags"] as const)(
	"an open join with %s never activates or binds a same-name secured profile",
	async (evidence) => {
		profiles.set(SAVED, { keyMgmt: "wpa-psk", psk: PASSWORD });
		const escapeBssid = (bssid: string) => bssid.replaceAll(":", "\\:");
		const openBssid = evidence === "missing BSSID" ? "" : OPEN_AP;
		const securedBssid =
			evidence === "conflicting BSSID" ? OPEN_AP : SECURED_AP;
		const ordered = [
			{ bssid: securedBssid, uuid: SAVED },
			{ bssid: openBssid, uuid: FRESH },
		];
		const openFlags =
			evidence === "Suite B flags" ? "wpa-eap-suite-b-192" : "(none)";
		const scan = spyOn(nm, "nmScanResults").mockImplementation(
			async (fields) =>
				fields.startsWith("IN-USE")
					? [
							`:${escapeBssid(openBssid)}:${SSID}:Infra:1:54 Mbit/s:90:bars:`,
							`:${escapeBssid(securedBssid)}:${SSID}:Infra:1:54 Mbit/s:40:bars:WPA2`,
						]
					: [
							`${escapeBssid(openBssid)}:${SSID}:Infra::(none):${openFlags}`,
							`${escapeBssid(securedBssid)}:${SSID}:Infra:WPA2:(none):psk`,
						],
		);
		const binding = spyOn(nm, "nmConnSetWifiMacAddress").mockResolvedValue(
			true,
		);
		const activations: string[] = [];
		setWifiJoinNmcliRunner(async (args) => {
			const target = args[args.indexOf("connect") + 1];
			const ap = ordered.find((row) => target === SSID || target === row.bssid);
			if (!ap) throw new Error("Unexpected join command");
			activations.push(ap.uuid);
			return {
				...OK,
				stdout: `Device 'wlan0' successfully activated with '${ap.uuid}'.`,
			};
		});
		try {
			await wifiUpdateScanResult();
			expect(adapter.available.get(SSID)).toMatchObject({
				security: "",
				signal: 90,
			});
			const terminal = await join(SSID, "", "", OPEN_AP);
			expect({ activations, bindings: binding.mock.calls, terminal }).toEqual({
				activations: [],
				bindings: [],
				terminal: { error: "open-target-unverified", device: 0 },
			});
			expect(profiles.get(SAVED)).toEqual({
				keyMgmt: "wpa-psk",
				psk: PASSWORD,
			});
		} finally {
			scan.mockRestore();
			binding.mockRestore();
		}
	},
);

test.each([
	"replaced",
	"secured",
	"omitted",
	"lost after verification",
] as const)(
	"an open join tracks the selected AP when its identity is %s",
	async (scenario) => {
		const replacement = "02:00:00:00:51:03";
		const selectedBssid = scenario === "omitted" ? undefined : OPEN_AP;
		const observedBssid = scenario === "replaced" ? replacement : OPEN_AP;
		const escaped = observedBssid.replaceAll(":", "\\:");
		const security =
			scenario === "secured" ? "WPA2:(none):psk" : ":(none):(none)";
		const scan = spyOn(nm, "nmScanResults").mockImplementation(
			async (fields) =>
				fields.startsWith("IN-USE")
					? [`:02\\:00\\:00\\:00\\:51\\:02:${SSID}:Infra:1:54 Mbit/s:90:bars:`]
					: [`${escaped}:${SSID}:Infra:${security}`],
		);
		const binding = spyOn(nm, "nmConnSetWifiMacAddress").mockResolvedValue(
			true,
		);
		const profileAdds: string[][] = [];
		const activations: string[][] = [];
		const otherMutations: string[][] = [];
		const frames: { success?: boolean; error?: string; device: number }[] = [];
		const terminal = Promise.withResolvers<void>();
		setWifiJoinNmcliRunner(async (args) => {
			if (args[0] === "connection" && args[1] === "add") {
				profileAdds.push(args);
				return {
					...OK,
					stdout: `Connection '${SSID}' (${FRESH}) successfully added.`,
				};
			}
			if (args.includes("up")) {
				activations.push(args);
				return scenario === "lost after verification"
					? { ...REFUSED, stderr: "Error: access point not found." }
					: { ...OK, stdout: "Connection successfully activated" };
			}
			otherMutations.push(args);
			return REFUSED;
		});
		try {
			await wifiUpdateScanResult();
			expect(adapter.available.get(SSID)).toMatchObject({
				security: "",
				signal: 90,
			});
			const request = {
				device: 0,
				ssid: SSID,
				password: "",
				security: "",
				...(selectedBssid ? { bssid: selectedBssid } : {}),
			};
			await handleWifi(
				{
					send: (frame) => {
						frames.push(JSON.parse(frame).wifi.new);
						terminal.resolve();
					},
				},
				{ new: request },
			);
			await terminal.promise;

			if (scenario === "lost after verification") {
				expect(profileAdds).toHaveLength(1);
				const add = profileAdds[0] ?? [];
				expect(add[add.indexOf("connection.autoconnect") + 1]).toBe("no");
				expect(activations).toEqual([
					["-w", "15", "conn", "up", FRESH, "ifname", "wlan0", "ap", OPEN_AP],
				]);
				expect(frames).toEqual([{ error: "generic", device: 0 }]);
			} else {
				expect({
					profileAdds,
					activations,
					binding: binding.mock.calls,
					frames,
				}).toEqual({
					profileAdds: [],
					activations: [],
					binding: [],
					frames: [{ error: "open-target-unverified", device: 0 }],
				});
			}
			expect(binding).not.toHaveBeenCalled();
			expect(otherMutations).toEqual([]);
			expect(frames.filter((frame) => frame.success)).toEqual([]);
			expect(adapter.available.get(SSID)?.bssid).toBe(OPEN_AP);
		} finally {
			scan.mockRestore();
			binding.mockRestore();
		}
	},
);

test("an open join writes no secret and pins activation to its verified AP", async () => {
	const wpa2 = { keyMgmt: "wpa-psk", psk: "fixture-wpa2-password" };
	const sae = { keyMgmt: "sae", psk: "fixture-sae-password" };
	profiles.set(SAVED, { ...wpa2 });
	profiles.set(FIRST, { ...sae });
	const listing = spyOn(nm, "nmConnsGet").mockImplementation(async () =>
		[...profiles.keys()].map((uuid) => `${uuid}:802-11-wireless`),
	);
	const reads = spyOn(runner, "run").mockImplementation(
		async (command, args) => {
			const profile = profiles.get(args.at(-1) ?? "");
			if (command !== "nmcli" || !profile)
				throw new Error("Expected a NetworkManager profile read");
			if (args.includes("--show-secrets"))
				throw new Error("Station discovery must not read secrets");
			const fields: Readonly<Record<string, string>> = {
				"802-11-wireless.mode": "infrastructure",
				"802-11-wireless.ssid": SSID,
				"802-11-wireless.mac-address": MAC,
				"802-11-wireless-security.key-mgmt": profile.keyMgmt,
			};
			return nmcliFieldOutput(args, (field) => fields[field]);
		},
	);
	const scan = spyOn(nm, "nmScanResults").mockImplementation(
		async (fields, ifname) => {
			if (!fields.startsWith("BSSID,")) return [""];
			if (ifname !== adapter.ifname)
				throw new Error("Expected the selected radio");
			return [
				`02\\:00\\:00\\:00\\:51\\:02:${SSID}:Infra::(none):(none)`,
				`02\\:00\\:00\\:00\\:51\\:01:${SSID}:Infra:WPA2:(none):psk`,
			];
		},
	);
	const binding = spyOn(nm, "nmConnSetWifiMacAddress").mockResolvedValue(true);
	const activations: { uuid: string; bssid: string }[] = [];
	setWifiJoinNmcliRunner(async (args) => {
		if (args.includes("connect")) {
			activations.push({ uuid: SAVED, bssid: SECURED_AP });
			return {
				...OK,
				stdout: `Device 'wlan0' successfully activated with '${SAVED}'.`,
			};
		}
		if (args[0] === "connection" && args[1] === "add") {
			expect(args).toContain("connection.autoconnect");
			expect(args[args.indexOf("connection.autoconnect") + 1]).toBe("no");
			expect(
				args.some((arg) => arg.startsWith("802-11-wireless-security.")),
			).toBe(false);
			profiles.set(FRESH, { keyMgmt: "" });
			return {
				...OK,
				stdout: `Connection '${SSID}' (${FRESH}) successfully added.`,
			};
		}
		const uuid = args[args.indexOf("up") + 1];
		const bssid = args[args.indexOf("ap") + 1];
		if (uuid !== FRESH || bssid !== OPEN_AP || !profiles.has(FRESH))
			return REFUSED;
		activations.push({ uuid, bssid });
		return { ...OK, stdout: "Connection successfully activated" };
	});
	try {
		expect(await join(SSID, "", "", OPEN_AP)).toEqual({
			success: true,
			device: 0,
		});
		expect(activations).toEqual([{ uuid: FRESH, bssid: OPEN_AP }]);
		expect(binding.mock.calls).toEqual([[FRESH, MAC, true]]);
		expect([...profiles]).toEqual([
			[SAVED, wpa2],
			[FIRST, sae],
			[FRESH, { keyMgmt: "" }],
		]);
		expect(wifiBuildMsg()["0"]).toMatchObject({
			saved: { [SSID]: FRESH },
			saved_key_mgmt: { [FRESH]: "" },
		});
	} finally {
		listing.mockRestore();
		reads.mockRestore();
		scan.mockRestore();
		binding.mockRestore();
	}
});

test("the backend handler refuses blank secured credentials without touching NM", async () => {
	const transport = spyOn(nm, "nmConnsGet");
	const failure = { ...REFUSED, stdout: "", stderr: "" };
	const invocations: string[][] = [];
	setWifiJoinNmcliRunner(async (args) => {
		invocations.push(args);
		return failure;
	});
	try {
		expect(await join(SSID, "SAE", "")).toEqual({
			error: "generic",
			device: 0,
		});
		expect(invocations).toEqual([]);
		expect(transport).not.toHaveBeenCalled();
	} finally {
		transport.mockRestore();
	}
});

test.each([
	["WPA2", "sae"],
	["WPA2", "wpa-eap"],
	["WPA2 802.1X", "wpa-psk"],
	["WPA3-Enterprise", "wpa-psk"],
	["WEP", "wpa-psk"],
	["", "wpa-psk"],
	["WPA2", undefined],
] as const)(
	"a %s join leaves incompatible saved %s credentials untouched",
	async (security, keyMgmt) => {
		const original = {
			keyMgmt: keyMgmt ?? "unknown",
			psk: "fixture-original-password",
		};
		profiles.set(SAVED, { ...original });
		const fields = spyOn(nm, "nmConnGetFields").mockResolvedValue(
			keyMgmt === undefined ? undefined : [keyMgmt],
		);
		useTransport(security);
		try {
			const result = await join(SSID, security);
			expect(profiles.get(SAVED)).toEqual(original);
			const provisioned = !/802\.1X|ENTERPRISE|^$/i.test(security);
			expect(result).toEqual(
				provisioned
					? { success: true, device: 0 }
					: { error: "auth", device: 0 },
			);
			expect(profiles.has(FRESH)).toBe(provisioned);
		} finally {
			fields.mockRestore();
		}
	},
);

test("a WEP password retry repairs the effective key without writing PSK", async () => {
	profiles.set(SAVED, { keyMgmt: "none", wepKey: "fixture-old-wep-key" });
	const fields = spyOn(nm, "nmConnGetFields").mockResolvedValue(["none"]);
	useTransport("WEP");
	try {
		const result = await join(SSID, "WEP");
		expect(result).toEqual({ success: true, device: 0 });
		expect([...profiles.values()].every((profile) => !profile.psk)).toBe(true);
		expect(
			[...profiles.values()].some((profile) => profile.wepKey === PASSWORD),
		).toBe(true);
	} finally {
		fields.mockRestore();
	}
});

test.each(["WPA1 WPA2", "WPA2", "WPA2-Personal", "WPA2 WPA3"])(
	"a compatible %s password retry repairs the retained UUID",
	async (security) => {
		profiles.set(SAVED, { keyMgmt: "wpa-psk", psk: "fixture-wrong-password" });
		const fields = spyOn(nm, "nmConnGetFields").mockResolvedValue(["wpa-psk"]);
		useTransport(security);
		try {
			expect(await join(SSID, security)).toEqual({ success: true, device: 0 });
			expect([...profiles]).toEqual([
				[SAVED, { keyMgmt: "wpa-psk", psk: PASSWORD }],
			]);
		} finally {
			fields.mockRestore();
		}
	},
);

const nextImmediate = setImmediate;
const nextTimer = setTimeout;

async function drainJoinWork(callCount: () => number) {
	let previous = callCount();
	let quietTurns = 0;
	for (let turn = 0; turn < 20; turn++) {
		await Promise.resolve();
		await new Promise<void>((resolve) => nextImmediate(resolve));
		await new Promise<void>((resolve) => nextTimer(resolve, 0));
		const current = callCount();
		quietTurns = current === previous ? quietTurns + 1 : 0;
		if (quietTurns === 4) return;
		previous = current;
	}
	throw new Error("Wi-Fi join activity did not settle");
}

test.each(["available", "unavailable", "throwing"] as const)(
	"overlapping failed joins retain staged and pending profiles with %s listing",
	async (availability) => {
		const firstStarted = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const firstReply = Promise.withResolvers<NmcliRun>();
		const secondReply = Promise.withResolvers<NmcliRun>();
		const firstRefresh = Promise.withResolvers<void>();
		const secondRefresh = Promise.withResolvers<void>();
		const events: (
			| { readonly reply: string; readonly value: unknown }
			| { readonly refresh: "published" | "exhausted" }
		)[] = [];
		let refreshes = 0;
		const finishRefresh = (result: "published" | "exhausted") => {
			events.push({ refresh: result });
			(refreshes++ === 0 ? firstRefresh : secondRefresh).resolve();
		};
		const broadcast = spyOn(websocket, "broadcastMsg").mockImplementation(() =>
			finishRefresh("published"),
		);
		const poll = retry.pollWithBackoff;
		const inventory = spyOn(retry, "pollWithBackoff").mockImplementation(
			<T>(
				read: () => Promise<T | null | undefined>,
				options: Parameters<typeof poll<T>>[1],
			) =>
				poll(read, {
					...options,
					onExhausted: (error) => {
						options.onExhausted?.(error);
						finishRefresh("exhausted");
					},
				}),
		);
		const deletion = spyOn(nm, "nmConnDelete").mockImplementation(
			async (uuid) => {
				if (availability === "throwing")
					throw new Error("Fixture delete transport unavailable");
				return profiles.delete(uuid);
			},
		);
		profiles.set(SAVED, { keyMgmt: "wpa-psk", psk: "fixture-staged" });
		const listing = spyOn(nm, "nmConnsGet").mockImplementation(
			async (fields) => {
				const names = fields.split(",");
				const fieldSet = names.toSorted().join(",");
				if (fieldSet !== "type,uuid" && fieldSet !== "timestamp,type,uuid")
					throw new Error("Unexpected profile listing fields");
				if (availability === "throwing")
					throw new Error("Fixture list transport unavailable");
				return availability === "available"
					? [...profiles.keys()].map((uuid) => {
							const values: Readonly<Record<string, string>> = {
								uuid,
								type: "802-11-wireless",
								timestamp: "0",
							};
							return names.map((name) => values[name]).join(":");
						})
					: undefined;
			},
		);
		const fields = spyOn(nm, "nmConnGetFields").mockResolvedValue([
			"infrastructure",
			SSID,
			MAC,
		]);
		setWifiJoinNmcliRunner(async (args) => {
			const ssid = args[args.indexOf("connect") + 1];
			if (ssid === "Fixture-First") {
				profiles.set(FIRST, { keyMgmt: "wpa-psk" });
				firstStarted.resolve();
				return firstReply.promise;
			}
			if (ssid !== "Fixture-Second") throw new Error("Unexpected join");
			profiles.set(SECOND, { keyMgmt: "wpa-psk" });
			secondStarted.resolve();
			return secondReply.promise;
		});
		const startJoin = (ssid: string) => {
			const terminal = Promise.withResolvers<void>();
			// A secured join dispatches without returning its promise. Await
			// its terminal and refresh receipts as well as any returned promise.
			const handler = handleWifi(
				{
					send: (frame) => {
						events.push({ reply: ssid, value: JSON.parse(frame).wifi.new });
						terminal.resolve();
					},
				},
				{ new: { device: 0, ssid, password: PASSWORD, security: "WPA2" } },
			);
			return { handler, terminal: terminal.promise };
		};
		// A continuation can schedule more work without issuing an NM command
		// yet. Count those schedules too, but not the drain's own checkpoints.
		const immediate = spyOn(globalThis, "setImmediate");
		const timer = spyOn(globalThis, "setTimeout");
		const microtask = spyOn(globalThis, "queueMicrotask");
		try {
			const first = startJoin("Fixture-First");
			await firstStarted.promise;
			const second = startJoin("Fixture-Second");
			await secondStarted.promise;
			firstReply.resolve(REFUSED);
			await Promise.all([first.terminal, firstRefresh.promise]);
			const whileSecondPending = [...profiles.keys()];
			secondReply.resolve(REFUSED);
			await Promise.all([
				first.handler,
				second.handler,
				second.terminal,
				secondRefresh.promise,
			]);
			await Promise.all(inventory.mock.results.map((result) => result.value));
			await drainJoinWork(
				() =>
					events.length +
					inventory.mock.calls.length +
					listing.mock.calls.length +
					fields.mock.calls.length +
					deletion.mock.calls.length +
					immediate.mock.calls.length +
					timer.mock.calls.length +
					microtask.mock.calls.length,
			);

			expect(whileSecondPending).toEqual([SAVED, FIRST, SECOND]);
			expect([...profiles.keys()]).toEqual([SAVED, FIRST, SECOND]);
			// Reconciliation may list profiles; failure is not authority to
			// inspect activation timestamps for cleanup or request deletion.
			const cleanupQueries = listing.mock.calls
				.map(([fields]) => fields)
				.filter((fields) =>
					fields
						.split(",")
						.some((field) => field.trim().toLowerCase() === "timestamp"),
				);
			expect(cleanupQueries).toEqual([]);
			expect(deletion).not.toHaveBeenCalled();
			const available = availability === "available";
			const auth = { error: "auth", device: 0 };
			const refresh = {
				refresh: available ? "published" : "exhausted",
			} as const;
			expect(events).toEqual([
				{ reply: "Fixture-First", value: auth },
				refresh,
				{ reply: "Fixture-Second", value: auth },
				refresh,
			]);
			expect(inventory).toHaveBeenCalledTimes(2);
			expect(listing).toHaveBeenCalledTimes(available ? 2 : 6);
			expect(broadcast).toHaveBeenCalledTimes(available ? 2 : 0);
			expect(wifiBuildMsg()["0"]?.saved).toEqual({
				[SSID]: available ? SECOND : SAVED,
			});
			expect(adapter.savedAll).toEqual({
				[SSID]: available ? [SAVED, FIRST, SECOND] : [SAVED],
			});
		} finally {
			firstReply.resolve(REFUSED);
			secondReply.resolve(REFUSED);
			microtask.mockRestore();
			timer.mockRestore();
			immediate.mockRestore();
			deletion.mockRestore();
			listing.mockRestore();
			fields.mockRestore();
			broadcast.mockRestore();
			inventory.mockRestore();
		}
	},
);
