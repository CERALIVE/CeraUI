import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";

import { checkExecPath, checkExecPathSafe } from "../helpers/exec.ts";
import { logger } from "../helpers/logger.ts";
import { getNetworkInterfaces } from "./network-interfaces.ts";
import { setup } from "./setup.ts";

const enabled = setup.moblink_relay_enabled;

const RELAY_COOLDOWN = 5_000;

export const moblinkRelayExec =
	setup.moblink_relay_bin ??
	"/opt/moblink-rust-relay/target/release/moblink-rust-relay";

type RelayProcess = ChildProcessByStdio<null, null, Readable> & {
	restartTimer?: ReturnType<typeof setTimeout>;
};

const relayProcesses = new Map<string, RelayProcess>();

type RelayOptions = {
	name: string;
	bindIpAddressDestination: string;
	streamerPassword?: string;
};

type RelayInterface = {
	name: string;
	ip: string;
};

function spawnRelay(relayOptions: RelayOptions) {
	const {
		name,
		bindIpAddressDestination,
		streamerPassword = setup.moblink_relay_streamer_password,
	} = relayOptions;

	checkExecPath(moblinkRelayExec);

	const process = spawn(
		moblinkRelayExec,
		[
			"--name",
			name,
			"--password",
			streamerPassword,
			"--bind-address",
			bindIpAddressDestination,
			"--log-level",
			"error",
		],
		{
			stdio: ["inherit", "inherit", "pipe"],
		},
	) as RelayProcess;

	relayProcesses.set(bindIpAddressDestination, process);

	process.stderr.on("data", (data) => {
		const dataStr = data.toString("utf8");
		logger.info(`Moblink relay ${name}:`, dataStr);
	});

	process.on("exit", (code) => {
		logger.warn(`Moblink relay ${name} exited with code ${code}`);

		process.restartTimer = setTimeout(() => {
			relayProcesses.delete(bindIpAddressDestination);
			spawnRelay(relayOptions);
		}, RELAY_COOLDOWN);
	});
}

function stopRelay(relayId: string) {
	const process = relayProcesses.get(relayId);
	if (!process) return true;

	if (process.restartTimer) {
		clearTimeout(process.restartTimer);
	}

	process.removeAllListeners("exit");
	process.on("exit", () => {
		relayProcesses.delete(relayId);
	});

	if (process.exitCode === null && process.signalCode === null) {
		process.kill("SIGTERM");
		return false;
	}

	relayProcesses.delete(relayId);
	return true;
}

export function initMoblinkRelays() {
	if (!enabled) return;

	if (!checkExecPathSafe(moblinkRelayExec)) {
		logger.error("Moblink relay binary not found, disabling Moblink relay");
		return;
	}

	setInterval(updateMoblinkRelayInterfaces, 60_000);

	if (!setup.moblink_relay_streamer_password) {
		logger.error("Moblink relay streamer password not set");
		return;
	}
}

function findDestinationInterfaces() {
	const networkInterfaces = getNetworkInterfaces();

	const destinationInterfaces = new Set<RelayInterface>();

	for (const interfaceName in networkInterfaces) {
		const networkInterface = networkInterfaces[interfaceName];
		if (!networkInterface) continue;

		if (networkInterface.enabled && networkInterface.error === 0) {
			destinationInterfaces.add({
				name: interfaceName,
				ip: networkInterface.ip,
			});
		}
	}
	return destinationInterfaces;
}

export function updateMoblinkRelayInterfaces() {
	if (!enabled) return;

	const oldIds = new Set(relayProcesses.keys());
	const newIds = new Set<string>();

	const destinationInterfaces = findDestinationInterfaces();

	for (const destinationInterface of destinationInterfaces) {
		newIds.add(destinationInterface.ip);

		if (!oldIds.has(destinationInterface.ip)) {
			spawnRelay({
				name: destinationInterface.name,
				bindIpAddressDestination: destinationInterface.ip,
			});
		}
	}

	// Stop relays for interfaces that are no longer enabled
	for (const oldId of oldIds) {
		if (!newIds.has(oldId)) {
			stopRelay(oldId);
		}
	}
}
