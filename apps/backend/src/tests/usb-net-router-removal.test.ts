import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { buildModemsWireMessage } from "../modules/modems/modem-status.ts";
import {
	listPresentPhysicalDevices,
	resetPhysicalIdentityRegistry,
} from "../modules/modems/physical-identity.ts";
import {
	handleNetifMonitorEvent,
	netdevPresence,
	processIfconfigOutput,
	refreshRouterCellularState,
	resetNetifSnapshotForTest,
	updateNetif,
} from "../modules/network/network-interfaces.ts";
import {
	getRouterCellularMarker,
	getUsbPhysicalDescriptor,
	type RouterCellularScanDeps,
	resetUsbNetMarkers,
	usbNetScanCovers,
} from "../modules/network/router-cellular-scan.ts";
import * as websocket from "../modules/ui/websocket-server.ts";
import { stopWifiUpdateLoopForTest } from "../modules/wifi/wifi-interfaces.ts";
import {
	firstSightIfconfig,
	firstSightScan,
} from "./helpers/bond-first-sight-fixture.ts";

// Necessary: these descriptor bytes are what classify a Huawei 12d1:14dc
// CDC-data tether as router-cellular; the MM fixture cannot exercise that path.
const ROUTER = "enx0c5b8f279a64";
const IP = "192.168.8.100";
const IFACE_DIR = "/sys/devices/platform/fc400000.usb/usb3/3-1/3-1:1.0";
const DEVICE_DIR = "/sys/devices/platform/fc400000.usb/usb3/3-1";

function routerDongleDeps(): RouterCellularScanDeps {
	const attrs = new Map<string, string>([
		[`${DEVICE_DIR}/idVendor`, "12d1"],
		[`${DEVICE_DIR}/idProduct`, "14dc"],
		[`${DEVICE_DIR}/serial`, "G4PDW17B19001234"],
		[`${DEVICE_DIR}/bDeviceClass`, "00"],
		[`${DEVICE_DIR}/busnum`, "3"],
		[`${DEVICE_DIR}/devnum`, "2"],
		[`${IFACE_DIR}/bInterfaceClass`, "0a"],
		[`${IFACE_DIR}/bInterfaceSubClass`, "00"],
		[`${IFACE_DIR}/bInterfaceProtocol`, "00"],
		["/run/udev/data/c189:257", "E:ID_PATH=platform-fc400000.usb-usb-0:1:1.0"],
	]);
	return {
		sysfsRoot: "/",
		udevDataRoot: "/run/udev/data",
		listDir: async (path) => (path === DEVICE_DIR ? ["3-1:1.0"] : []),
		readAttr: async (path) => attrs.get(path),
		resolveLink: async (path) =>
			path === `/sys/class/net/${ROUTER}/device` ? IFACE_DIR : undefined,
		readLinkName: async (path) =>
			path === `${IFACE_DIR}/driver` ? "cdc_ether" : undefined,
	};
}

function routerScan() {
	return firstSightScan(firstSightIfconfig(ROUTER, IP), {
		blocked: [],
		buses: { [ROUTER]: "usb" },
		usbReader: routerDongleDeps(),
	});
}

let frames: Array<{ type: string; data: unknown }> = [];

function rosterFrames() {
	return frames.filter(
		(frame) =>
			frame.type === "status" &&
			"modems" in (frame.data as Record<string, unknown>),
	);
}

beforeEach(() => {
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
	resetPhysicalIdentityRegistry();
	jest.useFakeTimers();
	frames = [];
	spyOn(websocket, "broadcastMsg").mockImplementation((type, data) => {
		frames.push({ type, data });
	});
});

afterEach(() => {
	stopWifiUpdateLoopForTest();
	jest.restoreAllMocks();
	jest.useRealTimers();
	resetNetifSnapshotForTest();
	resetUsbNetMarkers();
	resetPhysicalIdentityRegistry();
});

for (const removal of ["monitor", "absent"] as const) {
	test(`a removed router dongle is retracted from the roster after ${removal} removal`, async () => {
		const scan = routerScan();
		await scan.settle();
		await updateNetif();
		expect(getRouterCellularMarker(ROUTER)).toBeDefined();
		expect(usbNetScanCovers(ROUTER)).toBe(true);
		expect(JSON.stringify(buildModemsWireMessage())).toContain(ROUTER);

		frames = [];
		if (removal === "monitor") {
			handleNetifMonitorEvent({
				type: "device-state",
				device: ROUTER,
				state: "disconnected",
			});
		} else {
			processIfconfigOutput("");
		}
		await refreshRouterCellularState();
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(usbNetScanCovers(ROUTER)).toBe(false);
		expect(getUsbPhysicalDescriptor(ROUTER)).toBeUndefined();
		expect(getRouterCellularMarker(ROUTER)).toBeUndefined();
		expect(listPresentPhysicalDevices()).toEqual([]);
		const rosters = rosterFrames();
		expect(rosters.length).toBeGreaterThan(0);
		expect(JSON.stringify(rosters.at(-1)?.data)).not.toContain(ROUTER);
		expect(frames.some((frame) => frame.type === "netif")).toBe(true);
	});
}

test("a monitor down-state on a name still present keeps its committed identity", async () => {
	const scan = routerScan();
	await scan.settle();
	await updateNetif();
	const presence = spyOn(netdevPresence, "inSysfs").mockReturnValue(true);

	frames = [];
	handleNetifMonitorEvent({
		type: "device-state",
		device: ROUTER,
		state: "disconnected",
	});
	await new Promise<void>((resolve) => setImmediate(resolve));

	expect(usbNetScanCovers(ROUTER)).toBe(true);
	expect(getUsbPhysicalDescriptor(ROUTER)).toBeDefined();
	expect(getRouterCellularMarker(ROUTER)).toBeDefined();
	expect(listPresentPhysicalDevices().map((device) => device.ifname)).toEqual([
		ROUTER,
	]);
	expect(presence).toHaveBeenCalledWith(ROUTER);
	expect(rosterFrames()).toEqual([]);
});
