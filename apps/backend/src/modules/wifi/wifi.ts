/*
    CeraUI - web UI for the CeraLive project
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

/* NetworkManager / nmcli based Wifi Manager */

import type { WifiAdapterCapabilities } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { pollWithBackoff } from "../../helpers/retry.ts";
import { DEFAULT_SPAWN_TIMEOUT_MS } from "../../helpers/spawn-policy.ts";
import { extractMessage } from "../../helpers/types.ts";
import {
	getMockState,
	getScenarioConfig,
	getWifiSignal,
	mockWifiNetworks,
	mockWifiRadios,
	mockWifiUuidForSsid,
	shouldUseMocks,
} from "../../mocks/mock-service.ts";
import {
	getMockHotspotClients,
	getMockHotspotConfig,
} from "../../mocks/providers/wifi.ts";
import {
	type ConnectionUUID,
	type MacAddress,
	nmConnDelete,
	nmConnect,
	nmConnGetFields,
	nmConnSetWifiMacAddress,
	nmConnsGet,
	nmcliParseSep,
	nmDisconnect,
	parseNmConnActivated,
	parseNmConnAddUuid,
} from "../network/network-manager.ts";
import { logParseError } from "../system/cli-parse.ts";
import type { MessageSocket } from "../ui/message-socket.ts";
import {
	broadcastMsg,
	buildMsg,
	getSocketSenderId,
} from "../ui/websocket-server.ts";
import {
	getWifiCapabilitiesForInterface,
	getWifiLinkTelemetryForInterface,
	refreshWifiLinkTelemetry,
	type WifiLinkTelemetry,
} from "./wifi-capabilities.ts";
import { getWifiChannelMap } from "./wifi-channels.ts";
import {
	getWifiInterfaceByMacAddress,
	getWifiInterfacesByMacAddress,
	getWifiScanStampForDevice,
	wifiRescan,
	wifiScheduleScanRefresh,
	wifiUpdateScanResult,
} from "./wifi-connections.ts";
import { wifiHotspotStart } from "./wifi-hotspot-activation.ts";
import {
	buildHotspotClients,
	getHotspotClientsForInterface,
	type HotspotClients,
} from "./wifi-hotspot-clients.ts";
import { wifiHotspotConfig, wifiHotspotStop } from "./wifi-hotspot-config.ts";
import { handleHotspotConn } from "./wifi-hotspot-discovery.ts";
import { publishHotspotOutcome } from "./wifi-hotspot-outcome.ts";
import {
	getHotspotSecurityMap,
	type HotspotBandMaxWidth,
	offeredHotspotMaxWidth,
	offeredHotspotSecurity,
} from "./wifi-hotspot-security.ts";
import {
	canHotspot,
	isApMode,
	isConcurrentHotspot,
	type WifiHotspot,
	type WifiHotspotMessage,
} from "./wifi-hotspot-types.ts";
import {
	type BaseWifiInterface,
	getMacAddressForWifiInterface,
	getWifiIdToMacAddress,
	type SSID,
	type WifiInterface,
	type WifiInterfaceId,
} from "./wifi-interfaces.ts";
import {
	planWifiStationJoin,
	saeActivateArgs,
	type WifiStationJoinPlan,
} from "./wifi-station-security.ts";

const errorText = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

type WifiConnectMessage = {
	connect: ConnectionUUID;
};

type WifiDisconnectMessage = {
	disconnect: ConnectionUUID;
};

type WifiNewMessage = {
	new: {
		device: WifiInterfaceId;
		ssid: SSID;
		password?: string;
		security?: string;
	};
};

type WifiForgetMessage = {
	forget: ConnectionUUID;
};

type WifiScanMessage = {
	scan: WifiInterfaceId;
};

export type WifiMessage = {
	wifi:
		| WifiConnectMessage
		| WifiDisconnectMessage
		| WifiNewMessage
		| WifiForgetMessage
		| WifiScanMessage
		| WifiHotspotMessage;
};

// 1 - 100
type WifiSignalStrength = number;

export type WifiNetwork = {
	active: boolean; // is it currently connected?
	ssid: SSID;
	signal: WifiSignalStrength;
	security: string;
	freq: number;
};

/* Builds the WiFi status structure sent over the network from the <wd> structures */
export type WifiInterfaceResponseMessage = Pick<
	BaseWifiInterface,
	"ifname" | "hw" | "saved"
> & {
	// Empty string = no active connection (the wire convention every build path
	// uses); the real path coerces BaseWifiInterface.conn's null to "" to match.
	conn: string;
	available?: Array<WifiNetwork>;
	hotspot?: Pick<WifiHotspot, "name" | "password" | "channel" | "security"> & {
		available_channels: Record<string, { name: string }>;
		available_security: Record<string, { name: string }>;
		// DISPLAY ONLY — there is no configurable width in this contract.
		max_width_mhz?: HotspotBandMaxWidth;
		// Absent until the AP's own station dump has been read once; a read that
		// found nobody publishes an explicit `count: 0`.
		clients?: HotspotClients;
		warnings?: string[];
	};
	supports_hotspot?: true;
	supports_ap_sta_concurrency?: true;
	mode?: "station" | "hotspot";
	transition?: "activating" | "deactivating";
	degraded_reason?: BaseWifiInterface["degradedReason"];
	// Absent means NOT COMPUTED (no `iw`, an unresolvable wiphy, or a dump that
	// failed its named parser); once computed it rides EVERY tick.
	capabilities?: WifiAdapterCapabilities;
	// The STATION leg's live negotiated rate. Absent on an AP-mode radio, on a
	// station holding no connection, and until the first read has landed.
	link?: WifiLinkTelemetry;
	// This adapter's completed-scan counter and the moment it last advanced.
	// Absent until the adapter has completed one scan cycle — a consumer confirms
	// its own scan by the generation ADVANCING, never by the list changing.
	scanGeneration?: number;
	scanAt?: number;
};

/*
  Stamp the adapter's last completed scan cycle onto its wire row.

  It rides EVERY tick rather than only the tick that advanced it, so a consumer
  never has to decide whether a missing generation means "unchanged" or
  "withdrawn" — the same rule `capabilities` states directly above.
*/
function applyScanStamp(
	entry: WifiInterfaceResponseMessage,
	device: WifiInterfaceId,
): void {
	const stamp = getWifiScanStampForDevice(device);
	if (stamp === undefined) return;
	entry.scanGeneration = stamp.generation;
	entry.scanAt = stamp.at;
}

export function wifiBuildMsg() {
	// Return mock WiFi data in development mode
	if (shouldUseMocks()) {
		const config = getScenarioConfig();
		if (!config.wifi) return {};

		const state = getMockState();
		const ifs: Record<string, WifiInterfaceResponseMessage> = {};

		mockWifiRadios.forEach((radio, index) => {
			if (state.wifiModes[radio.device] === "hotspot") {
				const hotspot = getMockHotspotConfig(radio.device);
				ifs[index] = {
					ifname: radio.ifname,
					conn: hotspot.uuid,
					hw: radio.macAddress,
					saved: {},
					hotspot: {
						name: hotspot.name,
						password: hotspot.password,
						channel: hotspot.channel,
						available_channels: getWifiChannelMap([
							"auto",
							"auto_24",
							"auto_50",
						]),
						// A dev host proves no SAE, so the mock offers exactly what
						// the real derivation would offer for an unprovable radio.
						available_security: getHotspotSecurityMap(
							offeredHotspotSecurity(undefined),
						),
						clients: buildHotspotClients(getMockHotspotClients(radio.device)),
					},
				} satisfies WifiInterfaceResponseMessage;
				return;
			}

			const wlanState = state.wifiConnections.get(radio.device);
			const activeSsid = wlanState?.activeNetwork;
			const savedNetworks = wlanState?.savedNetworks ?? [];

			const available: WifiNetwork[] = mockWifiNetworks
				.map((network) => ({
					active: network.ssid === activeSsid,
					ssid: network.ssid,
					signal: Math.round(getWifiSignal(network.ssid)),
					security: network.security,
					freq: network.frequency,
				}))
				.sort((a, b) => b.signal - a.signal);

			const saved: Record<string, string> = {};
			for (const ssid of savedNetworks) {
				saved[ssid] = mockWifiUuidForSsid(ssid);
			}

			const entry: WifiInterfaceResponseMessage = {
				ifname: radio.ifname,
				conn: activeSsid ? mockWifiUuidForSsid(activeSsid) : "",
				hw: radio.macAddress,
				saved,
				available,
				...(radio.supports_hotspot ? { supports_hotspot: true } : {}),
			};
			applyScanStamp(entry, index);
			ifs[index] = entry;
		});

		return ifs;
	}

	const ifs: Record<string, WifiInterfaceResponseMessage> = {};
	// The interfaces eligible for a link read, collected as the rows are built
	// so the refresh below is driven by exactly what this build decided is a
	// connected station — never by a guess made inside the reader.
	const stationIfnames: string[] = [];
	const wifiInterfacesByMacAddress = getWifiInterfacesByMacAddress();
	for (const macAddress in wifiInterfacesByMacAddress) {
		const wifiInterface = wifiInterfacesByMacAddress[macAddress];
		if (!wifiInterface) continue;

		const id = wifiInterface.id;

		const entry: WifiInterfaceResponseMessage = {
			ifname: wifiInterface.ifname,
			conn: wifiInterface.conn ?? "",
			hw: wifiInterface.hw,
			saved: {},
		};
		if (wifiInterface.degradedReason !== undefined) {
			entry.degraded_reason = wifiInterface.degradedReason;
		}
		if (wifiInterface.supportsApStaConcurrency === true) {
			entry.supports_ap_sta_concurrency = true;
		}
		ifs[id] = entry;

		if (isApMode(wifiInterface) || isConcurrentHotspot(wifiInterface)) {
			// One capability read backs both derivations, so the security the
			// device OFFERS and the width it REPORTS can never describe different
			// radios.
			const hotspotCaps = getWifiCapabilitiesForInterface(wifiInterface.ifname);
			const maxWidthMhz = offeredHotspotMaxWidth(hotspotCaps);
			// Asked for THIS interface, which is the AP's own: a shared-wiphy board
			// would otherwise report the station leg's peers as hotspot clients.
			const clients = getHotspotClientsForInterface(wifiInterface.ifname);

			const hotspot: NonNullable<WifiInterfaceResponseMessage["hotspot"]> = {
				...(wifiInterface.hotspot.name !== undefined
					? { name: wifiInterface.hotspot.name }
					: {}),
				...(wifiInterface.hotspot.password !== undefined
					? { password: wifiInterface.hotspot.password }
					: {}),
				available_channels: getWifiChannelMap(
					wifiInterface.hotspot.availableChannels,
					wifiInterface.hotspot.derivedChannels ?? [],
				),
				available_security: getHotspotSecurityMap(
					offeredHotspotSecurity(hotspotCaps),
				),
				...(wifiInterface.hotspot.channel !== undefined
					? { channel: wifiInterface.hotspot.channel }
					: {}),
				...(wifiInterface.hotspot.security !== undefined
					? { security: wifiInterface.hotspot.security }
					: {}),
				...(Object.keys(maxWidthMhz).length > 0
					? { max_width_mhz: maxWidthMhz }
					: {}),
				...(clients !== undefined ? { clients } : {}),
			};

			const warnings = Object.keys(wifiInterface.hotspot.warnings);
			if (warnings.length > 0) {
				hotspot.warnings = warnings;
			}
			entry.hotspot = hotspot;
		}
		if (!isApMode(wifiInterface)) {
			entry.available = Array.from(wifiInterface.available.values());
			entry.saved = wifiInterface.saved;
			if (canHotspot(wifiInterface)) {
				entry.supports_hotspot = true;
			}
			// Only a station leg that HOLDS a connection has a negotiated rate to
			// report, and the AP branch above never reaches here — so `iw link` is
			// structurally unreachable for a hotspot radio rather than filtered
			// out of one, which is what keeps a shared-wiphy board honest.
			if (wifiInterface.conn !== null) {
				stationIfnames.push(wifiInterface.ifname);
				const link = getWifiLinkTelemetryForInterface(wifiInterface.ifname);
				if (link !== undefined) {
					entry.link = link;
				}
			}
		}

		entry.mode = isApMode(wifiInterface) ? "hotspot" : "station";
		if (canHotspot(wifiInterface) && wifiInterface.hotspot.transition) {
			entry.transition = wifiInterface.hotspot.transition;
		}

		const capabilities = getWifiCapabilitiesForInterface(wifiInterface.ifname);
		if (capabilities !== undefined) {
			entry.capabilities = capabilities;
		}

		applyScanStamp(entry, id);
	}

	// Fire-and-forget, after the snapshot is assembled: the read is bounded by
	// its own TTL and never throws, so a broadcast is never blocked on a spawn
	// and the next build serves whatever this one produced.
	void refreshWifiLinkTelemetry(stationIfnames);

	return ifs;
}

export function broadcastWifiState() {
	broadcastMsg("status", { wifi: wifiBuildMsg() });
}

/*
  Record one saved infrastructure connection on the interface(s) it can be used
  from. A profile bound to a MAC that a present adapter reports is attributed to
  that adapter only. Any other profile — no bound MAC (created outside CeraUI:
  nmtui, `nmcli device wifi connect`, a baked image profile) or a bound MAC that
  matches no present adapter (MAC randomization / swapped adapter) — is registered
  on every adapter, mirroring the scan path where all interfaces see all networks.
  Without this fallback an active-but-unbound connection resolves no UUID and the
  UI shows "Connect" on the network the device is already connected to.

  The fallback registers only where the SSID is not already claimed (`??=`), so a
  precise MAC binding always wins over a same-SSID fallback profile regardless of
  nmcli enumeration order — a fallback profile listed after a MAC-bound one for the
  same SSID must not silently overwrite the precise adapter attribution.
*/
export function registerSavedWifiConnection(
	interfaces: Record<MacAddress, WifiInterface>,
	macAddress: MacAddress,
	ssid: SSID,
	uuid: ConnectionUUID,
): void {
	const boundInterface = macAddress ? interfaces[macAddress] : undefined;
	if (boundInterface) {
		boundInterface.saved[ssid] = uuid;
		rememberSavedUuid(boundInterface, ssid, uuid);
		return;
	}
	for (const wifiInterface of Object.values(interfaces)) {
		wifiInterface.saved[ssid] ??= uuid;
		rememberSavedUuid(wifiInterface, ssid, uuid);
	}
}

/* `saved` keeps ONE uuid per SSID; `savedAll` keeps every one, for Forget. */
function rememberSavedUuid(
	wifiInterface: WifiInterface,
	ssid: SSID,
	uuid: ConnectionUUID,
): void {
	wifiInterface.savedAll[ssid] ??= [];
	const all = wifiInterface.savedAll[ssid];
	if (!all.includes(uuid)) all.push(uuid);
}

export async function wifiUpdateSavedConns() {
	// Retry transient nmcli connection-list failures with exponential backoff (T7).
	const connections = await pollWithBackoff(() => nmConnsGet("uuid,type"), {
		maxAttempts: 3,
		baseDelayMs: 200,
		maxDelayMs: 1000,
		emptyResultError: () =>
			new Error("nmcli connection list returned no results"),
		onExhausted: (err) =>
			logger.debug(`wifiUpdateSavedConns: list failed after retries: ${err}`),
	});
	if (connections === undefined) return;

	const wifiInterfacesByMacAddress = getWifiInterfacesByMacAddress();
	for (const wifiInterface of Object.values(wifiInterfacesByMacAddress)) {
		wifiInterface.saved = {};
		wifiInterface.savedAll = {};
	}

	for (const connection of connections) {
		try {
			const [uuid, type] = nmcliParseSep(connection) as [
				ConnectionUUID,
				string,
			];

			if (type !== "802-11-wireless") continue;

			// Get the device the connection is bound to and the ssid
			const fields = await nmConnGetFields(uuid, [
				"802-11-wireless.mode",
				"802-11-wireless.ssid",
				"802-11-wireless.mac-address",
			] as const);

			if (fields === undefined) {
				throw new Error("Failed to get connection fields");
			}

			const [mode, ssid, macTmp] = fields;
			if (!ssid) {
				logger.warn("Wifi connection does not have an SSID!", { mode, uuid });
				continue;
			}

			const macAddress = macTmp.toLowerCase();
			if (mode === "ap") {
				void handleHotspotConn(macAddress, uuid);
			} else if (mode === "infrastructure") {
				registerSavedWifiConnection(
					wifiInterfacesByMacAddress,
					macAddress,
					ssid,
					uuid,
				);
			}
		} catch (err) {
			if (err instanceof Error) {
				logger.error(
					`Error getting the nmcli connection information: ${err.message}`,
				);
			}
		}
	}
}

/* Searches saved connections in wifiIfs by UUID */
function wifiSearchConnection(uuid: string) {
	let connFound: string | undefined;

	const wifiIdToMacAddress = getWifiIdToMacAddress();
	const wifiInterfacesByMacAddress = getWifiInterfacesByMacAddress();
	for (const id in wifiIdToMacAddress) {
		const macAddress = getMacAddressForWifiInterface(Number.parseInt(id, 10));
		if (!macAddress) continue;

		const wifiInterface = wifiInterfacesByMacAddress[macAddress];
		if (!wifiInterface) continue;

		for (const s in wifiInterface.saved) {
			if (wifiInterface.saved[s] === uuid) {
				connFound = id;
				break;
			}
		}
	}

	return connFound;
}

async function wifiDisconnect(uuid: ConnectionUUID) {
	if (wifiSearchConnection(uuid) === undefined) return;

	if (await nmDisconnect(uuid)) {
		await wifiUpdateScanResult();
		wifiScheduleScanRefresh();
	}
}

/*
  Every profile the adapters hold for the SSID `uuid` belongs to — because
  "Forget" means "remove this NETWORK", and the operator's row IS the SSID.
  Deleting only `uuid` leaves a same-SSID sibling behind, which keeps the row
  reading "Saved" and is indistinguishable from a Forget that did nothing.
*/
export function wifiSiblingConnections(uuid: ConnectionUUID): ConnectionUUID[] {
	const uuids = new Set<ConnectionUUID>([uuid]);
	for (const wifiInterface of Object.values(getWifiInterfacesByMacAddress())) {
		for (const ssid in wifiInterface.saved) {
			if (wifiInterface.saved[ssid] !== uuid) continue;
			for (const sibling of wifiInterface.savedAll[ssid] ?? []) {
				uuids.add(sibling);
			}
		}
	}
	return [...uuids];
}

async function wifiForget(uuid: ConnectionUUID) {
	if (wifiSearchConnection(uuid) === undefined) return;

	let deleted = false;
	for (const target of wifiSiblingConnections(uuid)) {
		if (await nmConnDelete(target)) deleted = true;
	}

	if (deleted) {
		await wifiUpdateSavedConns();
		await wifiUpdateScanResult();
		wifiScheduleScanRefresh();
	}
}

/*
  `nmConnsGet` REPORTS a failure by resolving `undefined` — it never throws — so
  a missing or erroring nmcli arrives here as a non-array, and the retired
  `as Array<string>` cast turned that into `undefined is not an object`. This is
  best-effort cleanup on `runWifiNew`'s FAILURE path, so the crash replaced the
  typed refusal the operator was owed with an unhandled rejection. A sweep that
  cannot enumerate has nothing to delete: say so and return.
*/
export type WifiFailedConnsDeps = {
	listConns: (fields: string) => Promise<string[] | undefined>;
	deleteConn: (uuid: ConnectionUUID) => Promise<boolean>;
};

const defaultFailedConnsDeps: WifiFailedConnsDeps = {
	listConns: nmConnsGet,
	deleteConn: nmConnDelete,
};

export async function wifiDeleteFailedConns(
	deps: WifiFailedConnsDeps = defaultFailedConnsDeps,
) {
	const connections = await deps.listConns("uuid,type,timestamp");
	if (!Array.isArray(connections)) {
		logger.warn(
			"wifiDeleteFailedConns: could not list connections; skipping cleanup",
		);
		return;
	}

	for (const connection of connections) {
		const [uuid, type, ts] = nmcliParseSep(connection) as [
			string,
			string,
			string,
		];
		if (type !== "802-11-wireless") continue;
		if (ts === "0") {
			await deps.deleteConn(uuid);
		}
	}
}

export type NmcliRun = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
};

export type WifiJoinNmcliRunner = (args: string[]) => Promise<NmcliRun>;

async function spawnJoinNmcli(args: string[]): Promise<NmcliRun> {
	try {
		const proc = Bun.spawn(["nmcli", ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		// bounded-command (spawn-policy): cap a hung nmcli connect at the
		// wall-clock budget so a stuck join never leaves the request pending
		// forever.
		const killTimer = setTimeout(() => {
			try {
				proc.kill();
			} catch {
				// best-effort: the process may have already exited
			}
		}, DEFAULT_SPAWN_TIMEOUT_MS);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;
		clearTimeout(killTimer);
		return { stdout, stderr, exitCode };
	} catch (err) {
		// A missing/unspawnable nmcli must reach the operator as a failed join
		// rather than an unhandled rejection on this `void`-dispatched path.
		return {
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
			exitCode: 1,
		};
	}
}

let joinNmcliRunner: WifiJoinNmcliRunner = spawnJoinNmcli;

/** Test seam, mirroring `setRegdomainRunner` / `setSshServiceRunner`. */
export function setWifiJoinNmcliRunner(
	runner: WifiJoinNmcliRunner | null,
): void {
	joinNmcliRunner = runner ?? spawnJoinNmcli;
}

type WifiJoinOutcome = {
	readonly ok: boolean;
	readonly uuid?: string;
	readonly authFailed: boolean;
	readonly stdout: string;
	readonly stderr: string;
};

const wantedSecrets = (output: string) =>
	output.includes("Secrets were required, but not provided");

async function joinViaNmAuto(args: string[]): Promise<WifiJoinOutcome> {
	const { stdout, stderr, exitCode } = await joinNmcliRunner(args);
	if (exitCode !== 0 || /^Error:/.test(stdout)) {
		return { ok: false, authFailed: wantedSecrets(stdout), stdout, stderr };
	}
	const success = stdout.match(/successfully activated with '(.+)'/);
	const uuid = success?.[1];
	return uuid === undefined
		? { ok: true, authFailed: false, stdout, stderr }
		: { ok: true, uuid, authFailed: false, stdout, stderr };
}

/**
 * A failed activation leaves a never-activated profile behind; the caller's
 * `wifiDeleteFailedConns()` removes it, because NetworkManager reports its
 * timestamp as `0`.
 */
async function joinViaSaeProfile(addArgs: string[]): Promise<WifiJoinOutcome> {
	const added = await joinNmcliRunner(addArgs);
	if (added.exitCode !== 0) {
		return {
			ok: false,
			authFailed: false,
			stdout: added.stdout,
			stderr: added.stderr,
		};
	}

	const parsed = parseNmConnAddUuid(added.stdout);
	if (!parsed.ok) {
		logParseError(parsed);
		return {
			ok: false,
			authFailed: false,
			stdout: added.stdout,
			stderr: added.stderr,
		};
	}

	const uuid = parsed.value;
	const activated = await joinNmcliRunner(saeActivateArgs(uuid));
	if (activated.exitCode !== 0 || !parseNmConnActivated(activated.stdout)) {
		return {
			ok: false,
			uuid,
			authFailed: wantedSecrets(`${activated.stdout}${activated.stderr}`),
			stdout: activated.stdout,
			stderr: activated.stderr,
		};
	}
	return {
		ok: true,
		uuid,
		authFailed: false,
		stdout: activated.stdout,
		stderr: activated.stderr,
	};
}

function wifiNew(conn: MessageSocket, msg: WifiNewMessage["new"]) {
	// NOT `!msg.device`: `wifiIfId` starts at 0, so the first adapter on every
	// single-radio board is id 0 and a truthiness guard drops it — no nmcli ran,
	// while the procedure's mock branch still fabricated success, so dev/e2e
	// stayed green while hardware could not join a new network at all.
	if (msg.device === undefined || !msg.ssid) return;

	const senderId = getSocketSenderId(conn);
	// An unresolvable adapter is still a terminal answer the caller is owed; the
	// retired silent returns left the keyed join op pending until its TTL.
	const refuse = () => {
		conn.send(
			buildMsg(
				"wifi",
				{ new: { error: "generic", device: msg.device } },
				senderId,
			),
		);
	};

	const macAddress = getMacAddressForWifiInterface(msg.device);
	if (!macAddress) return refuse();

	const wifiInterface = getWifiInterfaceByMacAddress(macAddress);
	if (!wifiInterface) return refuse();

	const plan = planWifiStationJoin({
		ssid: msg.ssid,
		ifname: wifiInterface.ifname,
		password: msg.password,
		security: msg.security,
	});

	void runWifiNew(conn, msg, macAddress, plan, senderId);
}

async function runWifiNew(
	conn: MessageSocket,
	msg: WifiNewMessage["new"],
	macAddress: string,
	plan: WifiStationJoinPlan,
	senderId: ReturnType<typeof getSocketSenderId>,
) {
	const outcome =
		plan.mode === "sae"
			? await joinViaSaeProfile(plan.addArgs)
			: await joinViaNmAuto(plan.connectArgs);

	if (!outcome.ok) {
		await wifiDeleteFailedConns();

		conn.send(
			buildMsg(
				"wifi",
				{
					new: {
						error: outcome.authFailed ? "auth" : "generic",
						device: msg.device,
					},
				},
				senderId,
			),
		);
		return;
	}

	if (outcome.uuid === undefined) {
		logger.warn(
			`wifiNew: no error but not matching a successful connection msg in:\n${outcome.stdout}\n${outcome.stderr}`,
		);
		/*
		  nmcli reported no error and named no connection, so nothing here can say
		  whether the network was joined — but a bare `return` is the one answer
		  that is certainly wrong: it leaves the dialog's keyed op to expire on its
		  TTL with no explanation. `ambiguous` says exactly that much, and nothing
		  is cleaned up: `wifiDeleteFailedConns` runs on the FAILURE path because a
		  failure proves the profile never activated, and this path proves nothing.
		*/
		conn.send(
			buildMsg(
				"wifi",
				{ new: { error: "ambiguous", device: msg.device } },
				senderId,
			),
		);
		return;
	}

	if (!(await nmConnSetWifiMacAddress(outcome.uuid, macAddress))) {
		logger.warn(
			"Failed to set the MAC address for the newly created connection",
		);
	}

	await wifiUpdateSavedConns();
	await wifiUpdateScanResult();

	conn.send(
		buildMsg("wifi", { new: { success: true, device: msg.device } }, senderId),
	);
}

async function wifiConnect(conn: MessageSocket, uuid: ConnectionUUID) {
	const deviceId = wifiSearchConnection(uuid);
	if (deviceId === undefined) return;

	const senderId = getSocketSenderId(conn);
	const success = await nmConnect(uuid);
	await wifiUpdateScanResult();
	conn.send(buildMsg("wifi", { connect: success, device: deviceId }, senderId));
}

// `conn` is a MessageSocket, never the `ws` package's WebSocket: the only caller
// is the oRPC wifi procedure, whose `context.ws` is a Bun ServerWebSocket, and
// declaring the unrelated `ws` type here is what forced every call site to
// launder it through `as unknown as WebSocket`.
export function handleWifi(conn: MessageSocket, msg: WifiMessage["wifi"]) {
	for (const type in msg) {
		switch (type) {
			case "connect":
				void wifiConnect(
					conn,
					extractMessage<WifiConnectMessage, typeof type>(msg, type),
				);
				break;

			case "disconnect":
				void wifiDisconnect(
					extractMessage<WifiDisconnectMessage, typeof type>(msg, type),
				);
				break;

			/*
			  The requested adapter is FORWARDED, not discarded. Dropping it made
			  every scan a device-wide one: the rescan went out with no `ifname`, so
			  a two-radio board rescanned whichever radio NetworkManager felt like,
			  and the process-wide coalescing guard then served the second adapter's
			  caller from the first one's run.
			*/
			case "scan":
				void wifiRescan(
					extractMessage<WifiScanMessage, typeof type>(msg, type),
				);
				break;

			case "new":
				wifiNew(conn, extractMessage<WifiNewMessage, typeof type>(msg, type));
				break;

			case "forget":
				void wifiForget(
					extractMessage<WifiForgetMessage, typeof type>(msg, type),
				);
				break;

			case "hotspot": {
				const hotspotMessage = extractMessage<WifiHotspotMessage, typeof type>(
					msg,
					type,
				);
				/*
				  These are dispatched, not awaited — but they are NOT bare
				  fire-and-forget: each transaction publishes a terminal `wifi` frame
				  on every outcome it can reach, and the `catch` arms cover the one
				  outcome it cannot (an unexpected throw), so no path on this branch
				  can leave an operator's keyed op to expire on its TTL.
				*/
				if ("start" in hotspotMessage && hotspotMessage.start) {
					const { device } = hotspotMessage.start;
					void wifiHotspotStart(hotspotMessage.start).catch((err) => {
						logger.error(`hotspot start threw: ${errorText(err)}`);
						publishHotspotOutcome("start", device, {
							success: false,
							error: "activation-failed",
						});
					});
				} else if ("stop" in hotspotMessage && hotspotMessage.stop) {
					const { device } = hotspotMessage.stop;
					void wifiHotspotStop(hotspotMessage.stop).catch((err) => {
						logger.error(`hotspot stop threw: ${errorText(err)}`);
						publishHotspotOutcome("stop", device, {
							success: false,
							error: "deactivation-failed",
						});
					});
				} else if ("config" in hotspotMessage && hotspotMessage.config) {
					const { device } = hotspotMessage.config;
					void wifiHotspotConfig(conn, hotspotMessage.config).catch((err) => {
						logger.error(`hotspot configure threw: ${errorText(err)}`);
						conn.send(
							buildMsg(
								"wifi",
								{ hotspot: { config: { device, error: "unavailable" } } },
								getSocketSenderId(conn),
							),
						);
					});
				}
				break;
			}
		}
	}
}
