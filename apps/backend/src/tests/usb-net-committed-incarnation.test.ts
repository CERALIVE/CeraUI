import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import {
	listPresentPhysicalDevices,
	resetPhysicalIdentityRegistry,
	resolvePhysicalDevice,
} from "../modules/modems/physical-identity.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import {
	getNetworkInterfaces,
	handleNetifMonitorEvent,
	hasNetifSnapshot,
	isBondCandidate,
	netIfBuildMsg,
	processIfconfigOutput,
	resetNetifSnapshotForTest,
	updateNetif,
} from "../modules/network/network-interfaces.ts";
import {
	getModemNetMarker,
	getUsbPhysicalDescriptor,
	identityDeadlineExpired,
	resetUsbNetMarkers,
	usbNetScanCovers,
} from "../modules/network/router-cellular-scan.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";
import { readDesiredSteeringState } from "../modules/network/uplink-steering/state-builder.ts";
import {
	genSrtlaBondEntries,
	genSrtlaBondEntriesForLocalIpAddress,
} from "../modules/streaming/srtla.ts";
import { stopWifiUpdateLoopForTest } from "../modules/wifi/wifi-interfaces.ts";
import {
	firstSightIfconfig,
	firstSightScan,
	FIRST_SIGHT_IP as IP,
	FIRST_SIGHT_IFACE as MODEM,
} from "./helpers/bond-first-sight-fixture.ts";
import { constructedTwins } from "./helpers/constructed-usb-twins.ts";

const OTHER = "wwu1u4c2";
const CLIENT = "eth9";
const output = [
	firstSightIfconfig(MODEM, IP),
	firstSightIfconfig(OTHER, "100.64.2.2"),
	firstSightIfconfig(CLIENT, "10.42.0.1"),
].join("\n\n");
const replacementDevices = constructedTwins.map((device) =>
	device.ifname === MODEM
		? {
				...device,
				readlink: "/sys/devices/platform/fc400000.usb/usb4/4-2/4-2:1.0",
				devpath: "2",
				udevadm: {
					...device.udevadm,
					ID_PATH: "platform-fc400000.usb-usb-0:2:1.0",
				},
			}
		: device,
);
let scan: ReturnType<typeof firstSightScan>;
let pending: Promise<boolean> | undefined;
let publication: ReturnType<typeof updateNetif>;

beforeEach(() => {
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
	resetPhysicalIdentityRegistry();
	jest.useFakeTimers();
	pending = undefined;
	publication = undefined;
});

afterEach(async () => {
	scan.release();
	await publication;
	await pending;
	stopWifiUpdateLoopForTest();
	jest.restoreAllMocks();
	jest.useRealTimers();
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
	resetPhysicalIdentityRegistry();
});

function steering() {
	return readDesiredSteeringState(
		{
			netifReady: hasNetifSnapshot,
			zonesReady: () => true,
			identityCovered: usbNetScanCovers,
			identityDeadlineExpired,
			interfaces: getNetworkInterfaces,
			health: () => [],
			wifiIdentity: () => undefined,
			physicalIdentity: (name) =>
				resolveModemPhysicalIdentity(name).identityKey,
			markForIdentity: stableUplinkMark,
			isBondCandidate: (name, entry) =>
				name !== CLIENT && isBondCandidate(name, entry),
			isClientZone: (name) => name === CLIENT,
			planRoute: async (candidate) => ({
				...candidate,
				table: "30001",
				managed: false,
			}),
		},
		{ hasAppliedState: true },
	);
}

for (const removal of ["monitor", "absent", "not-running"] as const) {
	test(`committed USB identity cannot reach a replacement after ${removal} removal`, async () => {
		scan = firstSightScan(output, {
			blocked: [],
			buses: { [MODEM]: "usb", [OTHER]: "usb" },
		});
		await scan.settle();
		await updateNetif();
		const oldIdentity = resolveModemPhysicalIdentity(MODEM);
		const otherIdentity = resolveModemPhysicalIdentity(OTHER);
		expect(genSrtlaBondEntries().find((e) => e.iface === MODEM)?.linkId).toBe(
			oldIdentity.linkId,
		);
		scan.clock.now = 20_000;
		expect(identityDeadlineExpired(MODEM)).toBe(true);

		if (removal === "monitor") {
			handleNetifMonitorEvent({
				type: "device-state",
				device: MODEM,
				state: "disconnected",
			});
			handleNetifMonitorEvent({
				type: "device-state",
				device: MODEM,
				state: "connected",
			});
		} else {
			processIfconfigOutput(
				removal === "absent"
					? output.replace(`${firstSightIfconfig(MODEM, IP)}\n\n`, "")
					: output.replace(",RUNNING", ""),
			);
		}
		scan = firstSightScan(output, {
			devices: replacementDevices,
			buses: { [MODEM]: "usb", [OTHER]: "usb" },
		});
		scan.clock.now = 20_000;
		pending = scan.settle();
		await scan.entered;
		publication = updateNetif();
		await new Promise<void>((resolve) => setImmediate(resolve));
		jest.advanceTimersByTime(2_000);
		await publication;

		const desired = await steering();
		expect({
			covered: usbNetScanCovers(MODEM),
			descriptor: getUsbPhysicalDescriptor(MODEM),
			modem: getModemNetMarker(MODEM),
			oldIdentity: resolveModemPhysicalIdentity(MODEM).linkId,
			present: listPresentPhysicalDevices().map((device) => device.linkId),
		}).toEqual({
			covered: false,
			descriptor: undefined,
			modem: undefined,
			oldIdentity: resolvePhysicalDevice({ ifname: MODEM }).linkId,
			present: [otherIdentity.linkId],
		});
		expect(identityDeadlineExpired(MODEM)).toBe(false);
		expect(netIfBuildMsg()[MODEM]?.enabled).toBe(false);
		expect(genSrtlaBondEntries().filter((e) => e.iface === MODEM)).toEqual([]);
		expect(
			genSrtlaBondEntriesForLocalIpAddress("100.64.1.1").filter(
				(e) => e.iface === MODEM,
			),
		).toEqual([]);
		expect(
			"uplinks" in desired ? desired.uplinks.map((u) => u.ifname) : desired,
		).toEqual([OTHER]);
		expect(usbNetScanCovers(OTHER)).toBe(true);
		expect(resolveModemPhysicalIdentity(OTHER).linkId).toBe(
			otherIdentity.linkId,
		);

		scan.release();
		await pending;
		const replacement = resolveModemPhysicalIdentity(MODEM);
		expect(replacement.linkId).not.toBe(oldIdentity.linkId);
		expect(replacement.idPath).toBe("platform-fc400000.usb-usb-0:2:1.0");
		expect(genSrtlaBondEntries().find((e) => e.iface === MODEM)?.linkId).toBe(
			replacement.linkId,
		);
		const fresh = await steering();
		expect(
			"uplinks" in fresh
				? fresh.uplinks.find((u) => u.ifname === MODEM)
				: fresh,
		).toMatchObject({
			identity: replacement.identityKey,
			mark: stableUplinkMark(replacement.identityKey),
		});
	});
}
