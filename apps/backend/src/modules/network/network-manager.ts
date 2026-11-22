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
import { argMatch, ID_RE, RunTimeoutError, run } from "../../helpers/run.ts";
import {
	handleNmcliCommand,
	shouldMockWifi,
} from "../../mocks/providers/wifi.ts";
import {
	describeCliError,
	logParseError,
	type ParseResult,
	parseFail,
	parseOk,
} from "../system/cli-parse.ts";
import {
	type HotspotProfileOperation,
	type HotspotProfileOperationResult,
	runHotspotProfileOperation,
} from "../wifi/wifi-hotspot-profile-operation.ts";
import { parseNmcliFields } from "./network-manager-output.ts";
import type { NmProfileReadTrace } from "./network-manager-profile-diagnostics.ts";
import {
	type NmProfileInstance,
	readNmProfileInstance,
	sameNmProfileResource,
} from "./network-manager-profile-instance.ts";
import { writeNmWifiSecret } from "./network-manager-secret.ts";

export { nmcliParseSep } from "./network-manager-output.ts";

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
		const parsed = parseNmConnAddUuid(stdout);
		if (parsed.ok) return parsed.value;
		logParseError(parsed);
	} catch (err) {
		// argv carries gsm.password — keep the redacted-by-logger message, never
		// surface stderr/argv which could echo the secret.
		if (err instanceof Error) {
			logger.error(`nmConnNew err: ${err.message}`);
		}
	}
	return undefined;
}

async function readNmFields(
	fields: string,
	command: string[],
	secrets = false,
) {
	const names = fields.split(",");
	const args = [
		"--mode",
		"multiline",
		"--terse",
		"--escape",
		"no",
		...(secrets ? ["--show-secrets"] : []),
		"--fields",
		fields,
		...command,
	];
	const mock = shouldMockWifi() ? handleNmcliCommand(args) : null;
	const stdout = mock ?? (await run("nmcli", args));
	const row = parseNmcliFields(stdout, names);
	if (!row?.size) throw new Error("NM named-field output rejected");
	return row;
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
	} catch {
		logger.error("nmConnsGet: profile inventory failed");
	}
	return undefined;
}

/** Native --get-values terminates each record with LF, including empty values. */
function splitNmValues(stdout: string): string[] {
	return (stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout).split("\n");
}

export async function nmConnGetFields<Tupel extends Readonly<Array<string>>>(
	uuid: ConnectionUUID,
	fields: Tupel,
	layout?: "fixed",
) {
	try {
		if (
			layout !== "fixed" &&
			new Set(fields.map((field) => field.split(".")[0])).size > 1
		) {
			const row = await readNmFields(
				fields.join(","),
				["connection", "show", argMatch(ID_RE, uuid)],
				true,
			);
			return fields.map((field) => row.get(field.toLowerCase()) ?? "") as {
				[K in keyof Tupel]: string;
			};
		}
		// A single setting cannot omit an intervening setting's value.
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
			if (mockOutput !== null)
				return mockOutput.split("\n") as {
					[K in keyof Tupel]: string;
				};
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
		return splitNmValues(stdout) as {
			[K in keyof Tupel]: string;
		};
	} catch {
		logger.error("nmConnGetFields: profile read failed");
	}
	return undefined;
}

export async function nmConnSetFields(
	uuid: ConnectionUUID,
	fields: Record<string, string>,
	permit?: () => Promise<boolean>,
) {
	try {
		// In mock mode, simulate successful modification
		if (shouldMockWifi()) {
			logger.info(`🎭 Mock: Modified connection ${uuid}`);
			return true;
		}

		if (fields["802-11-wireless-security.psk"] !== undefined)
			return await writeNmWifiSecret(argMatch(ID_RE, uuid), fields, permit);
		const args = ["con", "modify", argMatch(ID_RE, uuid)];
		for (const field in fields) {
			const value = fields[field];
			if (value === undefined) continue;

			args.push(field);
			args.push(value);
		}
		if (permit && !(await permit())) return false;
		const stdout = await run("nmcli", args);
		return stdout === "";
	} catch {
		logger.error("nmConnSetFields: connection update failed");
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
		if (parseNmConnDeleted(stdout)) return true;
	} catch (err) {
		logger.error(`nmConnDelete err: ${describeCliError(err)}`);
	}
	const rows = await nmConnsGet("uuid");
	return Boolean(
		rows?.every(
			(row) =>
				row === "" ||
				/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row),
		) && !rows.includes(uuid),
	);
}

const NM_ACTIVATED_PATH_RE =
	/D-Bus active path: (\/org\/freedesktop\/NetworkManager\/ActiveConnection\/\d+)\)/;

export async function nmConnect(
	uuid: ConnectionUUID,
	timeout?: number,
	onActivated?: (path: string) => void,
	onTimeout?: () => void,
	ifname?: string,
) {
	try {
		// In mock mode, simulate successful connection
		if (shouldMockWifi()) {
			logger.info(`🎭 Mock: Activated connection ${uuid}`);
			return true;
		}

		const timeoutArgs = timeout ? ["-w", String(timeout)] : [];
		const stdout = await run(
			"nmcli",
			timeoutArgs.concat(
				ifname === undefined
					? ["conn", "up", argMatch(ID_RE, uuid)]
					: [
							"conn",
							"up",
							"uuid",
							argMatch(ID_RE, uuid),
							"ifname",
							argMatch(ID_RE, ifname),
						],
			),
		);
		const path = NM_ACTIVATED_PATH_RE.exec(stdout)?.[1];
		if (path) onActivated?.(path);
		return parseNmConnActivated(stdout);
	} catch (err) {
		// nmcli exit 3 and the process deadline do not cancel the daemon's Up.
		if (
			err instanceof RunTimeoutError ||
			(err instanceof Error && "code" in err && err.code === 3)
		) {
			const path =
				err instanceof RunTimeoutError
					? NM_ACTIVATED_PATH_RE.exec(err.partialStdout)?.[1]
					: undefined;
			if (path) onActivated?.(path);
			onTimeout?.();
		}
		logger.error(`nmConnect err: ${describeCliError(err)}`);
	}
	return false;
}

const ACTIVE_PATH_RE =
	/^\/org\/freedesktop\/NetworkManager\/ActiveConnection\/\d+$/;

export async function readNmDeviceActivation(ifname: string) {
	const fields = await nmDeviceProp(
		ifname,
		"GENERAL.STATE,GENERAL.CON-UUID,GENERAL.CON-PATH",
	);
	if (fields?.length !== 3) return undefined;
	const [state, uuid, path] = fields;
	return {
		uuid,
		path: path && ACTIVE_PATH_RE.test(path) ? path : undefined,
		connected: Number.parseInt(state ?? "", 10) === 100,
	};
}

/** Callers using an active path must prove the current daemon owns that receipt. */
export async function nmDisconnect(
	uuid: ConnectionUUID,
	activePath?: string,
	runId?: string,
	ifname?: string,
) {
	try {
		// In mock mode, simulate successful disconnection
		if (shouldMockWifi()) {
			logger.info(`🎭 Mock: Disconnected ${uuid}`);
			return true;
		}

		if (activePath !== undefined) {
			if (!runId || !ifname || !ACTIVE_PATH_RE.test(activePath)) return false;
			const { deactivateNmActivation } = await import(
				"./network-manager-activation.ts"
			);
			return await deactivateNmActivation(activePath, runId, uuid, ifname);
		}
		const stdout = await run("nmcli", ["conn", "down", argMatch(ID_RE, uuid)]);
		return parseNmConnDeactivated(stdout);
	} catch (err) {
		logger.error(`nmDisconnect err: ${describeCliError(err)}`);
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
		logger.error(`nmDevices err: ${describeCliError(err)}`);
	}
	return undefined;
}

const warnedInvalidDeviceFields = new Set<string>();

export async function nmDeviceProp(
	device: string,
	fields: string,
	mode?: "multiline",
) {
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

		if (
			new Set(fields.split(",").map((field) => field.split(".")[0])).size > 1
		) {
			const row = await readNmFields(fields, [
				"device",
				"show",
				argMatch(ID_RE, device),
			]);
			return mode === "multiline"
				? [...row].map(([key, value]) => `${key.toUpperCase()}:${value}`)
				: fields.split(",").map((field) => {
						const base = field.toLowerCase();
						return [...row]
							.filter(([key]) => key.replace(/\[\d+\]$/, "") === base)
							.map(([, value]) => value)
							.join("\n");
					});
		}
		const stdout = await run("nmcli", [
			...(mode === undefined ? [] : ["--mode", mode]),
			"--terse",
			"--escape",
			"no",
			"--get-values",
			fields,
			"device",
			"show",
			argMatch(ID_RE, device),
		]);
		return mode === "multiline" ? stdout.split("\n") : splitNmValues(stdout);
	} catch (err) {
		if (
			typeof err === "object" &&
			err !== null &&
			"stderr" in err &&
			typeof err.stderr === "string" &&
			err.stderr.includes("invalid field")
		) {
			if (!warnedInvalidDeviceFields.has(fields)) {
				warnedInvalidDeviceFields.add(fields);
				logger.warn(`nmDeviceProp err: ${describeCliError(err)}`);
			}
		} else {
			logger.error(`nmDeviceProp err: ${describeCliError(err)}`);
		}
	}
	return undefined;
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
		logger.error(`nmRescan err: ${describeCliError(err)}`);
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
		logger.error(`nmScanResults err: ${describeCliError(err)}`);
	}
	return undefined;
}

/** A dispatched add failed; its exact UUID and checked cleanup outcome survive. */
export class NmApConnAddError extends Error {
	constructor(
		readonly uuid: string,
		readonly cleanupConfirmed: boolean,
		readonly autoconnectDisabled: boolean,
		readonly instance?: NmProfileInstance | null,
	) {
		super("Hotspot profile creation failed");
		this.name = "NmApConnAddError";
	}
}

/** Create a bound AP profile without selecting or activating a device. */
export async function nmApConnAdd(
	device: string,
	identity: { readonly name: string; readonly password: string },
	bindingFields: Readonly<Record<string, string>>,
	recordCreation?: (uuid: string, instance?: NmProfileInstance) => boolean,
	permit?: () => Promise<boolean>,
): Promise<string | undefined> {
	// Retain our UUID before dispatch; a mismatched receipt never grants cleanup
	// authority over the UUID printed by NetworkManager.
	const uuid = crypto.randomUUID();
	let dispatched = false;
	let instance: NmProfileInstance | null | undefined;
	let secretWrite: HotspotProfileOperationResult | null | undefined;
	const fields = {
		type: "wifi",
		ifname: device,
		"connection.id": "Hotspot",
		"802-11-wireless.ssid": identity.name,
		"802-11-wireless.mode": "ap",
		"ipv4.method": "shared",
		"ipv6.method": "ignore",
		"802-11-wireless-security.key-mgmt": "wpa-psk",
		"802-11-wireless-security.proto": "rsn",
		"802-11-wireless-security.pairwise": "ccmp",
		"802-11-wireless-security.group": "ccmp",
		"802-11-wireless-security.psk": identity.password,
		"802-11-wireless-security.psk-flags": "0",
		...bindingFields,
		"connection.autoconnect": "no",
		"connection.uuid": uuid,
	};
	const submitted = {
		...Object.fromEntries(
			Object.entries(fields).filter(
				([key]) => key !== "type" && key !== "ifname",
			),
		),
		"connection.type": "802-11-wireless",
	};
	const initial = { ...submitted, "802-11-wireless-security.psk": "" };
	const readSubmitted = async (
		id: string,
		_fields?: Readonly<Record<string, string>>,
		trace: NmProfileReadTrace = {},
	) => {
		if (secretWrite === null || secretWrite?.checked === false) {
			trace.exit = "owned-write-unverified";
			return undefined;
		}
		const observed = await readNmProfileInstance(id, submitted, trace);
		return secretWrite?.instance &&
			!sameNmProfileResource(secretWrite.instance, observed)
			? undefined
			: observed;
	};
	try {
		if (recordCreation && !recordCreation(uuid)) return undefined;
		if (shouldMockWifi()) return uuid;
		argMatch(ID_RE, device);
		let stdout: string | undefined;
		const added = await runHotspotProfileOperation(
			{
				uuid,
				kind: "add",
				run: async () => {
					if (permit && !(await permit())) return false;
					dispatched = true;
					stdout = await run("nmcli", [
						"connection",
						"add",
						...Object.entries(fields)
							.filter(([key]) => key !== "802-11-wireless-security.psk")
							.flat(),
					]);
					instance = await readNmProfileInstance(uuid, initial);
					if (!instance?.file) return false;
					if (permit && !(await permit())) return false;
					secretWrite = null;
					secretWrite = await runHotspotProfileOperation(
						{
							uuid,
							kind: "modify",
							fields: { "802-11-wireless-security.psk": identity.password },
							run: (delta) => nmConnSetFields(uuid, delta, permit),
						},
						{ instance, readProfileInstance: readNmProfileInstance },
					);
					if (secretWrite.checked) instance = secretWrite.instance;
					return secretWrite.success;
				},
			},
			{ instance: null, readProfileInstance: readSubmitted },
		);
		if (added.checked) instance = added.instance;
		if (stdout !== undefined) {
			const parsed = parseNmConnAddUuid(stdout);
			if (
				added.success &&
				instance &&
				parsed.ok &&
				parsed.value === uuid &&
				(!recordCreation || recordCreation(uuid, instance))
			)
				return uuid;
		}
		logger.error("nmApConnAdd: profile creation receipt could not be verified");
	} catch {
		// An nmcli error can echo the complete argv, stdout or PSK in its message.
		logger.error("nmApConnAdd: connection add failed");
	}
	if (dispatched) {
		if (secretWrite === null || secretWrite?.checked === false)
			return undefined;
		instance ??=
			(await readSubmitted(uuid)) ??
			(await readNmProfileInstance(uuid, initial));
		// Different submitted settings grant no creation or cleanup authority.
		if (!instance?.file) return undefined;
		const act = async (
			operation: HotspotProfileOperation,
		): Promise<boolean> => {
			const result = await runHotspotProfileOperation(operation, {
				instance,
				readProfileInstance: readNmProfileInstance,
			});
			instance = result.instance;
			return result.success;
		};
		const autoconnectDisabled = await act({
			uuid,
			kind: "modify",
			fields: { "connection.autoconnect": "no" },
			run: (delta) => nmConnSetFields(uuid, delta),
		});
		const cleanupConfirmed = await act({
			uuid,
			kind: "delete",
			run: () => nmConnDelete(uuid),
		});
		throw new NmApConnAddError(
			uuid,
			cleanupConfirmed,
			autoconnectDisabled,
			instance,
		);
	}
	return undefined;
}

// ─── named result parsers (fail-loud on nmcli output drift) ──────────────────

// Regex: nmcli's "Connection '<name>' (<uuid>) successfully added." line.
const NM_CONN_ADD_RE = /Connection '.+' \((.+)\) successfully added\./;
// Regex: nmcli's "...successfully activated with '<uuid>'" hotspot line.
const NM_HOTSPOT_UUID_RE = /successfully activated with '(.+)'/;

/**
 * Extract the new connection UUID from `nmcli connection add` output. A missing
 * "successfully added" line is drift — the caller treats it as a failed add
 * rather than returning a bogus/empty UUID.
 */
export function parseNmConnAddUuid(stdout: string): ParseResult<string> {
	const m = stdout.match(NM_CONN_ADD_RE);
	if (m?.[1] === undefined) {
		return parseFail(
			"parseNmConnAddUuid",
			"no 'successfully added' confirmation line",
			stdout,
		);
	}
	return parseOk(m[1]);
}

/** Extract the hotspot connection UUID from `nmcli device wifi hotspot` output. */
export function parseNmHotspotUuid(stdout: string): ParseResult<string> {
	const m = stdout.match(NM_HOTSPOT_UUID_RE);
	if (m?.[1] === undefined) {
		return parseFail(
			"parseNmHotspotUuid",
			"no 'successfully activated with' confirmation line",
			stdout,
		);
	}
	return parseOk(m[1]);
}

/** True when nmcli confirmed a connection deletion. */
export function parseNmConnDeleted(stdout: string): boolean {
	return /successfully deleted/.test(stdout);
}

/** True when nmcli confirmed a connection activation. */
export function parseNmConnActivated(stdout: string): boolean {
	return /^Connection successfully activated/.test(stdout);
}

/** True when nmcli confirmed a connection deactivation. */
export function parseNmConnDeactivated(stdout: string): boolean {
	return /successfully deactivated/.test(stdout);
}
