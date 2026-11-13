import {
	afterEach,
	beforeEach,
	expect,
	jest,
	mock,
	spyOn,
	test,
} from "bun:test";
import { statusResponseSchema, type WifiStatus } from "@ceraui/rpc/schemas";
import { logger } from "../helpers/logger.ts";
import { StatusSchema } from "../modules/remote-control/protocol.ts";
import {
	getControlChannel,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
import { broadcastWifiState } from "../modules/wifi/wifi.ts";
import {
	resetWifiCapabilitiesForTest,
	setWifiCapabilityDepsForTest,
} from "../modules/wifi/wifi-capabilities.ts";
import { addWifiInterface } from "../modules/wifi/wifi-connections.ts";
import {
	pollHotspotClients,
	refreshHotspotClients,
	resetHotspotClientsForTest,
	setHotspotClientsChangeListener,
	setHotspotClientsDepsForTest,
} from "../modules/wifi/wifi-hotspot-clients.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../modules/wifi/wifi-radio-observation.ts";
import { invalidateWifiRadioRow } from "../modules/wifi/wifi-radio-publication.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { statusClient } from "./helpers/status-client.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

let registry: ReturnType<typeof isolateWifiRegistry>;
let channel: ReturnType<typeof getControlChannel>;
let client: ReturnType<typeof statusClient> | undefined;
let release: (() => void) | undefined;
let poll: Promise<void> | undefined;

async function advance(): Promise<void> {
	jest.advanceTimersByTime(0);
	for (let n = 0; n < 128; n++) await Promise.resolve();
}

beforeEach(async () => {
	jest.useFakeTimers();
	jest.setSystemTime(0);
	registry = isolateWifiRegistry();
	channel = getControlChannel();
	setControlChannel(null);
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	await wifiRadioIdentity.discover([]);
	resetHotspotClientsForTest();
	resetWifiCapabilitiesForTest();
	setWifiCapabilityDepsForTest({
		runIw: async () => "",
		readPhyName: async () => undefined,
		pathExists: async () => false,
		readNmcliWifiProperties: async () => new Map(),
		now: () => 0,
	});
	for (const level of ["error", "warn", "info", "debug"] as const)
		spyOn(logger, level).mockImplementation(() => logger);
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) =>
		path.endsWith("/ifindex")
			? path.includes("wlan1")
				? "4"
				: "3"
			: path.endsWith("/index")
				? path.includes("phy1")
					? "1"
					: "0"
				: path.includes("phy1")
					? "dc:a6:32:aa:bb:cc"
					: "58:02:05:e1:79:1c",
	);
	spyOn(radioIdentityReaders, "realpath").mockImplementation(
		async (path) =>
			`/sys/devices/radio/phy${path.includes("wlan1") ? "1" : "0"}`,
	);
});

afterEach(async () => {
	wifiRadioObservation.stop();
	if (client) removeClient(client);
	resetHotspotClientsForTest();
	release?.();
	await poll;
	await wifiRadioObservation.settled;
	resetWifiCapabilitiesForTest();
	setControlChannel(channel);
	restoreWifiRegistry(registry);
	mock.restore();
	client = undefined;
	release = undefined;
	poll = undefined;
	jest.useRealTimers();
});

test("a local token frame cannot acknowledge a pending two-AP global roster change", async () => {
	const rows = [0, 1].map((id) => ({
		id,
		ifname: `wlan${id}`,
		conn: "hotspot",
		activeMode: "ap" as const,
		hw: "radio",
		available: new Map(),
		saved: {},
		savedAll: {},
		hotspot: {
			conn: "hotspot",
			availableChannels: ["auto" as const],
			warnings: {},
		},
	}));
	for (const row of rows)
		addWifiInterface(
			row.id === 0 ? "58:02:05:e1:79:1c" : "dc:a6:32:aa:bb:cc",
			row,
		);
	const local: WifiStatus[] = [];
	const remote: unknown[] = [];
	let tokenSnapshot: WifiStatus | undefined;
	let remoteAtToken: number | undefined;
	client = statusClient((raw) => {
		const frame: unknown = JSON.parse(raw);
		if (typeof frame !== "object" || frame === null || !("status" in frame))
			throw new Error("Expected a Wi-Fi status frame");
		const rows = statusResponseSchema.parse(frame.status).wifi ?? {};
		local.push(rows);
		if (tokenSnapshot === undefined && rows[0]?.incarnation !== undefined) {
			tokenSnapshot = rows;
			remoteAtToken = remote.length;
		}
	});
	addClient(client);
	setControlChannel({
		isConnected: () => true,
		sendFrame: (frame) => {
			remote.push(frame);
		},
	});
	setHotspotClientsDepsForTest({ now: () => 0, runIw: async () => "" });
	await refreshHotspotClients(["wlan0", "wlan1"]);
	broadcastWifiState();
	local.length = 0;
	remote.length = 0;
	setHotspotClientsChangeListener(broadcastWifiState);
	const second = Promise.withResolvers<string>();
	release = () => second.resolve("");
	setHotspotClientsDepsForTest({
		now: () => 0,
		runIw: async (args) =>
			args[1] === "wlan0"
				? "Station aa:bb:cc:dd:ee:ab (on wlan0)\n"
				: second.promise,
	});
	poll = pollHotspotClients(() => ["wlan0", "wlan1"]);
	await advance();
	const generation = wifiRadioIdentity.captureObservation();
	for (const row of rows) invalidateWifiRadioRow(row, generation);
	wifiRadioObservation.enqueue(
		rows.map((row) => ({ ifname: row.ifname, row })),
		generation,
	);
	await advance();
	expect(tokenSnapshot?.[0]?.incarnation).toEqual(expect.any(String));
	expect(tokenSnapshot?.[0]?.hotspot?.clients?.count).toBe(1);
	expect(remoteAtToken).toBe(0);
	second.resolve("");
	await poll;
	await pollHotspotClients(() => ["wlan0", "wlan1"]);
	expect(local.map((frame) => frame[0]?.hotspot?.clients?.count)).toEqual([
		1, 1,
	]);
	expect(remote).toHaveLength(1);
	expect(StatusSchema.parse(remote[0]).payload).toMatchObject({
		wifi: {
			"0": {
				hotspot: {
					clients: { count: 1, stations: [{ mac: "aa:bb:cc:dd:ee:ab" }] },
				},
			},
			"1": { hotspot: { clients: { count: 0, stations: [] } } },
		},
	});
});
