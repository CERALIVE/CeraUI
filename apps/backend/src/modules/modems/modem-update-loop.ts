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

/*
  Modem update loop — event-driven presence + retained status poll (T17).

  HARD CUTOVER from the old always-on 10s self-recursive `setTimeout` loop:

  - Modem ADD / REMOVE + registration changes are driven by monitor events
    (`modem-added` / `modem-removed` / `device-state`) from the shared
    `IMonitorEmitter` (T12). The monitor has no historical replay, so the
    initial state (and every monitor restart via `onResync`) is reconciled by a
    one-shot `discoverModems()` poll.
  - A RETAINED poll runs ONLY for signal-strength / status refresh, at a reduced
    cadence (30s instead of the old 10s). It never re-lists / re-registers and
    never resets gsm connections.
  - `resetGsmConnections()` is wired exclusively through the T11
    `onGsmConnectionsReset` hook and fires ONLY on modem add/remove (and on
    config change, handled in modems.ts) — never on a status poll.
  - Re-entrancy is serialized via `withModemUpdateLock` (T13); transient `mmcli`
    failures are retried via `retryWithBackoff` (T7).
  - On removal we simply broadcast the cleaned-up state — no hot-plug recovery.

  The `modems` broadcast shape is unchanged: it is still produced by
  `broadcastModems` (modem-status.ts), keyed off the legacy `modemsState`
  record (modems-state.ts). The T11 cache (`modems-state-cache.ts`) sits on top
  as the diff engine that decides WHEN to broadcast and WHEN to reset gsm.
*/

import { logger } from "../../helpers/logger.ts";
import { retryWithBackoff } from "../../helpers/retry.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { createMonitorManager } from "../network/monitor/monitor-manager.ts";
import {
	type NetworkManagerConnection,
	type NetworkManagerConnectionModemConfig,
	nmConnAdd,
	nmConnect,
	nmConnGetFields,
} from "../network/network-manager.ts";
import { withModemUpdateLock } from "../network/state/device-lock.ts";
import type {
	IMonitorEmitter,
	ModemsState,
	MonitorEvent,
	StateDiff,
} from "../network/state-types.ts";

import { resetGsmConnections } from "./gsm-connections.ts";
import { type ModemId } from "./mmcli.ts";
import {
	type ModemId,
	type ModemInfo,
	mmConvertAccessTech,
	mmConvertNetworkType,
	mmConvertNetworkTypes,
	mmGetModem,
	mmGetSim,
	mmList,
	parseMmcliModel,
	type SimInfo,
} from "./mmcli.ts";
import { broadcastModems } from "./modem-status.ts";
import { getModem, getModemIds, removeModem } from "./modems-state.ts";
import {
	getModem,
	getModemIds,
	type Modem,
	type ModemConfig,
	removeModem,
	setModem,
} from "./modems-state.ts";
import {
	type ModemDiffEntry,
	onGsmConnectionsReset,
	onModemsChange,
	setModemsState,
	triggerGsmConnectionsReset,
} from "./state/modems-state-cache.ts";

// Retained status poll cadence. Reduced from the old 10s self-recursive loop:
// signal/status only, no presence detection, no gsm reset.
/** Interval (ms) for retained modem status poll (signal/status refresh only). */
const STATUS_POLL_INTERVAL_MS = 30_000;

// Retained status poll cadence. Reduced from the old 10s self-recursive loop:
// signal/status only, no presence detection, no gsm reset.
const STATUS_POLL_INTERVAL_MS = 30_000;

// Bounded retry for transient mmcli failures (mock mode never retries — the
// mock provider always returns data on the first call).
const MMCLI_RETRY = {
	maxAttempts: 3,
	baseDelayMs: 200,
	maxDelayMs: 2000,
} as const;

async function modemGetConfig(
	modemInfo: ModemInfo,
	simInfo: SimInfo,
): Promise<ModemConfig | undefined> {
	const modemId = modemInfo["modem.generic.device-identifier"];
	const simId = simInfo["sim.properties.iccid"];
	const operatorId = simInfo["sim.properties.operator-code"];

	const gsmConnections = await getGsmConnections();

	if (gsmConnections.byDevice[modemId]?.[simId]) {
		const ci = gsmConnections.byDevice[modemId][simId];
		logger.debug(`Found NM connection ${ci.uuid} for modem ${modemId}`);
		return {
			conn: ci.uuid,
			autoconfig: ci.autoconfig === true,
			apn: ci.apn,
			username: ci.username,
			password: ci.password,
			roaming: ci.roaming,
			network: ci.network,
		};
	}

	if (operatorId && gsmConnections.byOperator[operatorId]) {
		// Copy the settings from an existing config for the same operator
		const ci = gsmConnections.byOperator[operatorId];
		return {
			autoconfig: ci.autoconfig === true,
			apn: ci.apn,
			username: ci.username,
			password: ci.password,
			roaming: ci.roaming,
			network: ci.network,
		};
	}

	// New connection profile
	return {
		autoconfig: true,
		apn: "internet",
		username: "",
		password: "",
		roaming: true,
		network: "",
	};
}

async function connectModemIfNeededAndPossible(modem: Modem, modemId: number) {
	// If the modem has an inactive NM connection and isn't otherwise busy, then try to bring it up
	if (
		!modem.inhibit &&
		!modem.is_scanning &&
		(modem.status?.connection === "registered" ||
			modem.status?.connection === "enabled") &&
		modem.config?.conn
	) {
		// Don't try to activate NM connections that are already active
		const nmConnection = await nmConnGetFields(modem.config.conn, [
			"GENERAL.STATE",
		] as const);
		if (nmConnection?.length === 1) {
			logger.info(
				`Trying to bring up connection ${modem.config.conn} for modem ${modemId}...`,
			);
			nmConnect(modem.config.conn);
		}
	}
}

function buildModemStatus(
	modemInfo: Readonly<ModemInfo>,
	modem: Readonly<Modem>,
): ModemStatus {
	// Some modems don't seem to always report the operator's name
	let network = modemInfo["modem.3gpp.operator-name"];
	if (!network && modemInfo["modem.3gpp.registration-state"] === "home") {
		network = modem.sim_network;
	}
	const network_type = mmConvertAccessTech(
		modemInfo["modem.generic.access-technologies"],
	);
	const signal = modemInfo["modem.generic.signal-quality.value"];
	const roaming = modemInfo["modem.3gpp.registration-state"] === "roaming";
	const connection = modem.is_scanning
		? "scanning"
		: modemInfo["modem.generic.state"];

	return { connection, network, network_type, signal, roaming };
}

function applyAutoconfigToModemConfig(
	config: ModemConfig,
	autoConfig: boolean,
) {
	if (autoConfig) {
		config.apn = "";
		config.username = "";
		config.password = "";
	} else {
		config.autoconfig = false;
	}
}

export function sanitizeModemConfigForNetworkManager(config: ModemConfig) {
	const autoConfig = Boolean(setup.has_gsm_autoconfig && config.autoconfig);

	const fields: NetworkManagerConnectionModemConfig = {
		"gsm.apn": config.apn || "", // Empty string fallback; Bun runtime limitation with empty CLI args
		"gsm.username": config.username || "", // Empty string fallback; Bun runtime limitation with empty CLI args
		"gsm.password": config.password || "", // Empty string fallback; Bun runtime limitation with empty CLI args
		"gsm.password-flags": !config.password ? "4" : "0",
		"gsm.home-only": config.roaming ? "no" : "yes",
		"gsm.network-id": config.roaming ? config.network : "",
		"gsm.auto-config": autoConfig ? "yes" : "no",
	};

	applyAutoconfigToModemConfig(config, autoConfig);

	return fields;
}

async function addConnectionForModem(
	modemInfo: ModemInfo,
	simInfo: SimInfo,
	config: ModemConfig,
) {
	const modemId = modemInfo["modem.generic.device-identifier"];
	const simId = simInfo["sim.properties.iccid"];
	const operatorId = simInfo["sim.properties.operator-code"];

	// The NM connection doesn't exist yet, create it
	//const autoconnect = (modemInfo['modem.3gpp.registration-state'] != 'idle') ? 'yes' : 'no';
	const nmConfig: NetworkManagerConnection = {
		type: "gsm",
		ifname: "", // Can be empty for GSM connections - matches by device-id and sim-id
		autoconnect: "yes",
		"connection.autoconnect-retries": 2,
		"ipv6.method": "ignore",
		"gsm.device-id": modemId,
		"gsm.sim-id": simId,
		...sanitizeModemConfigForNetworkManager(config),
	};
	if (operatorId) {
		nmConfig["gsm.sim-operator-id"] = operatorId;
	}

	const uuid = await nmConnAdd(nmConfig);
	if (uuid) {
		config.conn = uuid;
		logger.debug(`Created NM connection ${uuid} for ${modemId}`, config);
	}
}

/**
 * Fetch modem info with a bounded backoff retry for transient mmcli failures.
 * `mmGetModem` swallows its own errors and returns `undefined`; we treat that
 * as a retryable failure by throwing inside the retry wrapper. Returns
 * `undefined` only after all attempts are exhausted.
 */
async function mmGetModemWithRetry(
	id: ModemId,
): Promise<ModemInfo | undefined> {
	try {
		return await retryWithBackoff(async () => {
			const info = await mmGetModem(id);
			if (!info) {
				throw new Error(`mmGetModem(${id}) returned no info`);
			}
			return info;
		}, MMCLI_RETRY);
	} catch (err) {
		logger.error(
			`Failed to get modem info for modem ${id} after retries: ${String(err)}`,
		);
		return undefined;
	}
}

/** List modem ids with a bounded backoff retry for transient mmcli failures. */
async function mmListWithRetry(): Promise<Array<ModemId> | undefined> {
	try {
		return await retryWithBackoff(async () => {
			const list = await mmList();
			if (!list) {
				throw new Error("mmList returned no result");
			}
			return list;
		}, MMCLI_RETRY);
	} catch (err) {
		logger.error(`Failed to list modems after retries: ${String(err)}`);
		return undefined;
	}
}

async function registerModem(id: number) {
	if (getModem(id)) {
		throw new Error(`Trying to register existing modem id ${id}`);
	}

	// Get all the required info for the modem
	const modemInfo = await mmGetModemWithRetry(id);
	if (!modemInfo) {
		logger.error(`Failed to get modem info for modem ${id}`);
		return;
	}

	let simInfo: SimInfo | undefined;
	let config: ModemConfig | undefined;
	if (modemInfo["modem.generic.sim"]) {
		const simId = modemInfo["modem.generic.sim"].match(
			/\/org\/freedesktop\/ModemManager1\/SIM\/(\d+)/,
		) as [string, string] | null;

		if (simId) {
			simInfo = await mmGetSim(Number.parseInt(simId[1], 10));

			// If a SIM is present, try to find a matching NM connection or create one
			if (simInfo) {
				config = await modemGetConfig(modemInfo, simInfo);

				if (config) {
					await addConnectionForModem(modemInfo, simInfo, config);
				}
			}
		}
	}

	// Find the network interface name
	let ifname: string | undefined;
	for (const port of modemInfo["modem.generic.ports"]) {
		const pattern = / \(net\)$/;
		if (port.match(pattern)) {
			ifname = port.replace(pattern, "");
			break;
		}
	}
	if (!ifname) {
		logger.error(`Failed to find the network interface for modem ${id}`);
		return;
	}

	// Find the current network type
	const networkType = modemInfo["modem.generic.current-modes"]
		? mmConvertNetworkType(modemInfo["modem.generic.current-modes"])
		: null;

	// Find the supported network types
	const networkTypes = mmConvertNetworkTypes(
		modemInfo["modem.generic.supported-modes"],
	);

	// Make sure the current mode is on the list
	if (networkType && !networkTypes[networkType.label]) {
		networkTypes[networkType.label] = {
			allowed: networkType.allowed,
			preferred: networkType.preferred,
		};
	}

	let partialImei = modemInfo["modem.generic.equipment-identifier"];
	if (partialImei) {
		partialImei = partialImei.substring(partialImei.length - 5);
	}
	const hwName = `${modemInfo["modem.generic.model"]} - ${partialImei}`;

	let simNetwork = "<NO SIM>";
	if (simInfo) {
		simNetwork = simInfo["sim.properties.operator-name"] || "Unknown";
	}

	// Bridge the already-fetched flat `-K` shape into the nested form
	// parseMmcliModel expects (no second mmcli call). Missing fields stay undefined.
	const { model, manufacturer } = parseMmcliModel({
		modem: {
			generic: {
				model: modemInfo["modem.generic.model"],
				manufacturer: (modemInfo as Record<string, unknown>)[
					"modem.generic.manufacturer"
				],
			},
		},
	});

	const modem: Modem = {
		ifname: ifname,
		name: hwName,
		sim_network: simNetwork,
		model,
		manufacturer,
		network_type: {
			supported: networkTypes,
			active: networkType?.label ?? null,
		},
		config: config,
	};

	modem.status = buildModemStatus(modemInfo, modem);

	setModem(id, modem);
}

/** Register a modem, swallowing failures so a single bad modem can't break the batch. */
async function registerModemSafe(id: ModemId): Promise<void> {
	try {
		logger.debug("Trying to register modem", id);
		await registerModem(id);
		logger.debug(
			"Registered modem",
			JSON.stringify(getModem(id), undefined, 2),
		);
	} catch (err) {
		logger.error(`Failed to register modem ${id}: ${String(err)}`);
	}
}

/**
 * Refresh a single already-registered modem's status (signal / connection /
 * registration / network). Produces a NEW `Modem` object (immutable replace)
 * so the T11 cache can detect the change by value — mutating in place would
 * make the cached previous snapshot point at the same (now-updated) object and
 * the diff would be empty.
 */
async function refreshModemStatus(id: ModemId): Promise<void> {
	const modem = getModem(id);
	if (!modem) {
		return;
	}

	const modemInfo = await mmGetModemWithRetry(id);
	if (!modemInfo) {
		return;
	}

	const status = buildModemStatus(modemInfo, modem);
	const updated: Modem = { ...modem, status, removed: undefined };
	setModem(id, updated);

	await connectModemIfNeededAndPossible(updated, id);
}

/**
 * Build a value-distinct snapshot of the legacy `modemsState` record, keyed by
 * numeric id, and publish it into the T11 cache. The cache reconciles it
 * against the previous snapshot and fires `onModemsChange` only on a non-empty
 * diff — which drives both the broadcast and (for add/remove) the gsm reset.
 */
function publishModemsSnapshot(): void {
	const snapshot: ModemsState = {};
	for (const id of getModemIds()) {
		const modem = getModem(id);
		if (modem) {
			snapshot[id] = modem;
		}
	}
	setModemsState(snapshot);
}

/**
 * Broadcast the `modems` message in response to a reconcile diff.
 *
 * Shape is preserved exactly from the legacy loop: in mock mode the FULL state
 * is sent (the mock frontend wholesale-replaces modemsState per `status`
 * message), otherwise only newly-added modems carry their full descriptor and
 * everything else is a status-only partial.
 */
function broadcastFromDiff(diff: StateDiff<ModemDiffEntry>): void {
	if (shouldUseMocks()) {
		broadcastModems(undefined);
		return;
	}
	const fullState: Record<number, true> = {};
	for (const entry of diff.added) {
		fullState[entry.id] = true;
	}
	broadcastModems(fullState);
}

function findModemIdByIfname(ifname: string): ModemId | undefined {
	for (const id of getModemIds()) {
		if (getModem(id)?.ifname === ifname) {
			return id;
		}
	}
	return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event-driven drivers
// ─────────────────────────────────────────────────────────────────────────────

/** A `modem-added` event: register (or refresh if already known) then publish. */
async function handleModemAdded(id: ModemId): Promise<void> {
	await withModemUpdateLock(async () => {
		if (getModem(id)) {
			// Already present (e.g. discovered at startup) — refresh, don't re-register.
			await refreshModemStatus(id);
		} else {
			await registerModemSafe(id);
		}
		// Publish: a freshly registered modem reconciles as `added`, which the
		// onModemsChange handler turns into a gsm reset + full broadcast.
		publishModemsSnapshot();
	});
}

/** A `modem-removed` event: drop the modem and publish the cleaned-up state. */
async function handleModemRemoved(id: ModemId): Promise<void> {
	await withModemUpdateLock(async () => {
		if (!getModem(id)) {
			return;
		}
		logger.warn(`Modem ${id} removed`);
		removeModem(id);
		// Publish: reconciles as `removed` → gsm reset + broadcast (no hot-plug recovery).
		publishModemsSnapshot();
	});
}

/** A `device-state` event for a modem's net interface: refresh that modem only. */
async function handleDeviceState(device: string): Promise<void> {
	await withModemUpdateLock(async () => {
		const id = findModemIdByIfname(device);
		if (id === undefined) {
			return;
		}
		await refreshModemStatus(id);
		publishModemsSnapshot();
	});
}

async function handleMonitorEvent(event: MonitorEvent): Promise<void> {
	switch (event.type) {
		case "modem-added":
			await handleModemAdded(Number.parseInt(event.id, 10));
			break;
		case "modem-removed":
			await handleModemRemoved(Number.parseInt(event.id, 10));
			break;
		case "device-state":
			await handleDeviceState(event.device);
			break;
		default:
			// connection-state and any other events are handled by other layers.
			break;
	}
}

/**
 * Full reconcile: list the modems currently present, register the new ones,
 * drop the gone ones, refresh the survivors, then publish. Used for the initial
 * startup state and on every monitor restart (`onResync`) — the monitor has no
 * historical replay, so a full poll is the only way to close the gap.
 *
 * This is NOT the retained status poll: it detects presence changes and so its
 * diff may carry add/remove entries (which reset gsm connections).
 */
export async function discoverModems(): Promise<void> {
	await withModemUpdateLock(async () => {
		const modemList = (await mmListWithRetry()) ?? [];
		const present = new Set<ModemId>(modemList);

		for (const id of getModemIds()) {
			if (!present.has(id)) {
				logger.warn(`Modem ${id} removed`);
				removeModem(id);
			}
		}

		for (const id of modemList) {
			if (getModem(id)) {
				await refreshModemStatus(id);
			} else {
				await registerModemSafe(id);
			}
		}

		publishModemsSnapshot();
	});
}

/**
 * Retained status poll: refresh signal/status of EVERY known modem at the
 * reduced cadence. Never lists/registers (presence is event-driven) and never
 * resets gsm connections — its diff only ever contains `changed` entries.
 */
export async function runModemStatusPoll(): Promise<void> {
	await withModemUpdateLock(async () => {
		for (const id of getModemIds()) {
			await refreshModemStatus(id);
		}
		publishModemsSnapshot();
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let initialized = false;
let monitorRef: IMonitorEmitter | null = null;
let monitorListener: ((event: MonitorEvent) => void) | null = null;
let statusPollTimer: ReturnType<typeof setInterval> | null = null;
let unsubModemsChange: (() => void) | null = null;
let unsubGsmReset: (() => void) | null = null;

// Serializes async work kicked off by sync monitor callbacks so callers (and
// tests) can await the loop reaching a quiescent state.
let pendingWork: Promise<unknown> = Promise.resolve();

function trackWork(work: Promise<unknown>): void {
	pendingWork = pendingWork.then(
		() => work,
		() => work,
	);
}

/** Resolves once all in-flight monitor-driven modem updates have settled. */
export function whenModemUpdatesSettled(): Promise<unknown> {
	return pendingWork;
}

export interface InitModemUpdateLoopOptions {
	/** Inject an emitter (tests). Defaults to the env-selected monitor manager. */
	monitor?: IMonitorEmitter;
	/** Run the initial full discovery poll. Default true. */
	autoDiscover?: boolean;
	/** Start the retained 30s status poll. Default true. */
	startPoll?: boolean;
}

/**
 * Wire the event-driven modem presence + retained status poll. Replaces the old
 * always-on 10s self-recursive `updateModems()` loop.
 */
export async function initModemUpdateLoop(
	options: InitModemUpdateLoopOptions = {},
): Promise<void> {
	if (initialized) {
		return;
	}
	initialized = true;

	const { autoDiscover = true, startPoll = true } = options;

	// `resetGsmConnections()` is wired EXCLUSIVELY through the T11 hook. It fires
	// on modem add/remove (triggered from the diff below) and on config change
	// (modems.ts) — never on a status poll.
	unsubGsmReset = onGsmConnectionsReset(() => {
		resetGsmConnections();
	});

	// Reconcile diffs drive everything observable: presence changes invalidate
	// the cached NM gsm connections, and every non-empty diff broadcasts.
	unsubModemsChange = onModemsChange((diff) => {
		for (const entry of [...diff.added, ...diff.removed]) {
			triggerGsmConnectionsReset(entry.id);
		}
		broadcastFromDiff(diff);
	});

	const monitor =
		options.monitor ??
		createMonitorManager(() => {
			// Monitor restarted — re-poll to close the no-replay gap.
			trackWork(discoverModems());
		});
	monitorRef = monitor;

	monitorListener = (event: MonitorEvent) => {
		trackWork(handleMonitorEvent(event));
	};
	monitor.on("monitor-event", monitorListener);
	monitor.start();

	if (autoDiscover) {
		await discoverModems();
	}

	if (startPoll) {
		statusPollTimer = setInterval(() => {
			trackWork(runModemStatusPoll());
		}, STATUS_POLL_INTERVAL_MS);
	}
}

/** Tear down the loop: clear the poll timer, unsubscribe, and stop the monitor. */
export function stopModemUpdateLoop(): void {
	if (statusPollTimer !== null) {
		clearInterval(statusPollTimer);
		statusPollTimer = null;
	}
	if (monitorRef && monitorListener) {
		monitorRef.off("monitor-event", monitorListener);
		monitorRef.stop();
	}
	monitorRef = null;
	monitorListener = null;
	unsubModemsChange?.();
	unsubGsmReset?.();
	unsubModemsChange = null;
	unsubGsmReset = null;
	initialized = false;
}
