import { spyOn } from "bun:test";
import * as runner from "../../helpers/run.ts";
import {
	ownsWifiAdapterLock,
	wifiAdapterLockKey,
} from "../../modules/wifi/wifi-adapter-lock.ts";
import { nmcliFieldNames, nmcliFieldOutput } from "./nmcli-field-output.ts";
import { wifiFrameFixture } from "./wifi-frame-fixture.ts";

export async function profileRefreshFixture() {
	const frame = await wifiFrameFixture(false);
	const mac = "dc:a6:32:aa:bb:c0";
	const uuid = "observed-ap";
	const fields: Record<string, string> = {
		"connection.interface-name": "wlan0",
		"connection.autoconnect": "yes",
		"connection.autoconnect-priority": "999",
		"802-11-wireless.mode": "ap",
		"802-11-wireless.ssid": "Original AP",
		"802-11-wireless-security.psk": "original-password",
		"802-11-wireless.mac-address": "02:00:00:00:00:99",
		"802-11-wireless.band": "",
		"802-11-wireless.channel": "0",
		"802-11-wireless.hidden": "no",
		"802-11-wireless-security.key-mgmt": "wpa-psk",
		"802-11-wireless-security.pairwise": "ccmp",
		"802-11-wireless-security.group": "ccmp",
		"802-11-wireless-security.proto": "rsn",
		"802-11-wireless-security.pmf": "1",
		"ipv4.method": "shared",
		"ipv6.method": "ignore",
	};
	const writes: {
		readonly uuid: string;
		readonly fields: Record<string, string>;
		readonly ownsLock: boolean;
	}[] = [];
	spyOn(runner, "run").mockImplementation(async (command, args) => {
		if (command === "busctl") {
			return args.includes("GetId")
				? 's "0123456789abcdef0123456789abcdef"'
				: 's ":1.42"';
		}
		if (command !== "nmcli")
			throw new Error(`Unexpected profile-refresh command: ${command}`);
		if (nmcliFieldNames(args).length)
			return nmcliFieldOutput(args, (field) => fields[field] ?? "");
		if (args[0] === "con" && args[1] === "modify") {
			const update: Record<string, string> = {};
			for (let index = 3; index < args.length; index += 2) {
				const key = args[index];
				const value = args[index + 1];
				if (key && value !== undefined) update[key] = value;
			}
			writes.push({
				uuid: args[2] ?? "",
				fields: update,
				ownsLock: ownsWifiAdapterLock(wifiAdapterLockKey(mac)),
			});
			Object.assign(fields, update);
			return "";
		}
		if (args[2] === "uuid,type") return `${uuid}:802-11-wireless`;
		if (args[2] === "uuid,dbus-path")
			return `${uuid}:/org/freedesktop/NetworkManager/Settings/1`;
		if (args[2] === "uuid,filename") return `${uuid}:`;
		throw new Error("Unexpected profile-refresh NM request");
	});
	return { ...frame, mac, uuid, fields, writes };
}
