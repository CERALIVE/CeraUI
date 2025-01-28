import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";

import makeMdns, {
	type MulticastDNS,
	type ResponsePacket,
} from "multicast-dns";

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
	ip: string,
	port: number,
	bindIpAddressDestination: string,
) {
	return `${ip}:${port}-${bindIpAddressDestination}`;
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
			"--log-level",
			"error",
		],
		{
			stdio: ["inherit", "inherit", "pipe"],
		},
	) as RelayProcess;

	const id = getRelayId(
		streamerIpAddress,
		streamerPort,
		bindIpAddressDestination,
	);
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

	initMdns();
	discoverStreamers();
	setInterval(discoverStreamers, 10_000);
	setInterval(updateMoblinkRelayInterfaces, 60_000);

	if (!setup.moblink_relay_streamer_password) {
		console.error("Moblink relay streamer password not set");
		return;
	}
}

const streamerAddresses = new Set<string>();

// Function to parse and display service details
async function handleMdnsResponse(response: ResponsePacket) {
	let isMoblink = false;
	let serviceName = "";
	let port = 0;
	let host = "";
	let ipv4 = "";
	let ipv6 = "";

	for (const answer of response.answers) {
		if (
			answer.type === "PTR" &&
			answer.name.startsWith("_moblink._tcp") &&
			answer.data
		) {
			isMoblink = true;
			serviceName = answer.data;
		}
	}

	if (!isMoblink) return;

	for (const answer of response.additionals) {
		if (answer.type === "SRV" && answer.data) {
			port = answer.data.port;
			host = answer.data.target;
		}
	}

	if (!host || !port) return;

	for (const answer of response.additionals) {
		if (answer.type === "A" && answer.name === host) {
			ipv4 = answer.data;
		}
		if (answer.type === "AAAA" && answer.name === host) {
			ipv6 = answer.data;
		}
	}

	const ip = ipv4 || ipv6;
	if (ip) {
		console.log(`!!! Found Moblink streamer: ${serviceName} - ${ip}:${port}`);
		streamerAddresses.add(`${ip}:${port}`);
		updateMoblinkRelayInterfaces();
	}
}

let mdns: MulticastDNS | null = null;

function initMdns() {
	if (mdns) {
		mdns.destroy();
	}

	mdns = makeMdns();
	mdns.on("response", handleMdnsResponse);
}

process.on("SIGINT", () => {
	mdns?.destroy();
});

function discoverStreamers() {
	mdns?.query([
		{
			name: "_moblink._tcp.local",
			type: "PTR",
			class: "IN",
		},
	]);
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

function findStreamerInterface(streamerIpAddress: string) {
	const networkInterfaces = getNetworkInterfaces();
	for (const interfaceName in networkInterfaces) {
		const networkInterface = networkInterfaces[interfaceName];
		if (!networkInterface) continue;

		if (
			isSameNetwork(
				streamerIpAddress,
				networkInterface.ip,
				networkInterface.netmask,
			)
		) {
			return {
				name: interfaceName,
				ip: networkInterface.ip,
			};
		}
	}
	return null;
}

export function updateMoblinkRelayInterfaces() {
	if (!enabled) return;

	const oldIds = new Set(relayProcesses.keys());
	const newIds = new Set<string>();

	const destinationInterfaces = findDestinationInterfaces();

	for (const streamer of streamerAddresses) {
		const [streamerIpAddress, portStr] = streamer.split(":") as [
			string,
			string,
		];
		const streamerPort = Number.parseInt(portStr, 10);
		const streamerInterface = findStreamerInterface(streamerIpAddress);
		for (const destinationInterface of destinationInterfaces) {
			const relayId = getRelayId(
				streamerIpAddress,
				streamerPort,
				destinationInterface.ip,
			);

			newIds.add(relayId);

			if (!oldIds.has(relayId)) {
				spawnRelay({
					name: destinationInterface.name,
					streamerIpAddress,
					streamerPort,
					bindIpAddressStreamer: streamerInterface?.ip ?? "0.0.0.0",
					bindIpAddressDestination: destinationInterface.ip,
				});
			}
		}
	}

	// Stop relays for interfaces that are no longer enabled
	for (const oldId of oldIds) {
		if (!newIds.has(oldId)) {
			stopRelay(oldId);
		}
	}
}
