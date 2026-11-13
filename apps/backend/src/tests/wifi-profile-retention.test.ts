import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { logger } from "../helpers/logger.ts";
import * as nm from "../modules/network/network-manager.ts";
import * as websocket from "../modules/ui/websocket-server.ts";
import {
	handleWifi,
	type NmcliRun,
	setWifiJoinNmcliRunner,
} from "../modules/wifi/wifi.ts";
import {
	addWifiInterface,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import {
	getWifiIdToMacAddress,
	type WifiInterface,
} from "../modules/wifi/wifi-interfaces.ts";

const MAC = "02:00:00:00:51:00";
const SSID = "Fixture-Network";
const SAVED = "00000000-0000-4000-8000-000000000051";
const FRESH = "00000000-0000-4000-8000-000000000052";
const FIRST = "00000000-0000-4000-8000-000000000053";
const SECOND = "00000000-0000-4000-8000-000000000054";
const PASSWORD = "fixture-correct-password";
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
			// NM auto-selection can provision the requested security without
			// changing an incompatible existing profile.
			profiles.set(
				FRESH,
				security === "WEP"
					? { keyMgmt: "none", wepKey: PASSWORD }
					: { keyMgmt: "wpa-psk", psk: PASSWORD },
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

function join(ssid = SSID, security = "WPA2") {
	const terminal = Promise.withResolvers<{
		success?: boolean;
		error?: string;
		device: number;
	}>();
	handleWifi(
		{ send: (frame) => terminal.resolve(JSON.parse(frame).wifi.new) },
		{ new: { device: 0, ssid, password: PASSWORD, security } },
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

test.each(["available", "unavailable"] as const)(
	"overlapping failed joins retain staged and pending profiles with %s listing",
	async (availability) => {
		const firstStarted = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const firstReply = Promise.withResolvers<NmcliRun>();
		const secondReply = Promise.withResolvers<NmcliRun>();
		const firstRefresh = Promise.withResolvers<void>();
		const secondRefresh = Promise.withResolvers<void>();
		let refreshes = 0;
		const finishRefresh = () => {
			(refreshes++ === 0 ? firstRefresh : secondRefresh).resolve();
		};
		const broadcast = spyOn(websocket, "broadcastMsg").mockImplementation(
			finishRefresh,
		);
		const debug = spyOn(logger, "debug").mockImplementation((message) => {
			if (String(message).startsWith("wifiUpdateSavedConns: list failed"))
				finishRefresh();
			return logger;
		});
		profiles.set(SAVED, { keyMgmt: "wpa-psk", psk: "fixture-staged" });
		const listing = spyOn(nm, "nmConnsGet").mockImplementation(async () => {
			return availability === "available"
				? [...profiles.keys()].map((uuid) => `${uuid}:802-11-wireless`)
				: undefined;
		});
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
		try {
			const first = join("Fixture-First");
			await firstStarted.promise;
			const second = join("Fixture-Second");
			await secondStarted.promise;
			firstReply.resolve(REFUSED);
			expect(await first).toEqual({ error: "auth", device: 0 });
			await firstRefresh.promise;
			const whileSecondPending = [...profiles.keys()];
			secondReply.resolve(REFUSED);
			expect(await second).toEqual({ error: "auth", device: 0 });
			await secondRefresh.promise;
			expect(whileSecondPending).toEqual([SAVED, FIRST, SECOND]);
			expect([...profiles.keys()]).toEqual([SAVED, FIRST, SECOND]);
		} finally {
			firstReply.resolve(REFUSED);
			secondReply.resolve(REFUSED);
			listing.mockRestore();
			fields.mockRestore();
			broadcast.mockRestore();
			debug.mockRestore();
		}
	},
);
