import { logger } from "../../helpers/logger.ts";
import { nmConnect, nmConnGetFields } from "../network/network-manager.ts";
import {
	readModemNmDeviceProp,
	resolveModemNmDeviceForConnection,
} from "./modem-nm-device.ts";
import {
	type ModemId,
	readModemRegistrationState,
	readReadyModemSim,
	resolveLateModemConfig,
} from "./modem-registration.ts";
import { getModem, getModemIds } from "./modems-state.ts";
import { modemStableKeyForId } from "./mutation-identity.ts";
import { withModemMutation } from "./mutation-lease.ts";

interface ActivationIntent {
	state: "pending" | "consumed";
	simReadable: boolean;
	lateConfigPending: boolean;
	lateConfigRunning: boolean;
}

export interface ModemReadyActivationDeps {
	readonly now: () => number;
	readonly stableKey: typeof modemStableKeyForId;
	readonly readRegistration: typeof readModemRegistrationState;
	readonly resolveDevice: typeof resolveModemNmDeviceForConnection;
	readonly readDevice: typeof readModemNmDeviceProp;
	readonly readAutoconnect: (uuid: string) => Promise<string | undefined>;
	readonly connect: typeof nmConnect;
	readonly mutate: typeof withModemMutation;
	readonly readSim: typeof readReadyModemSim;
	readonly resolveConfig: typeof resolveLateModemConfig;
}

const defaultDeps: ModemReadyActivationDeps = {
	now: () => performance.now(),
	stableKey: modemStableKeyForId,
	readRegistration: readModemRegistrationState,
	resolveDevice: resolveModemNmDeviceForConnection,
	readDevice: readModemNmDeviceProp,
	readAutoconnect: async (uuid) =>
		(await nmConnGetFields(uuid, ["connection.autoconnect"] as const))?.[0],
	connect: nmConnect,
	mutate: withModemMutation,
	readSim: readReadyModemSim,
	resolveConfig: resolveLateModemConfig,
};

let deps = defaultDeps;
const intents = new Map<ModemId, ActivationIntent>();
// Physical identities outlive MM indices and authoritative remove/re-add edges.
const lastDispatch = new Map<string, number>();
const COOLDOWN_MS = 300_000;

export function setModemReadyActivationDepsForTest(
	overrides: Partial<ModemReadyActivationDeps> | null,
): void {
	deps = overrides === null ? defaultDeps : { ...defaultDeps, ...overrides };
	intents.clear();
	lastDispatch.clear();
}

/** Called only after a genuinely new registry entry has been installed. */
export function armModemReadyActivation(id: ModemId): void {
	intents.set(id, {
		state: "pending",
		simReadable: false,
		lateConfigPending: false,
		lateConfigRunning: false,
	});
}

export function forgetModemReadyActivation(id: ModemId): void {
	intents.delete(id);
}

function isPending(id: ModemId, intent: ActivationIntent): boolean {
	return intents.get(id) === intent && intent.state === "pending";
}

async function resolveMissingConfig(
	id: ModemId,
	intent: ActivationIntent,
): Promise<boolean> {
	const modem = getModem(id);
	if (
		!modem ||
		modem.config !== undefined ||
		modem.inhibit ||
		modem.is_scanning ||
		intent.lateConfigRunning
	)
		return false;

	// Claim before the first await: overlapping polls share this readable edge.
	intent.lateConfigRunning = true;
	try {
		const sim = await deps.readSim(id);
		if (!isPending(id, intent)) return false;
		if (sim === undefined) return false;
		if (sim === "unreadable") {
			intent.simReadable = false;
			return false;
		}
		if (!intent.simReadable) intent.lateConfigPending = true;
		intent.simReadable = true;
		if (!intent.lateConfigPending) return false;
		const key = deps.stableKey(id);
		if (!key) return false;
		const current = (): boolean =>
			isPending(id, intent) &&
			deps.stableKey(id) === key &&
			getModem(id)?.config === undefined &&
			getModem(id)?.inhibit !== true &&
			getModem(id)?.is_scanning !== true;
		const result = await deps.resolveConfig(id, key, sim, current);
		if (!isPending(id, intent)) return false;
		intent.lateConfigPending = result === "pending";
		return result === "resolved";
	} finally {
		intent.lateConfigRunning = false;
	}
}

/**
 * NM success is terminal even while MM still reports connected/searching.
 * Accept only a whole numeric state, optionally followed by nmcli's label.
 */
async function readReadiness(
	id: ModemId,
	intent: ActivationIntent,
	uuid: string,
): Promise<"connected" | "ready" | undefined> {
	const device = await deps.resolveDevice(uuid);
	if (device === undefined) return undefined;
	const fields = await deps.readDevice(device, "GENERAL.STATE");
	const raw = fields?.length === 1 ? fields[0]?.trim() : undefined;
	const code = raw?.match(/^(\d+)(?: \([^()\r\n]+\))?$/)?.[1];
	if (!isPending(id, intent) || getModem(id)?.config?.conn !== uuid)
		return undefined;
	if (code === "100") {
		intent.state = "consumed";
		return "connected";
	}
	if (code !== "30") return undefined;
	if ((await deps.readRegistration(id)) !== "registered") return undefined;
	if ((await deps.readAutoconnect(uuid))?.trim() !== "yes") return undefined;
	const modem = getModem(id);
	return isPending(id, intent) &&
		modem?.config?.conn === uuid &&
		!modem.inhibit &&
		!modem.is_scanning
		? "ready"
		: undefined;
}

/** The retained status poll calls this only AFTER releasing its reconcile lock. */
export async function runModemReadyActivations(): Promise<readonly ModemId[]> {
	const configured: ModemId[] = [];
	for (const id of getModemIds()) {
		const intent = intents.get(id);
		if (intent === undefined || !isPending(id, intent)) continue;
		try {
			if (await resolveMissingConfig(id, intent)) configured.push(id);
			const uuid = getModem(id)?.config?.conn;
			if (!uuid) continue;
			if ((await readReadiness(id, intent, uuid)) !== "ready") continue;
			const key = deps.stableKey(id);
			if (!key) continue;
			const cooledDown = (): boolean => {
				const previous = lastDispatch.get(key);
				return previous === undefined || deps.now() - previous >= COOLDOWN_MS;
			};
			if (!cooledDown()) continue;
			await deps.mutate(key, async () => {
				const current = (): boolean =>
					isPending(id, intent) &&
					deps.stableKey(id) === key &&
					getModem(id)?.config?.conn === uuid &&
					cooledDown();
				if (!current()) return;
				if ((await readReadiness(id, intent, uuid)) !== "ready" || !current())
					return;
				// No await between consumption and dispatch; failure never rearms it.
				intent.state = "consumed";
				lastDispatch.set(key, deps.now());
				const result = await deps.connect(uuid, 45);
				logger.info("modem ready activation", { id, stableKey: key, result });
			});
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			logger.warn("modem readiness poll did not complete", {
				id,
				error: error.message,
			});
		}
	}
	return configured;
}
