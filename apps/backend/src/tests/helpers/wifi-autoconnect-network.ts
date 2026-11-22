import { spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import * as runner from "../../helpers/run.ts";
import { getConfig } from "../../modules/config.ts";
import * as nm from "../../modules/network/network-manager.ts";
import * as devices from "../../modules/wifi/wifi-device-list.ts";
import { radioIdentityReaders } from "../../modules/wifi/wifi-radio-identity.ts";
import * as compat from "../../rpc/compat.ts";
import { nmcliFieldNames, nmcliFieldOutput } from "./nmcli-field-output.ts";
import { firstApInstances } from "./wifi-first-ap-instances.ts";
import { decodeProfile, encodeProfile } from "./wifi-first-ap-keyfile-codec.ts";

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
	const deletions: string[] = [];
	const resources = new Set<string>();
	const serialized = new Map<string, string>();
	let instances: ReturnType<typeof firstApInstances> | undefined;
	const model = () => {
		instances ??= firstApInstances(resources, profiles);
		for (const [uuid, fields] of profiles) {
			const value = JSON.stringify(fields);
			if (!resources.has(uuid)) {
				resources.add(uuid);
				instances.add(uuid);
			} else if (serialized.get(uuid) !== value) instances.files.write(uuid);
			serialized.set(uuid, value);
		}
		for (const uuid of resources)
			if (!profiles.has(uuid)) resources.delete(uuid);
		return instances;
	};

	let pinAccepted = true;
	let listing: string[] = [];
	function reset(): void {
		instances?.files.close();
		instances = undefined;
		resources.clear();
		serialized.clear();
		profiles.clear();
		witnesses.clear();
		effects.length = 0;
		publications.length = 0;
		reads.length = 0;
		activations.length = 0;
		deletions.length = 0;
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
			if (fields.startsWith("GENERAL.STATE")) {
				const current = listing
					.map(nm.nmcliParseSep)
					.find(([name]) => name === ifname);
				return fields
					.split(",")
					.map((field) =>
						field === "GENERAL.STATE"
							? current?.[3]
								? "100"
								: "30"
							: field === "GENERAL.CON-UUID"
								? (current?.[3] ?? "")
								: "/org/freedesktop/NetworkManager/ActiveConnection/1",
					);
			}
			return ["Policy", "Radio", "yes", "no", "yes"];
		});
		const inventory = (fields: string) => {
			const current = model();
			return [...profiles.keys()].map((uuid) =>
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
										: field === "dbus-path"
											? (current.paths().find(([id]) => id === uuid)?.[1] ?? "")
											: field === "filename"
												? current.files.filename(uuid)
												: "",
					)
					.join(":"),
			);
		};
		spyOn(nm, "nmConnsGet").mockImplementation(async (fields) =>
			inventory(fields),
		);
		spyOn(nm, "nmScanResults").mockResolvedValue([]);
		spyOn(devices, "wifiDeviceListGetMacAddress").mockReturnValue(MAC);
		spyOn(devices, "wifiDeviceListGetInetAddress").mockReturnValue(null);
		spyOn(runner, "run").mockImplementation(async (binary, args = []) => {
			if (binary === "busctl") return model().busReply(args);
			if (binary !== "nmcli") throw new Error("Unexpected binary");
			if (
				args[0] === "--terse" &&
				args[1] === "--fields" &&
				args[3] === "connection" &&
				args[4] === "show" &&
				args.length === 5
			)
				return inventory(args[2] ?? "").join("\n");
			if (args[0] === "conn" && args[1] === "del") {
				const uuid = args[2];
				if (!uuid || !profiles.delete(uuid))
					throw new Error("Fixture profile not found");
				deletions.push(uuid);
				return `Connection 'Hotspot' (${uuid}) successfully deleted.\n`;
			}
			if (args[0] === "connection" && args[1] === "load") {
				const fields = decodeProfile(readFileSync(args[2] ?? "", "utf8"));
				const uuid = fields["connection.uuid"];
				if (!uuid) throw new Error("Missing fake loaded UUID");
				const before = profiles.get(uuid) ?? {};
				effects.push({
					uuid,
					fields: Object.fromEntries(
						Object.entries(fields).filter(
							([key, value]) => before[key] !== value,
						),
					),
					intent: getConfig().wifi_modes?.[MAC],
				});
				profiles.set(uuid, fields);
				model().bumpVersion(uuid);
				return "";
			}
			if (args[0] === "con" && args[1] === "modify") {
				const uuid = args[2] ?? "";
				model();
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
				model().files.write(uuid);
				model().bumpVersion(uuid);
				return "";
			}
			if (nmcliFieldNames(args).length > 0 && args.includes("connection")) {
				const profile = profiles.get(args.at(-1) ?? "");
				if (!profile) throw new Error("Fixture profile not found");
				return nmcliFieldOutput(
					args,
					(field) =>
						profile?.[field] ??
						(field === "802-11-wireless-security.psk-flags" ? "0" : ""),
				);
			}
			throw new Error(
				`Unexpected nmcli command: ${args.slice(0, 3).join(" ")}`,
			);
		});
		spyOn(runner, "runWithStdin").mockImplementation(
			async (binary, args, input) => {
				if (
					binary !== "nmcli" ||
					args.slice(0, 3).join(" ") !== "--offline connection modify"
				)
					throw new Error("Unexpected offline operation");
				const fields = decodeProfile(input);
				for (let i = 3; i < args.length; i += 2) {
					const key = args[i],
						value = args[i + 1];
					if (key === undefined || value === undefined)
						throw new Error("Invalid offline delta");
					fields[key] = value;
				}
				return encodeProfile(fields);
			},
		);
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
		deletions,
		reset,
		close: () => instances?.files.close(),
		install,
		list: (rows: string[]) => {
			listing = rows;
		},
		refusePin: () => {
			pinAccepted = false;
		},
	};
}
