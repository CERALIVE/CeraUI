/*
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2022 BELABOX project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/* NetworkManager / nmcli helpers */

import { execFileP } from "../helpers/exec.ts";

export type NetworkManagerConnectionModemConfig = {
	"gsm.apn": string;
	"gsm.username": string;
	"gsm.password": string;
	"gsm.password-flags": string;
	"gsm.home-only": string;
	"gsm.network-id": string;
	"gsm.auto-config": "yes" | "no";
};

export type NetworkManagerConnection = {
	type: string;
	ifname: string;
	autoconnect: "yes" | "no";
	"connection.autoconnect-retries": number;
	"ipv6.method": string;
	"gsm.device-id": string;
	"gsm.sim-id": string;
	"gsm.sim-operator-id"?: string;
} & NetworkManagerConnectionModemConfig;

export async function nmConnAdd(connection: NetworkManagerConnection) {
	const fields = connection as Record<string, string | number>;
	try {
		let args = ["connection", "add"];
		for (const field in fields) {
			const value = fields[field];
			if (value === undefined) continue;

			args.push(field);
			args.push(String(value));
		}
		const result = await execFileP("nmcli", args);
		const success = result.stdout.match(
			/Connection '.+' \((.+)\) successfully added./,
		);

		if (success) return success[1];
	} catch (err) {
		if (err instanceof Error) {
			console.log(`nmConnNew err: ${err.message}`);
		}
	}
}

export async function nmConnsGet(fields: string) {
	try {
		const result = await execFileP("nmcli", [
			"--terse",
			"--fields",
			fields,
			"connection",
			"show",
		]);
		return result.stdout.toString().split("\n");
	} catch (err) {
		if (err instanceof Error) {
			console.log(`nmConnsGet err: ${err.message}`);
		}
	}
}

export async function nmConnGetFields(uuid: string, fields: string) {
	try {
		const result = await execFileP("nmcli", [
			"--terse",
			"--escape",
			"no",
			"--show-secrets",
			"--get-values",
			fields,
			"connection",
			"show",
			uuid,
		]);
		return result.stdout.toString().split("\n");
	} catch (err) {
		if (err instanceof Error) {
			console.log(`nmConnGetFields err: ${err.message}`);
		}
	}
}

export async function nmConnSetFields(
	uuid: string,
	fields: Record<string, string>,
) {
	try {
		let args = ["con", "modify", uuid];
		for (const field in fields) {
			args.push(field);
			args.push(fields[field]!);
		}
		const result = await execFileP("nmcli", args);
		return result.stdout === "";
	} catch (err) {
		if (err instanceof Error) {
			console.log(`nmConnSetFields err: ${err.message}`);
		}
	}
	return false;
}

export async function nmConnSetWifiMac(uuid: string, mac: string) {
	return nmConnSetFields(uuid, {
		"connection.interface-name": "",
		"802-11-wireless.mac-address": mac,
	});
}

export async function nmConnDelete(uuid: string) {
	try {
		const result = await execFileP("nmcli", ["conn", "del", uuid]);
		return result.stdout.match("successfully deleted");
	} catch (err) {
		if (err instanceof Error) {
			console.log(`nmConnDelete err: ${err.message}`);
		}
	}
	return false;
}

export async function nmConnect(uuid: string, timeout?: number) {
	try {
		const timeoutArgs = timeout ? ["-w", String(timeout)] : [];
		const result = await execFileP(
			"nmcli",
			timeoutArgs.concat(["conn", "up", uuid]),
		);
		return result.stdout.match("^Connection successfully activated");
	} catch (err) {
		if (err instanceof Error) {
			console.log(`nmConnect err: ${err.message}`);
		}
	}
	return false;
}

export async function nmDisconnect(uuid: string) {
	try {
		const result = await execFileP("nmcli", ["conn", "down", uuid]);
		return result.stdout.match("successfully deactivated");
	} catch (err) {
		if (err instanceof Error) {
			console.log(`nmDisconnect err: ${err.message}`);
		}
	}
	return false;
}

export async function nmDevices(fields: string) {
	try {
		const result = await execFileP("nmcli", [
			"--terse",
			"--fields",
			fields,
			"device",
			"status",
		]);
		return result.stdout.toString().split("\n");
	} catch (err) {
		if (err instanceof Error) {
			console.log(`nmDevices err: ${err.message}`);
		}
	}
}

export async function nmDeviceProp(device: string, fields: string) {
	try {
		const result = await execFileP("nmcli", [
			"--terse",
			"--escape",
			"no",
			"--get-values",
			fields,
			"device",
			"show",
			device,
		]);
		return result.stdout.toString().split("\n");
	} catch (err) {
		if (err instanceof Error) {
			console.log(`nmDeviceProp err: ${err.message}`);
		}
	}
}

export async function nmRescan(device?: string) {
	try {
		const args = ["device", "wifi", "rescan"];
		if (device) {
			args.push("ifname");
			args.push(device);
		}
		const result = await execFileP("nmcli", args);
		return result.stdout === "";
	} catch (err) {
		if (err instanceof Error) {
			console.log(`nmDevices err: ${err.message}`);
		}
	}
	return false;
}

export async function nmScanResults(fields: string) {
	try {
		const result = await execFileP("nmcli", [
			"--terse",
			"--fields",
			fields,
			"device",
			"wifi",
			"list",
			"--rescan",
			"no",
		]);
		return result.stdout.toString().split("\n");
	} catch (err) {
		if (err instanceof Error) {
			console.log(`nmScanResults err: ${err.message}`);
		}
	}
}

export async function nmHotspot(
	device: string,
	ssid: string,
	password: string,
	timeout?: number,
) {
	try {
		const timeoutArgs = timeout ? ["-w", String(timeout)] : [];
		const result = await execFileP(
			"nmcli",
			timeoutArgs.concat([
				"device",
				"wifi",
				"hotspot",
				"ssid",
				ssid,
				"password",
				password,
				"ifname",
				device,
			]),
		);

		const uuid = result.stdout.match(/successfully activated with '(.+)'/);
		return uuid?.[1] ?? null;
	} catch (err) {
		if (err instanceof Error) {
			console.log(`nmHotspot err: ${err.message}`);
		}
	}
}

// parses : separated values, with automatic \ escape detection and stripping
export function nmcliParseSep(value: string) {
	return value.split(/(?<!\\):/).map((a) => a.replace(/\\:/g, ":"));
}
