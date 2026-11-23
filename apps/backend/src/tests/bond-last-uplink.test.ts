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

function expectDisableNotice(frames: readonly string[]) {
	expect(frames.map((frame) => JSON.parse(frame))).toContainEqual({
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
	});
}

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
		return { reply, wire, requester, observer };
	} finally {
		removeClient(client);
	}
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

		const result = await observeDisable("eth0", ETHERNET_IP);
		expect(result.reply).toEqual(REFUSED);
		expectDisableNotice(result.requester);
		expect(result.observer).toEqual([]);
		expect(result.wire.eth0).toMatchObject({ ip: ETHERNET_IP, enabled: true });
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

	test("keeps the raw guard in the native hwsim guest", async () => {
		const priorRepo = process.env.HWSIM_REPO;
		process.env.HWSIM_REPO = "/repo";
		try {
			getNetworkInterfaces().eth1 = iface(SHARED_IP);
			persistEthernetRole("eth1", "shared-lan");
			expect(bondedNames()).toEqual(["eth0"]);

			expect(await toggle("eth0", ETHERNET_IP, false)).toEqual({
				success: true,
				applied: { name: "eth0", ip: ETHERNET_IP, enabled: false },
			});
			expect(bondedNames()).toEqual([]);
		} finally {
			if (priorRepo === undefined) delete process.env.HWSIM_REPO;
			else process.env.HWSIM_REPO = priorRepo;
		}
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
		});

		afterEach(() => {
			updateMockState(priorOverlay);
			if (priorMode === undefined) delete process.env.MOCK_MODE;
			else process.env.MOCK_MODE = priorMode;
		});

		test("broadcasts the mock overlay and reports applied/off when the sole raw link is refused", async () => {
			const { reply, wire, requester, observer } = await observeDisable(
				"eth0",
				REQUESTED_MOCK_IP,
			);
			expect(reply).toEqual({
				success: true,
				applied: { name: "eth0", ip: REQUESTED_MOCK_IP, enabled: false },
			});
			expectDisableNotice(requester);
			expect(lastNetifEnabled(requester, "eth0")).toBeUndefined();
			expect(observer).toHaveLength(1);
			expect(JSON.parse(observer[0] ?? "")).toMatchObject({
				netif: { eth0: { ip: REQUESTED_MOCK_IP, enabled: false } },
			});
			expect(wire.eth0).toMatchObject({
				ip: REQUESTED_MOCK_IP,
				enabled: false,
			});
			expect(bondedNames()).toEqual(["eth0"]);
		});

		test("keeps the mock raw guard through a shared-LAN release and follow-up toggle", async () => {
			getNetworkInterfaces().eth1 = iface(SHARED_IP);
			persistEthernetRole("eth1", "shared-lan");
			const first = await observeDisable("eth0", REQUESTED_MOCK_IP);
			expect(first.reply).toEqual({
				success: true,
				applied: { name: "eth0", ip: REQUESTED_MOCK_IP, enabled: false },
			});
			expect(lastNetifEnabled(first.requester, "eth0")).toBe(false);
			expect(lastNetifEnabled(first.observer, "eth0")).toBe(false);
			expect(bondedNames()).toEqual([]);
			persistEthernetRole("eth1", "uplink");
			await toggle("eth1", SHARED_IP, true);

			const follow = await observeDisable("eth1", SHARED_IP);
			expect(follow.reply).toEqual({
				success: true,
				applied: { name: "eth1", ip: SHARED_IP, enabled: false },
			});
			expectDisableNotice(follow.requester);
			expect(lastNetifEnabled(follow.observer, "eth1")).toBe(false);
			expect(follow.wire.eth0).toMatchObject({
				ip: REQUESTED_MOCK_IP,
				enabled: false,
			});
			expect(follow.wire.eth1?.enabled).toBe(false);
			expect(bondedNames()).toEqual(["eth1"]);
		});

		test("retains the mock off overlay after mapped duplicates leave the bond", async () => {
			installHuaweiIdentityResolver();
			for (const name of ["wlan0", "wlan1"]) {
				getNetworkInterfaces()[name] = {
					...iface(MODEM_IP),
					enabled: false,
					error: NETIF_ERR_DUPIPV4,
				};
			}
			expect(bondedNames()).toEqual(["eth0", "wlan0", "wlan1"]);
			await toggle("eth0", REQUESTED_MOCK_IP, false);
			await toggle("wlan0", MODEM_IP, false);
			await toggle("wlan1", MODEM_IP, false);

			const follow = await observeDisable("eth0", REQUESTED_MOCK_IP);
			expect(follow.reply).toEqual({
				success: true,
				applied: { name: "eth0", ip: REQUESTED_MOCK_IP, enabled: false },
			});
			expectDisableNotice(follow.requester);
			expect(follow.wire.eth0).toMatchObject({
				ip: REQUESTED_MOCK_IP,
				enabled: false,
			});
			expect(follow.observer).toEqual([]);
			expect(bondedNames()).toEqual(["eth0"]);
		});
	});
});
