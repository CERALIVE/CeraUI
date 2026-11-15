import { spyOn } from "bun:test";
import * as runner from "../../helpers/run.ts";
import { getConfig } from "../../modules/config.ts";
import * as nm from "../../modules/network/network-manager.ts";
import * as devices from "../../modules/wifi/wifi-device-list.ts";
import { radioIdentityReaders } from "../../modules/wifi/wifi-radio-identity.ts";
import * as compat from "../../rpc/compat.ts";

export const MAC = "58:02:05:e1:79:1c";
export const PORT = "platform-a40800000.pcie-pci-0002:21:00.0";
export const PROFILE = "policy-ap";
export type Witness = {
	ifindex: number;
	phy: string;
	mac?: string;
	path?: string;
};

export function autoconnectNetworkFixture() {
	const profiles = new Map<string, Record<string, string>>();
	const witnesses = new Map<string, Witness>();
	const effects: Array<{
		uuid: string;
		fields: Record<string, string>;
		intent: unknown;
	}> = [];
	const publications: string[] = [];
	const reads: string[] = [];
	const activations: string[] = [];

	let pinAccepted = true;
	let listing: string[] = [];
	function reset(): void {
		profiles.clear();
		witnesses.clear();
		effects.length = 0;
		publications.length = 0;
		reads.length = 0;
		activations.length = 0;
		pinAccepted = true;
		listing = [];
	}
	function install(): void {
		spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) => {
			reads.push(path);
			for (const [ifname, w] of witnesses) {
				if (path === `/sys/class/net/${ifname}/ifindex`)
					return String(w.ifindex);
				if (path === `${w.phy}/index`) return "0";
				if (path === `${w.phy}/macaddress`) return w.mac;
			}
			return undefined;
		});
		spyOn(radioIdentityReaders, "realpath").mockImplementation(async (path) => {
			const ifname = path.split("/")[4];
			return ifname ? witnesses.get(ifname)?.phy : undefined;
		});
		spyOn(nm, "nmDevices").mockImplementation(async () => [...listing]);
		spyOn(nm, "nmDeviceProp").mockImplementation(async (ifname, fields) => {
			if (fields === "GENERAL.PATH") {
				reads.push(`path:${ifname}`);
				const path = witnesses.get(ifname)?.path;
				return path === undefined ? undefined : [path];
			}
			return ["Policy", "Radio", "yes", "no", "yes"];
		});
		spyOn(nm, "nmConnsGet").mockImplementation(async (fields) =>
			[...profiles.keys()].map((uuid) =>
				fields
					.split(",")
					.map((field) =>
						field === "uuid"
							? uuid
							: field === "active"
								? listing.some((raw) => nm.nmcliParseSep(raw)[3] === uuid)
									? "yes"
									: "no"
								: field === "type"
									? "802-11-wireless"
									: field === "name"
										? "Hotspot"
										: "",
					)
					.join(":"),
			),
		);
		spyOn(nm, "nmScanResults").mockResolvedValue([]);
		spyOn(devices, "wifiDeviceListGetMacAddress").mockReturnValue(MAC);
		spyOn(devices, "wifiDeviceListGetInetAddress").mockReturnValue(null);
		spyOn(runner, "run").mockImplementation(async (binary, args = []) => {
			if (binary !== "nmcli") throw new Error("Unexpected binary");
			if (args[0] === "con" && args[1] === "modify") {
				const uuid = args[2] ?? "";
				const fields = Object.fromEntries(
					Array.from({ length: (args.length - 3) / 2 }, (_, i) => [
						args[3 + 2 * i] ?? "",
						args[4 + 2 * i] ?? "",
					]),
				);
				effects.push({ uuid, fields, intent: getConfig().wifi_modes?.[MAC] });
				if (fields["802-11-wireless.mac-address"] && !pinAccepted)
					throw new Error("Pin refused");
				Object.assign(profiles.get(uuid) ?? {}, fields);
				return "";
			}
			const at = args.indexOf("--get-values");
			if (at >= 0 && args[at + 2] === "connection") {
				const profile = profiles.get(args[at + 4] ?? "");
				return (args[at + 1] ?? "")
					.split(",")
					.map((field) => profile?.[field] ?? "")
					.join("\n");
			}
			throw new Error(
				`Unexpected nmcli command: ${args.slice(0, 3).join(" ")}`,
			);
		});
		spyOn(compat, "broadcastMsg").mockImplementation(() => {
			publications.push(
				profiles.get(PROFILE)?.["connection.autoconnect"] ?? "",
			);
		});
	}
	return {
		profiles,
		witnesses,
		effects,
		publications,
		reads,
		activations,
		reset,
		install,
		list: (rows: string[]) => {
			listing = rows;
		},
		refusePin: () => {
			pinAccepted = false;
		},
	};
}
