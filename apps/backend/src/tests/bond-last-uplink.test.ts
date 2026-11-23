import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { accessSync, constants } from "node:fs";
import {
	chmod,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { getConfig, loadConfig, setConfigFilePath } from "../modules/config.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import { persistEthernetRole } from "../modules/network/ethernet-role.ts";
import { MockMonitorEmitter } from "../modules/network/monitor/mock-monitor.ts";
import { createMonitorManager } from "../modules/network/monitor/monitor-manager.ts";
import {
	getNetworkInterfaces,
	handleNetifMonitorEvent,
	initLastUplinkGuard,
	NETIF_ERR_DUPIPV4,
	type NetworkInterface,
	resetNetifSnapshotForTest,
} from "../modules/network/network-interfaces.ts";
import {
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { genSrtlaBondEntries } from "../modules/streaming/srtla.ts";
import { handleORPCMessage } from "../rpc/adapter.ts";
import { setSocketSenderId } from "../rpc/compat.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import {
	configureNetworkInterfaceProcedure,
	getNetworkInterfacesProcedure,
} from "../rpc/procedures/network.procedure.ts";
import {
	installHuaweiIdentityResolver,
	lastNetifEnabled,
	makeRpcContext,
	resetBondFixture,
} from "./helpers/bond-toggle-fixture.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./helpers/constructed-usb-twins.ts";

const ETHERNET_IP = "192.0.2.2";
const MODEM_IP = "198.51.100.2";
const SHARED_IP = "203.0.113.2";
const WLAN_IP = "203.0.113.40";
const REFUSED = { success: false, error: "disable_all_refused" } as const;
const applied = (name: string, ip: string, enabled: boolean) => ({
	success: true,
	applied: { name, ip, enabled },
});

const MODE_KEYS = [
	"NODE_ENV",
	"MOCK_MODE",
	"MOCK_SCENARIO",
	"HWSIM_REPO",
	"CERALIVE_DEVICE_TYPE",
] as const;
type Mode = Partial<Record<(typeof MODE_KEYS)[number], string>>;
const REAL: Mode = { NODE_ENV: "production", CERALIVE_DEVICE_TYPE: "real" };
const EMULATED: Mode = {
	NODE_ENV: "production",
	CERALIVE_DEVICE_TYPE: "emulated",
};

function setMode(mode: Mode): void {
	for (const key of MODE_KEYS) {
		const value = mode[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

// Same order as boot: the environment first, then the one-time resolution.
async function enterMode(mode: Mode): Promise<void> {
	setMode(mode);
	await initLastUplinkGuard();
}

function iface(ip: string): NetworkInterface {
	return { ip, enabled: true, error: 0, tp: 0, txb: 0, rxb: 0 };
}

function toggle(name: string, ip: string, enabled: boolean, frames?: string[]) {
	const context = makeRpcContext(frames);
	setSocketSenderId(context.ws, "last-uplink-test");
	return call(
		configureNetworkInterfaceProcedure,
		{ name, ip, enabled },
		{ context },
	);
}

const bondedNames = () => genSrtlaBondEntries().map(({ iface }) => iface);

const DISABLE_NOTICE = {
	notification: {
		show: [
			{
				name: "netif_disable_all",
				type: "error",
				msg: "Can't disable all networks",
				is_dismissable: true,
				is_persistent: false,
				duration: 10,
			},
		],
	},
	id: "last-uplink-test",
};

async function observeDisable(name: string, ip: string) {
	const requester: string[] = [];
	const observer: string[] = [];
	const client = makeRpcContext(observer).ws;
	addClient(client);
	try {
		const reply = await toggle(name, ip, false, requester);
		const wire = await call(getNetworkInterfacesProcedure, undefined, {
			context: makeRpcContext(),
		});
		return {
			reply,
			wire,
			requester: requester.map((frame): unknown => JSON.parse(frame)),
			observer,
		};
	} finally {
		removeClient(client);
	}
}

function replies(frames: readonly string[]): unknown[] {
	return frames
		.map((frame): unknown => JSON.parse(frame))
		.filter(
			(frame) =>
				typeof frame === "object" &&
				frame !== null &&
				("result" in frame || "error" in frame),
		);
}

async function disableThroughAdapter(name: string, ip: string) {
	const frames: string[] = [];
	const { ws } = makeRpcContext(frames);
	setSocketSenderId(ws, "last-uplink-test");
	await handleORPCMessage(ws, {
		id: "off",
		path: ["network", "configure"],
		input: { name, ip, enabled: false },
	});
	return frames.map((frame): unknown => JSON.parse(frame));
}

function holdSharedLanPeer(): void {
	getNetworkInterfaces().eth1 = iface(SHARED_IP);
	persistEthernetRole("eth1", "shared-lan");
	expect(bondedNames()).toEqual(["eth0"]);
}

describe("network.configure last effective uplink", () => {
	let directory: string;
	let configPath: string;
	let priorMode: Mode;

	beforeEach(async () => {
		priorMode = Object.fromEntries(
			MODE_KEYS.map((key) => [key, process.env[key]]),
		);
		await enterMode(REAL);
		resetBondFixture();
		resetNetifSnapshotForTest();
		resetUsbNetMarkers();
		directory = await mkdtemp(join(tmpdir(), "bond-last-uplink-"));
		configPath = join(directory, "config.json");
		await writeFile(configPath, "{}");
		setConfigFilePath(configPath);
		await loadConfig();
		getNetworkInterfaces().eth0 = iface(ETHERNET_IP);
	});

	afterEach(async () => {
		await enterMode(priorMode);
		resetBondFixture();
		resetNetifSnapshotForTest();
		resetUsbNetMarkers();
		getConfig().eth_roles = undefined;
		setConfigFilePath("config.json");
		await rm(directory, { recursive: true, force: true });
	});

	test("refuses Ethernet off when the only other raw-enabled links are excluded modem twins", async () => {
		const names = constructedTwins.map(({ ifname }) => ifname);
		await refreshUsbNetMarkers(names, constructedTwinDeps());
		for (const [index, name] of names.entries()) {
			getNetworkInterfaces()[name] = {
				...iface(`198.51.100.${index + 2}`),
				usb: true,
				identitySettled: true,
			};
			const { linkId } = resolveModemPhysicalIdentity(name);
			getConfig().bond_opt_out = {
				...getConfig().bond_opt_out,
				[linkId]: true,
			};
		}
		expect(bondedNames()).toEqual(["eth0"]);

		const result = await observeDisable("eth0", ETHERNET_IP);
		expect(result.reply).toEqual(REFUSED);
		expect(result.requester).toEqual([DISABLE_NOTICE]);
		expect(result.observer).toEqual([]);
		expect(result.wire.eth0).toMatchObject({ ip: ETHERNET_IP, enabled: true });
		expect(bondedNames()).toEqual(["eth0"]);
	});

	test("refuses Ethernet off when the only peer is a shared-LAN port not yet stamped", async () => {
		holdSharedLanPeer();
		expect(await toggle("eth0", ETHERNET_IP, false)).toEqual(REFUSED);
		expect(bondedNames()).toEqual(["eth0"]);
	});

	test("refuses the last mapped duplicate-IP link after its twin left the bond", async () => {
		installHuaweiIdentityResolver();
		getNetworkInterfaces().eth0 = { ...iface(ETHERNET_IP), enabled: false };
		for (const name of ["wlan0", "wlan1"]) {
			getNetworkInterfaces()[name] = {
				...iface(WLAN_IP),
				enabled: false,
				error: NETIF_ERR_DUPIPV4,
			};
		}
		expect(bondedNames()).toEqual(["wlan0", "wlan1"]);

		expect(await toggle("wlan0", WLAN_IP, false)).toEqual(
			applied("wlan0", WLAN_IP, false),
		);
		const last = await observeDisable("wlan1", WLAN_IP);
		expect(last.reply).toEqual(REFUSED);
		expect(last.requester).toEqual([DISABLE_NOTICE]);
		expect(bondedNames()).toEqual(["wlan1"]);
	});

	test("disables Ethernet while a modem uplink remains", async () => {
		getNetworkInterfaces().wwan0 = {
			...iface(MODEM_IP),
			usb: true,
			identitySettled: true,
		};
		expect(await toggle("eth0", ETHERNET_IP, false)).toEqual(
			applied("eth0", ETHERNET_IP, false),
		);
		expect(bondedNames()).toEqual(["wwan0"]);
	});

	test("disables a link the bond does not use while the last uplink stays", async () => {
		holdSharedLanPeer();
		expect(await toggle("eth1", SHARED_IP, false)).toEqual(
			applied("eth1", SHARED_IP, false),
		);
		expect(bondedNames()).toEqual(["eth0"]);
	});

	const unguarded: [string, Mode][] = [
		["emulated host", EMULATED],
		["native hwsim guest", { ...REAL, HWSIM_REPO: "/repo" }],
		["development", { ...REAL, NODE_ENV: "development" }],
		[
			"MOCK_MODE without an initialized overlay",
			{ ...REAL, MOCK_MODE: "true" },
		],
		[
			"scenario-only mock monitor",
			{ ...REAL, MOCK_SCENARIO: "multi-modem-wifi" },
		],
		["test-only mock monitor", { ...REAL, NODE_ENV: "test" }],
	];

	test.each(unguarded)(
		"keeps main's accepted disable on the %s path",
		async (_label, mode) => {
			await enterMode(mode);
			holdSharedLanPeer();
			const { reply, wire } = await observeDisable("eth0", ETHERNET_IP);
			expect(reply).toEqual(applied("eth0", ETHERNET_IP, false));
			expect(wire.eth0?.enabled).toBe(false);
			expect(bondedNames()).toEqual([]);
		},
	);

	test("keeps main's accepted disable when the boot-time scenario selector is cleared later", async () => {
		await enterMode({ ...REAL, MOCK_SCENARIO: "multi-modem-wifi" });
		setMode(REAL);
		holdSharedLanPeer();
		expect(await toggle("eth0", ETHERNET_IP, false)).toEqual(
			applied("eth0", ETHERNET_IP, false),
		);
		expect(bondedNames()).toEqual([]);
	});

	test("keeps main's accepted disable until a real environment arms the guard", async () => {
		await enterMode(EMULATED);
		setMode(REAL);
		holdSharedLanPeer();
		expect(await toggle("eth0", ETHERNET_IP, false)).toEqual(
			applied("eth0", ETHERNET_IP, false),
		);
		expect(bondedNames()).toEqual([]);
	});

	test.each([
		["scenario-only", { ...REAL, MOCK_SCENARIO: "multi-modem-wifi" }],
		["test-only", { ...REAL, NODE_ENV: "test" }],
	] as [string, Mode][])(
		"keeps main's accepted disable when the %s mock monitor adds a raw link",
		async (_label, mode) => {
			await enterMode(mode);
			const monitor = createMonitorManager(() => undefined);
			if (!(monitor instanceof MockMonitorEmitter))
				throw new Error("expected the mock monitor");
			monitor.on("monitor-event", handleNetifMonitorEvent);
			const delivered = new Promise<void>((resolve) =>
				monitor.on("monitor-event", () => resolve()),
			);
			monitor.script([
				{
					delayMs: 0,
					event: { type: "device-state", device: "wlan0", state: "connected" },
				},
			]);
			try {
				monitor.start();
				await delivered;
			} finally {
				monitor.reset();
			}
			expect(getNetworkInterfaces().wlan0).toMatchObject({ enabled: true });
			expect(bondedNames()).toEqual(["eth0"]);

			expect(await toggle("eth0", ETHERNET_IP, false)).toEqual(
				applied("eth0", ETHERNET_IP, false),
			);
			expect(bondedNames()).toEqual([]);
		},
	);

	test.each([
		["real", REAL],
		["emulated", EMULATED],
	] as [string, Mode][])(
		"applies overlapping off then on in arrival order on a %s host",
		async (_label, mode) => {
			await enterMode(mode);
			getNetworkInterfaces().wlan0 = iface(WLAN_IP);
			const frames: string[] = [];
			const { ws } = makeRpcContext(frames);
			await Promise.all(
				[false, true].map((enabled) =>
					handleORPCMessage(ws, {
						id: enabled ? "on" : "off",
						path: ["network", "configure"],
						input: { name: "eth0", ip: ETHERNET_IP, enabled },
					}),
				),
			);
			expect(
				frames.flatMap((frame) => lastNetifEnabled([frame], "eth0") ?? []),
			).toEqual([false, true]);
			expect(replies(frames)).toEqual([
				{ id: "off", result: applied("eth0", ETHERNET_IP, false) },
				{ id: "on", result: applied("eth0", ETHERNET_IP, true) },
			]);
			expect(bondedNames()).toEqual(["eth0", "wlan0"]);
		},
	);

	test("keeps main's write error when the config directory cannot be written", async () => {
		installHuaweiIdentityResolver();
		holdSharedLanPeer();
		const saved = await readFile(configPath, "utf8");
		await chmod(directory, 0o500);
		try {
			expect(() => accessSync(directory, constants.W_OK)).toThrow();
			const frames = await disableThroughAdapter("eth0", ETHERNET_IP);
			expect(frames).toHaveLength(1);
			expect(frames[0]).toMatchObject({
				id: "off",
				error: {
					code: "INTERNAL_ERROR",
					message: expect.stringContaining("EACCES"),
				},
			});
			expect(bondedNames()).toEqual([]);
			expect(await readFile(configPath, "utf8")).toBe(saved);
		} finally {
			await chmod(directory, 0o700);
		}
	});

	test("still refuses when only the config file is read-only, which the atomic save replaces", async () => {
		installHuaweiIdentityResolver();
		holdSharedLanPeer();
		const saved = await readFile(configPath, "utf8");
		await chmod(configPath, 0o444);
		const frames = await disableThroughAdapter("eth0", ETHERNET_IP);
		expect(frames).toEqual([DISABLE_NOTICE, { id: "off", result: REFUSED }]);
		expect(bondedNames()).toEqual(["eth0"]);
		expect(await readFile(configPath, "utf8")).toBe(saved);
		expect(await readdir(directory)).toEqual(["config.json"]);
	});
});
