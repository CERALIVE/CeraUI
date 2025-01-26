import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";

import { isSameNetwork } from "../helpers/ip-adresses.ts";

import { getNetworkInterfaces } from "./network-interfaces.ts";
import { setup } from "./setup.ts";

const enabled = setup.moblink_relay_enabled;

const RELAY_COOLDOWN = 5_000;

export const relayExec =
	setup.moblink_relay_bin ??
	"/opt/moblink-rust-relay/target/release/moblink-rust-relay";

type RelayProcess = ChildProcessByStdio<null, null, Readable> & {
	restartTimer?: ReturnType<typeof setTimeout>;
};

const relayProcesses = new Map<string, RelayProcess>();

type RelayOptions = {
	name: string;
	bindIpAddressStreamer: string;
	bindIpAddressDestination: string;
	streamerIpAddress?: string;
	streamerPort?: number;
	streamerPassword?: string;
};

type RelayInterface = {
	name: string;
	ip: string;
};

function getRelayId(
	bindIpAddressStreamer: string,
	bindIpAddressDestination: string,
) {
	return `${bindIpAddressStreamer}-${bindIpAddressDestination}`;
}

function spawnRelay(relayOptions: RelayOptions) {
	const {
		name,
		bindIpAddressStreamer,
		bindIpAddressDestination,
		streamerIpAddress = setup.moblink_relay_streamer_ip,
		streamerPort = setup.moblink_relay_streamer_port,
		streamerPassword = setup.moblink_relay_streamer_password,
	} = relayOptions;

	const process = spawn(
		relayExec,
		[
			"--name",
			name,
			"--streamer-url",
			`ws://${streamerIpAddress}:${streamerPort}`,
			"--password",
			streamerPassword,
			"--bind-address",
			bindIpAddressStreamer,
			"--bind-address",
			bindIpAddressDestination,
		],
		{
			stdio: ["inherit", "inherit", "pipe"],
		},
	) as RelayProcess;

	const id = getRelayId(bindIpAddressStreamer, bindIpAddressDestination);
	relayProcesses.set(id, process);

	process.stderr.on("data", (data) => {
		const dataStr = data.toString("utf8");
		console.log(`Moblink relay ${name}:`, dataStr);
	});

	process.on("exit", (code) => {
		console.error(`Moblink relay ${name} exited with code ${code}`);

		process.restartTimer = setTimeout(() => {
			relayProcesses.delete(id);
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

	if (!setup.moblink_relay_streamer_ip) {
		console.error("Moblink relay streamer IP not set");
		return;
	}

	if (!setup.moblink_relay_streamer_port) {
		console.error("Moblink relay streamer port not set");
		return;
	}

	if (!setup.moblink_relay_streamer_password) {
		console.error("Moblink relay streamer password not set");
		return;
	}
}

export function updateMoblinkRelayInterfaces() {
	if (!enabled) return;

	const oldIds = new Set(relayProcesses.keys());

	const networkInterfaces = getNetworkInterfaces();

	const streamerInterfaces = new Set<RelayInterface>();
	const destinationInterfaces = new Set<RelayInterface>();

	for (const interfaceName in networkInterfaces) {
		const networkInterface = networkInterfaces[interfaceName];
		if (!networkInterface) continue;

		if (
			isSameNetwork(
				setup.moblink_relay_streamer_ip,
				networkInterface.ip,
				networkInterface.netmask,
			)
		) {
			streamerInterfaces.add({
				name: interfaceName,
				ip: networkInterface.ip,
			});
		}

		if (networkInterface.enabled && networkInterface.error === 0) {
			destinationInterfaces.add({
				name: interfaceName,
				ip: networkInterface.ip,
			});
		}
	}

	const newIds = new Set<string>();

	for (const streamerInterface of streamerInterfaces) {
		for (const destinationInterface of destinationInterfaces) {
			const id = getRelayId(streamerInterface.ip, destinationInterface.ip);
			if (!oldIds.has(id)) {
				spawnRelay({
					name: destinationInterface.name,
					bindIpAddressStreamer: streamerInterface.ip,
					bindIpAddressDestination: destinationInterface.ip,
				});
			}
			newIds.add(id);
		}
	}

	// Stop relays for interfaces that are no longer enabled
	for (const oldId of oldIds) {
		if (!newIds.has(oldId)) {
			stopRelay(oldId);
		}
	}
}
