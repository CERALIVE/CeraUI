/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project
    

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

import { logger } from "../../helpers/logger.ts";
import { argMatch, ID_RE, run } from "../../helpers/run.ts";
import {
	handleNmcliCommand,
	shouldMockWifi,
} from "../../mocks/providers/wifi.ts";

export type ConnectionUUID = string;
export type MacAddress = string;

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
		// In mock mode, return a fake UUID for new connections
		if (shouldMockWifi()) {
			const fakeUuid = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
			logger.info(`🎭 Mock: Created fake connection ${fakeUuid}`);
			return fakeUuid;
		}

		const args = ["connection", "add"];
		for (const field in fields) {
			const value = fields[field];
			if (value === undefined) continue;

			args.push(field);
			args.push(String(value));
		}
		const stdout = await run("nmcli", args);
		const success = stdout.match(
			/Connection '.+' \((.+)\) successfully added./,
		);

		if (success) return success[1];
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`nmConnNew err: ${err.message}`);
		}
	}
}

export async function nmConnsGet(fields: string) {
	try {
		// Check for mock mode
		if (shouldMockWifi()) {
			const mockOutput = handleNmcliCommand([
				"--terse",
				"--fields",
				fields,
				"connection",
				"show",
			]);
			if (mockOutput !== null) {
				return mockOutput.split("\n");
			}
		}

		const stdout = await run("nmcli", [
			"--terse",
			"--fields",
			fields,
			"connection",
			"show",
		]);
		return stdout.split("\n");
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`nmConnsGet err: ${err.message}`);
		}
	}
}

export async function nmConnGetFields<Tupel extends Readonly<Array<string>>>(
	uuid: ConnectionUUID,
	fields: Tupel,
) {
	try {
		// Check for mock mode
		if (shouldMockWifi()) {
			const mockOutput = handleNmcliCommand([
				"--terse",
				"--escape",
				"no",
				"--show-secrets",
				"--get-values",
				fields.join(","),
				"connection",
				"show",
				uuid,
			]);
			if (mockOutput !== null) {
				return mockOutput.split("\n") as {
					[K in keyof Tupel]: string;
				};
			}
		}

		const stdout = await run("nmcli", [
			"--terse",
			"--escape",
			"no",
			"--show-secrets",
			"--get-values",
			fields.join(","),
			"connection",
			"show",
			argMatch(ID_RE, uuid),
		]);
		return stdout.split("\n") as {
			[K in keyof Tupel]: string;
		};
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`nmConnGetFields err: ${err.message}`);
		}
	}
}

export async function nmConnSetFields(
	uuid: ConnectionUUID,
	fields: Record<string, string>,
) {
	try {
		// In mock mode, simulate successful modification
		if (shouldMockWifi()) {
			logger.info(`🎭 Mock: Modified connection ${uuid}`);
			return true;
		}

		const args = ["con", "modify", argMatch(ID_RE, uuid)];
		for (const field in fields) {
			const value = fields[field];
			if (value === undefined) continue;

			args.push(field);
			args.push(value);
		}
		const stdout = await run("nmcli", args);
		return stdout === "";
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`nmConnSetFields err: ${err.message}`);
		}
	}
	return false;
}

export async function nmConnSetWifiMacAddress(
	uuid: ConnectionUUID,
	macAddress: MacAddress,
) {
	if (!macAddress) return false;

	// In mock mode, simulate successful MAC address update
	if (shouldMockWifi()) {
		logger.info(`🎭 Mock: Set MAC address ${macAddress} for ${uuid}`);
		return true;
	}

	return nmConnSetFields(uuid, {
		"connection.interface-name": "",
		"802-11-wireless.mac-address": macAddress,
	});
}

export async function nmConnDelete(uuid: ConnectionUUID) {
	try {
		// In mock mode, simulate successful deletion
		if (shouldMockWifi()) {
			logger.info(`🎭 Mock: Deleted connection ${uuid}`);
			return true;
		}

		const stdout = await run("nmcli", ["conn", "del", argMatch(ID_RE, uuid)]);
		return stdout.match("successfully deleted");
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`nmConnDelete err: ${err.message}`);
		}
	}
	return false;
}

export async function nmConnect(uuid: ConnectionUUID, timeout?: number) {
	try {
		// In mock mode, simulate successful connection
		if (shouldMockWifi()) {
			logger.info(`🎭 Mock: Activated connection ${uuid}`);
			return true;
		}

		const timeoutArgs = timeout ? ["-w", String(timeout)] : [];
		const stdout = await run(
			"nmcli",
			timeoutArgs.concat(["conn", "up", argMatch(ID_RE, uuid)]),
		);
		return stdout.match("^Connection successfully activated");
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`nmConnect err: ${err.message}`);
		}
	}
	return false;
}

export async function nmDisconnect(uuid: ConnectionUUID) {
	try {
		// In mock mode, simulate successful disconnection
		if (shouldMockWifi()) {
			logger.info(`🎭 Mock: Disconnected ${uuid}`);
			return true;
		}

		const stdout = await run("nmcli", ["conn", "down", argMatch(ID_RE, uuid)]);
		return stdout.match("successfully deactivated");
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`nmDisconnect err: ${err.message}`);
		}
	}
	return false;
}

export async function nmDevices(fields: string) {
	try {
		// Check for mock mode
		if (shouldMockWifi()) {
			const mockOutput = handleNmcliCommand([
				"--terse",
				"--fields",
				fields,
				"device",
				"status",
			]);
			if (mockOutput !== null) {
				return mockOutput.split("\n");
			}
		}

		const stdout = await run("nmcli", [
			"--terse",
			"--fields",
			fields,
			"device",
			"status",
		]);
		return stdout.split("\n");
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`nmDevices err: ${err.message}`);
		}
	}
}

export async function nmDeviceProp(device: string, fields: string) {
	try {
		// In mock mode, return mock device properties
		if (shouldMockWifi()) {
			const fieldList = fields.split(",");
			return fieldList.map((f) => {
				switch (f.trim()) {
					case "GENERAL.HWADDR":
						return "dc:a6:32:12:34:57";
					case "GENERAL.STATE":
						return "100 (connected)";
					case "GENERAL.CONNECTION":
						return "HomeNetwork";
					default:
						return "";
				}
			});
		}

		const stdout = await run("nmcli", [
			"--terse",
			"--escape",
			"no",
			"--get-values",
			fields,
			"device",
			"show",
			argMatch(ID_RE, device),
		]);
		return stdout.split("\n");
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`nmDeviceProp err: ${err.message}`);
		}
	}
}

export async function nmRescan(device?: string) {
	try {
		const args = ["device", "wifi", "rescan"];
		if (device) {
			args.push("ifname");
			args.push(argMatch(ID_RE, device));
		}

		// Check for mock mode
		if (shouldMockWifi()) {
			const mockOutput = handleNmcliCommand(args);
			if (mockOutput !== null) {
				return true;
			}
		}

		const stdout = await run("nmcli", args);
		return stdout === "";
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`nmDevices err: ${err.message}`);
		}
	}
	return false;
}

export async function nmScanResults(fields: string) {
	try {
		// Check for mock mode
		if (shouldMockWifi()) {
			const mockOutput = handleNmcliCommand([
				"--terse",
				"--fields",
				fields,
				"device",
				"wifi",
				"list",
				"--rescan",
				"no",
			]);
			if (mockOutput !== null) {
				return mockOutput.split("\n");
			}
		}

		const stdout = await run("nmcli", [
			"--terse",
			"--fields",
			fields,
			"device",
			"wifi",
			"list",
			"--rescan",
			"no",
		]);
		return stdout.split("\n");
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`nmScanResults err: ${err.message}`);
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
		// In mock mode, return a fake hotspot UUID
		if (shouldMockWifi()) {
			const fakeUuid = `hotspot-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
			logger.info(
				`🎭 Mock: Started hotspot ${ssid} on ${device} with UUID ${fakeUuid}`,
			);
			return fakeUuid;
		}

		const timeoutArgs = timeout ? ["-w", String(timeout)] : [];
		const stdout = await run(
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
				argMatch(ID_RE, device),
			]),
		);

		const uuid = stdout.match(/successfully activated with '(.+)'/);
		return uuid?.[1] ?? null;
	} catch (err) {
		if (err instanceof Error) {
			logger.error(`nmHotspot err: ${err.message}`);
		}
	}
}

// parses : separated values, with automatic \ escape detection and stripping
export function nmcliParseSep(value: string) {
	return value.split(/(?<!\\):/).map((a) => a.replace(/\\:/g, ":"));
}
