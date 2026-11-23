import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { getMockState, updateMockState } from "../mocks/mock-service.ts";
import { getConfig, loadConfig, setConfigFilePath } from "../modules/config.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import { persistEthernetRole } from "../modules/network/ethernet-role.ts";
import {
	getNetworkInterfaces,
	NETIF_ERR_DUPIPV4,
	type NetworkInterface,
	netIfBuildMsg,
	resetNetifSnapshotForTest,
} from "../modules/network/network-interfaces.ts";
import {
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { genSrtlaBondEntries } from "../modules/streaming/srtla.ts";
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
const REQUESTED_MOCK_IP = "192.0.2.44";
const REFUSED = { success: false, error: "disable_all_refused" } as const;

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

function bondedNames(): string[] {
	return genSrtlaBondEntries().map(({ iface }) => iface);
}

describe("network.configure last-uplink protection", () => {
	let directory: string;

	beforeEach(async () => {
		resetBondFixture();
		resetNetifSnapshotForTest();
		resetUsbNetMarkers();
		directory = await mkdtemp(join(tmpdir(), "bond-last-uplink-"));
		const path = join(directory, "config.json");
		await writeFile(path, "{}");
		setConfigFilePath(path);
		await loadConfig();
		getNetworkInterfaces().eth0 = iface(ETHERNET_IP);
	});

	afterEach(async () => {
		resetBondFixture();
		resetNetifSnapshotForTest();
		resetUsbNetMarkers();
		getConfig().eth_roles = undefined;
		setConfigFilePath("config.json");
		await rm(directory, { recursive: true, force: true });
	});

	test("keeps the last uplink when the only other raw-enabled links are excluded modem twins", async () => {
		const names = constructedTwins.map(({ ifname }) => ifname);
		await refreshUsbNetMarkers(names, constructedTwinDeps());
		for (const [index, name] of names.entries()) {
			getNetworkInterfaces()[name] = {
				...iface(`198.51.100.${index + 2}`),
				usb: true,
				identitySettled: true,
			};
			const identity = resolveModemPhysicalIdentity(name);
			expect(identity.anchor).toBe("id-path");
			getConfig().bond_opt_out = {
				...getConfig().bond_opt_out,
				[identity.linkId]: true,
			};
		}
		expect(names.map((name) => getNetworkInterfaces()[name]?.enabled)).toEqual([
			true,
			true,
		]);
		expect(bondedNames()).toEqual(["eth0"]);

		expect(await toggle("eth0", ETHERNET_IP, false)).toEqual(REFUSED);
		expect(netIfBuildMsg().eth0?.enabled).toBe(true);
		expect(bondedNames()).toEqual(["eth0"]);
	});

	test("allows disabling Ethernet when a modem uplink remains", async () => {
		getNetworkInterfaces().wwan0 = {
			...iface(MODEM_IP),
			usb: true,
			identitySettled: true,
		};
		expect(bondedNames()).toEqual(["eth0", "wwan0"]);

		expect(await toggle("eth0", ETHERNET_IP, false)).toEqual({
			success: true,
			applied: { name: "eth0", ip: ETHERNET_IP, enabled: false },
		});
		expect(bondedNames()).toEqual(["wwan0"]);
	});

	test("does not count a shared-LAN port before the netif map stamps its gate", async () => {
		getNetworkInterfaces().eth1 = iface(SHARED_IP);
		persistEthernetRole("eth1", "shared-lan");
		expect(getNetworkInterfaces().eth1?.enabled).toBe(true);
		expect(bondedNames()).toEqual(["eth0"]);

		expect(await toggle("eth0", ETHERNET_IP, false)).toEqual(REFUSED);
		expect(bondedNames()).toEqual(["eth0"]);
	});

	test("reads back effective eligibility when an enable is recorded before modem identity settles", async () => {
		getNetworkInterfaces().wwan0 = {
			...iface(MODEM_IP),
			enabled: false,
			usb: true,
		};
		const frames: string[] = [];

		expect(await toggle("wwan0", MODEM_IP, true, frames)).toEqual({
			success: true,
			applied: { name: "wwan0", ip: MODEM_IP, enabled: false },
		});
		expect(lastNetifEnabled(frames, "wwan0")).toBe(false);
		expect(bondedNames()).toEqual(["eth0"]);
	});

	test("allows disabling an already gated port without removing the surviving uplink", async () => {
		getNetworkInterfaces().eth1 = iface(SHARED_IP);
		persistEthernetRole("eth1", "shared-lan");

		expect(await toggle("eth1", SHARED_IP, false)).toEqual({
			success: true,
			applied: { name: "eth1", ip: SHARED_IP, enabled: false },
		});
		expect(bondedNames()).toEqual(["eth0"]);
	});

	test("preserves the existing refusal for the sole raw-enabled link alongside a mapped duplicate", async () => {
		installHuaweiIdentityResolver();
		getNetworkInterfaces().wwan0 = {
			...iface(MODEM_IP),
			enabled: false,
			error: NETIF_ERR_DUPIPV4,
		};
		expect(bondedNames()).toEqual(["eth0", "wwan0"]);

		expect(await toggle("eth0", ETHERNET_IP, false)).toEqual(REFUSED);
		expect(bondedNames()).toEqual(["eth0", "wwan0"]);
	});

	describe("with the mock netif overlay", () => {
		let priorMode: string | undefined;
		let priorOverlay: Pick<
			ReturnType<typeof getMockState>,
			"initialized" | "netifConfigs"
		>;

		beforeEach(() => {
			priorMode = process.env.MOCK_MODE;
			const { initialized, netifConfigs } = getMockState();
			priorOverlay = { initialized, netifConfigs };
			process.env.MOCK_MODE = "true";
			updateMockState({ initialized: true, netifConfigs: new Map() });
			getNetworkInterfaces().eth1 = iface(SHARED_IP);
			persistEthernetRole("eth1", "shared-lan");
		});

		afterEach(() => {
			updateMockState(priorOverlay);
			if (priorMode === undefined) delete process.env.MOCK_MODE;
			else process.env.MOCK_MODE = priorMode;
		});

		test("refuses the last effective uplink without publishing the requested mock address or toggle", async () => {
			const requester: string[] = [];
			const observer: string[] = [];
			const client = makeRpcContext(observer).ws;
			addClient(client);
			try {
				const result = await toggle(
					"eth0",
					REQUESTED_MOCK_IP,
					false,
					requester,
				);
				const wire = await call(getNetworkInterfacesProcedure, undefined, {
					context: makeRpcContext(),
				});

				expect(requester.map((frame) => JSON.parse(frame))).toContainEqual(
					expect.objectContaining({
						notification: {
							show: [
								expect.objectContaining({
									name: "netif_disable_all",
									msg: "Can't disable all networks",
								}),
							],
						},
					}),
				);
				expect(result).toEqual(REFUSED);
				expect(wire.eth0).toMatchObject({ ip: ETHERNET_IP, enabled: true });
				expect(lastNetifEnabled(requester, "eth0")).toBeUndefined();
				expect(lastNetifEnabled(observer, "eth0")).toBeUndefined();
				expect(bondedNames()).toEqual(["eth0"]);
			} finally {
				removeClient(client);
			}
		});

		test("a follow-up disable keeps the remaining bonded link enabled in mock readback", async () => {
			await toggle("eth0", REQUESTED_MOCK_IP, false);
			persistEthernetRole("eth1", "uplink");
			await toggle("eth1", SHARED_IP, true);

			const requester: string[] = [];
			expect(await toggle("eth1", SHARED_IP, false, requester)).toEqual({
				success: true,
				applied: { name: "eth1", ip: SHARED_IP, enabled: false },
			});
			expect(bondedNames()).toEqual(["eth0"]);
			expect(lastNetifEnabled(requester, "eth1")).toBe(false);
			expect(lastNetifEnabled(requester, "eth0")).toBe(true);
			const wire = await call(getNetworkInterfacesProcedure, undefined, {
				context: makeRpcContext(),
			});
			expect(wire.eth0).toMatchObject({ ip: ETHERNET_IP, enabled: true });
			expect(wire.eth1?.enabled).toBe(false);
		});
	});
});
