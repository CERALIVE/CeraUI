import { spyOn } from "bun:test";
import * as fs from "node:fs";
import * as nm from "../../modules/network/network-manager.ts";
import * as profileInstance from "../../modules/network/network-manager-profile-instance.ts";
import * as concurrent from "../../modules/wifi/wifi-concurrent-interface.ts";
import { getWifiInterfacesByMacAddress } from "../../modules/wifi/wifi-connections.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../../modules/wifi/wifi-radio-identity.ts";
import { iwCreationReceipt } from "./iw-creation-receipt.ts";
import { ACTIVE_PATH, RUN_ID } from "./wifi-active-observation.ts";

const PHY = "/sys/devices/pci0000:00/0000:00:01.0/ieee80211/phy0";
const COMBINATION =
	"valid interface combinations:\n" +
	" * #{ managed, P2P-client } <= 2, #{ AP } <= 1, #{ P2P-device } <= 1,\n" +
	" total <= 3, #channels <= 1";

export async function targetFixture(
	options: {
		readonly parentIfindex?: number;
		readonly permanentMac?: string | null;
		readonly existing?: boolean;
		readonly associateRow?: boolean;
		readonly recordDiscovery?: boolean;
	} = {},
) {
	const objects = new Map([
		[
			"wlan0",
			{
				ifindex: options.parentIfindex ?? 4,
				wdev: "0x1",
				type: "managed",
				phy: PHY,
			},
		],
		["clap-wlan0", { ifindex: 7, wdev: "0x7", type: "managed", phy: PHY }],
		[
			"clap-sentinel",
			{ ifindex: 8, wdev: "0x8", type: "managed", phy: `${PHY}1` },
		],
	]);
	if (options.existing === false) objects.delete("clap-wlan0");
	const calls: string[][] = [];
	let autoconnect = "yes";
	let boot: string | undefined = "fixture-boot";
	let managed = true;
	let readableTarget = true;
	let readableProfiles = true;
	const bindings = new Map<string, string>();
	let state = "30 (disconnected)";
	let active = "";
	let station = "station-uuid";
	let frequency = 2412;
	let channel = 1;
	let flags = "";
	let reg =
		"global\ncountry 00: DFS-UNSET\n (2402 - 2472 @ 40), (6, 20), (N/A)";
	let combination = COMBINATION;
	let permanent: string | undefined =
		options.permanentMac === null
			? undefined
			: (options.permanentMac ?? "dc:a6:32:aa:bb:c0");
	let reportedTarget: {
		ifindex?: number;
		wiphy?: number;
		ifname?: string;
		frequency?: number;
		channel?: number;
	} = {};
	let reportedParentIndex: number | undefined;
	const driver = spyOn(fs, "realpathSync").mockReturnValue(
		"/sys/bus/pci/drivers/mt7925e",
	);
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) => {
		if (path === "/proc/sys/kernel/random/boot_id") return boot;
		if (path.endsWith("/index")) return "0";
		if (path.endsWith("/macaddress")) return permanent;
		if (path.endsWith("/flags"))
			return path.includes("/wlan0/") ? "0x1" : "0x0";
		const name = path.split("/").at(-2) ?? "";
		if (name === "clap-wlan0" && !readableTarget) return undefined;
		return objects.get(name)?.ifindex.toString();
	});
	spyOn(radioIdentityReaders, "realpath").mockImplementation(async (path) => {
		const name = path.split("/").at(-2) ?? "";
		return objects.get(name)?.phy;
	});
	spyOn(radioIdentityReaders, "readDevicePath").mockResolvedValue(undefined);
	spyOn(profileInstance, "nmRunId").mockResolvedValue(RUN_ID);
	spyOn(nm, "nmDeviceProp").mockImplementation(async (name, fields) =>
		fields.split(",").map((field) => {
			if (field === "GENERAL.VENDOR") return "Fixture";
			if (field === "GENERAL.PRODUCT") return "Card";
			if (field.startsWith("WIFI-PROPERTIES.")) return "yes";
			if (field === "GENERAL.STATE")
				return name === "wlan0" ? "100 (connected)" : state;
			if (field === "GENERAL.NM-MANAGED")
				return name === "wlan0" || managed ? "yes" : "no";
			if (field === "GENERAL.CON-UUID")
				return name === "wlan0" ? station : active;
			if (field === "GENERAL.CON-PATH")
				return (name === "wlan0" ? station : active) ? ACTIVE_PATH : "";
			if (field === "GENERAL.AUTOCONNECT") return autoconnect;
			return "";
		}),
	);
	spyOn(nm, "nmConnsGet").mockImplementation(async (fields) =>
		fields === "uuid,type" && readableProfiles
			? [...bindings.keys()].map((uuid) => `${uuid}:802-11-wireless`)
			: undefined,
	);
	const run: Parameters<
		typeof concurrent.setConcurrentInterfaceDepsForTest
	>[0] = async (command, args) => {
		calls.push([command, ...args]);
		if (command === "nmcli") {
			autoconnect = args.at(-1) ?? "";
			return "";
		}
		if (args.includes("add")) {
			objects.set("clap-wlan0", {
				ifindex: 7,
				wdev: "0x7",
				type: "managed",
				phy: PHY,
			});
			return iwCreationReceipt();
		}
		if (args.at(-1) === "del") {
			const entry =
				args[0] === "wdev"
					? [...objects].find(([, value]) => value.wdev === args[1])
					: [...objects].find(([name]) => name === args[1]);
			if (entry) objects.delete(entry[0]);
			return "";
		}
		if (args[0] === "reg") return reg;
		if (args[0] === "phy")
			return `Wiphy phy0\n ${combination}\n Band 1:\n * ${frequency} MHz [${channel}] (20.0 dBm) ${flags}\n`;
		if (args.length === 1 && args[0] === "dev")
			return [...objects]
				.map(
					([name, value]) =>
						`phy#${value.phy === PHY ? 0 : 1}\n Interface ${name}\n  ifindex ${value.ifindex}\n  wdev ${value.wdev}\n  type ${value.type}`,
				)
				.join("\n");
		if (args.at(-1) === "link")
			return `Connected to 04:8f:00:07:47:1d (on wlan0)\n freq: ${frequency}\n`;
		if (args.includes("station")) return "";
		const entry =
			args[0] === "wdev"
				? [...objects].find(([, value]) => value.wdev === args[1])
				: [...objects].find(([name]) => name === args[1]);
		if (!entry) throw new Error("Fixture interface absent");
		const [name, value] = entry;
		const reported = name === "clap-wlan0" ? reportedTarget : {};
		return `Interface ${reported.ifname ?? name}\n ifindex ${name === "wlan0" ? (reportedParentIndex ?? value.ifindex) : (reported.ifindex ?? value.ifindex)}\n wdev ${value.wdev}\n wiphy ${reported.wiphy ?? 0}\n type ${value.type}\n channel ${reported.channel ?? channel} (${reported.frequency ?? frequency} MHz)\n`;
	};
	concurrent.setConcurrentInterfaceDepsForTest(
		run,
		async () => state === "30 (disconnected)",
		async () => boot,
	);
	const row =
		options.associateRow === false
			? undefined
			: Object.values(getWifiInterfacesByMacAddress()).find(
					(row) => row.ifname === "wlan0",
				);
	await wifiRadioIdentity.discover([
		{ ifname: "wlan0", ...(row ? { row } : {}) },
		...[...objects.keys()]
			.filter(concurrent.isConcurrentApIfname)
			.map((ifname) => ({ ifname })),
	]);
	if (options.recordDiscovery !== false)
		await concurrent.observeConcurrentInterfacesAtFirstDiscovery(
			[...objects.keys()],
			wifiRadioIdentity.state.rows,
		);
	return {
		objects,
		calls,
		run,
		bindings,
		boot: (value: string | undefined) => {
			boot = value;
		},
		managed: (value: boolean) => {
			managed = value;
		},
		readableTarget: (value: boolean) => {
			readableTarget = value;
		},
		readableProfiles: (value: boolean) => {
			readableProfiles = value;
		},
		reportTarget: (value: typeof reportedTarget) => {
			reportedTarget = value;
		},
		reportParentIndex: (value: number) => {
			reportedParentIndex = value;
		},
		permanent: (value: string | undefined) => {
			permanent = value;
		},
		observeParent: () =>
			wifiRadioIdentity.discover([
				{ ifname: "wlan0", ...(row ? { row } : {}) },
			]),
		autoconnect: () => autoconnect,
		/** An operator or external tool changing the device setting, not a CeraUI write. */
		externalAutoconnect: (value: string) => {
			autoconnect = value;
		},
		state: (value: string) => {
			state = value;
		},
		active: (value: string) => {
			active = value;
		},
		station: (value: string) => {
			station = value;
		},
		driver: (value: string) => {
			driver.mockReturnValue(`/sys/bus/pci/drivers/${value}`);
		},
		frequency: (
			value: number,
			restrictions = "",
			announcedChannel = value === 2412 ? 1 : 128,
		) => {
			frequency = value;
			channel = announcedChannel;
			flags = restrictions;
		},
		reg: (value: string) => {
			reg = value;
		},
		combination: (value: string) => {
			combination = value;
		},
	};
}
