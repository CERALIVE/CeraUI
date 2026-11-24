import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as runner from "../helpers/run.ts";
import { getConfig, setConfigFilePath } from "../modules/config.ts";
import {
	defaultCredentialVerifyDeps,
	verifyModemCredential,
} from "../modules/modems/modem-credential-verify.ts";
import {
	readLockOpenEvidence,
	resetModemLockSessionsForTest,
} from "../modules/modems/modem-lock-state.ts";
import { buildModemsWireMessage } from "../modules/modems/modem-status.ts";
import {
	listPresentPhysicalDevices,
	resetPhysicalIdentityRegistry,
} from "../modules/modems/physical-identity.ts";
import {
	netdevRunning,
	onNetdevRetired,
	readNetdevWitness,
	resetNetdevLifetimesForTest,
} from "../modules/network/netdev-lifetime.ts";
import {
	getNetworkInterfaces,
	handleNetifMonitorEvent,
	netdevPresence,
	netIfBuildMsg,
	processIfconfigOutput,
	refreshRouterCellularState,
	resetBondOptOut,
	resetNetifSnapshotForTest,
	setBondOptOut,
	updateNetif,
} from "../modules/network/network-interfaces.ts";
import {
	getRouterCellularAdmin,
	type RouterAdminProbeDeps,
	refreshRouterCellularAdmin,
	resetRouterCellularAdmin,
} from "../modules/network/router-cellular-admin.ts";
import {
	defaultRouterCellularScanDeps,
	getRouterCellularMarker,
	getUsbPhysicalDescriptor,
	type RouterCellularScanDeps,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
	usbNetScanCovers,
} from "../modules/network/router-cellular-scan.ts";
import {
	setUplinkHealthEngineForTest,
	UplinkHealthEngine,
	type UplinkHealthOutcome,
	UplinkHealthRuntime,
} from "../modules/network/uplink-health/index.ts";
import {
	genSrtlaBondEntries,
	genSrtlaBondEntriesForLocalIpAddress,
} from "../modules/streaming/srtla.ts";
import * as websocket from "../modules/ui/websocket-server.ts";
import { stopWifiUpdateLoopForTest } from "../modules/wifi/wifi-interfaces.ts";
import {
	firstSightIfconfig,
	firstSightScan,
} from "./helpers/bond-first-sight-fixture.ts";
import { constructedTwins } from "./helpers/constructed-usb-twins.ts";

// Necessary: these descriptor bytes are what classify a Huawei 12d1:14dc
// CDC-data tether as router-cellular; the MM fixture cannot exercise that path.
const ROUTER = "enx0c5b8f279a64";
const IP = "192.168.8.100";
const REPLACEMENT_IP = "192.168.22.100";
const ROUTER_LINK = "lnk_002ad4484fa592c0";
const IFACE_DIR = "/sys/devices/platform/fc400000.usb/usb3/3-1/3-1:1.0";
const DEVICE_DIR = "/sys/devices/platform/fc400000.usb/usb3/3-1";

function routerDongleDeps(
	serial = "G4PDW17B19001234",
	name = ROUTER,
): RouterCellularScanDeps {
	const attrs = new Map<string, string>([
		[`${DEVICE_DIR}/idVendor`, "12d1"],
		[`${DEVICE_DIR}/idProduct`, "14dc"],
		[`${DEVICE_DIR}/serial`, serial],
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
			path === `/sys/class/net/${name}/device` ? IFACE_DIR : undefined,
		readLinkName: async (path) =>
			path === `${IFACE_DIR}/driver` ? "cdc_ether" : undefined,
	};
}

function routerScan(serial?: string, name = ROUTER, ip = IP) {
	return firstSightScan(firstSightIfconfig(name, ip), {
		blocked: [],
		buses: { [name]: "usb" },
		usbReader: routerDongleDeps(serial, name),
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
	resetBondOptOut();
	resetRouterCellularAdmin();
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
	resetBondOptOut();
	resetRouterCellularAdmin();
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
		// One microtask turn, before any periodic scan: the removal itself must
		// publish a netif without the name, and the committed caches must be gone.
		await Promise.resolve();

		const netifFrames = frames.filter((frame) => frame.type === "netif");
		expect(netifFrames.length).toBeGreaterThan(0);
		expect(JSON.stringify(netifFrames.at(-1)?.data)).not.toContain(ROUTER);
		expect(usbNetScanCovers(ROUTER)).toBe(false);
		expect(getUsbPhysicalDescriptor(ROUTER)).toBeUndefined();
		expect(getRouterCellularMarker(ROUTER)).toBeUndefined();
		expect(listPresentPhysicalDevices()).toEqual([]);

		// The roster broadcaster loads its module lazily, which needs one event-loop
		// turn (not a timed wait), still before the periodic scan.
		await new Promise<void>((resolve) => setImmediate(resolve));
		const rosters = rosterFrames();
		expect(rosters.length).toBeGreaterThan(0);
		expect(JSON.stringify(rosters.at(-1)?.data)).not.toContain(ROUTER);

		// The periodic scan starts from the emptied caches, so it adds nothing.
		frames = [];
		await refreshRouterCellularState();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(rosterFrames()).toEqual([]);
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

function pollRouter(ifindex: number) {
	processIfconfigOutput(
		firstSightIfconfig(ROUTER, IP),
		undefined,
		undefined,
		undefined,
		new Map([[ROUTER, ifindex]]),
	);
}

function routerState(state: string) {
	handleNetifMonitorEvent({ type: "device-state", device: ROUTER, state });
}

function addressedBond(name = ROUTER) {
	return genSrtlaBondEntries().find((row) => row.iface === name);
}

function ipSample(name: string, index: number, ip: string): string {
	return `${index}: ${name}: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n    inet ${ip}/24 scope global ${name}\n`;
}

test("a sysfs index witness taken by the scan retracts the addressed bond on a connected-only replacement", async () => {
	const readFile = spyOn(fs, "readFileSync").mockReturnValue("7\n");
	spyOn(netdevPresence, "inSysfs").mockReturnValue(true);
	await routerScan().settle();
	processIfconfigOutput(firstSightIfconfig(ROUTER, IP));
	expect(addressedBond()?.linkId).toBe(ROUTER_LINK);

	readFile.mockReturnValue("17\n");
	expect(netdevPresence.ifindex(ROUTER)).toBe(17);
	routerState("connected");

	expect(addressedBond()).toBeUndefined();
	expect(JSON.stringify(buildModemsWireMessage())).not.toContain(ROUTER);
	readFile.mockReturnValue("17oops");
	expect(netdevPresence.ifindex(ROUTER)).toBeUndefined();
});

test("ifconfig fallback does not erase a known witness during a flap", async () => {
	const [modem] = constructedTwins;
	if (!modem) throw new Error("missing reviewer modem fixture");
	const { ifname } = modem;
	const output = firstSightIfconfig(ifname, "192.0.2.10");
	await firstSightScan(output, {
		blocked: [],
		buses: { [ifname]: "usb" },
	}).settle();
	processIfconfigOutput(
		output,
		undefined,
		undefined,
		undefined,
		new Map([[ifname, 7]]),
	);
	const state = (next: string) =>
		handleNetifMonitorEvent({
			type: "device-state",
			device: ifname,
			state: next,
		});
	let index = 7;
	spyOn(netdevPresence, "inSysfs").mockReturnValue(true);
	spyOn(netdevPresence, "ifindex").mockImplementation(() => index);
	const old = addressedBond(ifname)?.linkId;
	expect(old).toBe("lnk_8309b0f56c21b4ac");
	state("disconnected");
	spyOn(runner, "run").mockImplementation(async (bin) => {
		if (bin === "ifconfig") return output;
		throw new Error("ip not available");
	});
	await updateNetif();
	expect(addressedBond(ifname)?.linkId).toBe(old);

	index = 17;
	state("connected");

	expect(addressedBond(ifname)).toBeUndefined();
	expect(getUsbPhysicalDescriptor(ifname)).toBeUndefined();
});

test("a read with neither ip nor sysfs index keeps the previous witness until replacement is observed", async () => {
	await routerScan().settle();
	pollRouter(7);
	const readIndex = spyOn(netdevPresence, "ifindex").mockReturnValue(undefined);
	await updateNetif();
	expect(addressedBond()?.linkId).toBe(ROUTER_LINK);

	readIndex.mockReturnValue(7);
	routerState("connected");
	expect(addressedBond()?.linkId).toBe(ROUTER_LINK);

	readIndex.mockReturnValue(17);
	routerState("connected");

	expect(addressedBond()).toBeUndefined();
});

test("poll-only replacement resets bond admission and counter baseline without borrowing coverage", async () => {
	await routerScan().settle();
	let index = 7;
	let output = firstSightIfconfig(ROUTER, IP);
	spyOn(runner, "run").mockImplementation(async (bin) =>
		bin === "ifconfig" ? output : ipSample(ROUTER, index, IP),
	);
	await updateNetif();
	expect(addressedBond()).toBeDefined();

	index = 17;
	output = output.replace("TX packets 1  bytes 0", "TX packets 1  bytes 200");
	await updateNetif();

	expect(netIfBuildMsg()[ROUTER]).toMatchObject({ enabled: false, tp: 0 });
	expect(addressedBond()).toBeUndefined();
	expect(genSrtlaBondEntriesForLocalIpAddress("192.168.8.1")).toEqual([]);
	await routerScan("replacement-serial").settle();
	pollRouter(17);
	expect(addressedBond()?.linkId).toBeDefined();
	expect(addressedBond()?.linkId).not.toBe(ROUTER_LINK);
});

test("poll resamples rather than combining the address and ifindex of a renamed netdev", async () => {
	const oldName = ROUTER;
	const newName = "enx0c5b8f279a65";
	const oldOutput = firstSightIfconfig(oldName, IP);
	const newOutput = firstSightIfconfig(newName, IP);
	await routerScan().settle();
	pollRouter(7);
	let reads = 0;
	routerScan(undefined, newName);
	spyOn(runner, "run").mockImplementation(async (bin) => {
		if (bin === "ifconfig") return ++reads === 1 ? oldOutput : newOutput;
		return ipSample(newName, 7, IP);
	});

	await updateNetif();

	expect(getNetworkInterfaces()[oldName]).toBeUndefined();
	expect(addressedBond(newName)?.ip).toBe(IP);
});

test("poll retries if sysfs no longer agrees with ip's same-name header", async () => {
	const index = spyOn(netdevPresence, "ifindex").mockReturnValue(7);
	await routerScan().settle();
	pollRouter(7);
	index.mockReturnValue(17);
	let first = true;
	const next = firstSightIfconfig(ROUTER, REPLACEMENT_IP);
	spyOn(runner, "run").mockImplementation(async (bin) => {
		if (bin === "ifconfig") return next;
		if (!first) return ipSample(ROUTER, 17, REPLACEMENT_IP);
		first = false;
		return ipSample(ROUTER, 7, IP);
	});
	await updateNetif();
	expect(netIfBuildMsg()[ROUTER]).toMatchObject({
		ip: REPLACEMENT_IP,
		enabled: false,
	});
});

test("retirement after the poll's bus await cannot publish the departed address", async () => {
	let index = 7;
	spyOn(netdevPresence, "ifindex").mockImplementation(() => index);
	const scan = routerScan();
	scan.block(ROUTER);
	const poll = updateNetif();
	try {
		await scan.enteredFor(ROUTER);
		index = 17;
		jest.advanceTimersByTime(2_000);
		await poll;
		expect(getNetworkInterfaces()[ROUTER]).toBeUndefined();
		expect(addressedBond()).toBeUndefined();
	} finally {
		scan.release();
		await poll;
		await scan.settle();
	}
});

for (const [sample, withdrawn, unreadableIndex] of [
	["confirmed absent", true, undefined],
	["unreadable", false, undefined],
	// The sysfs node is unreadable at the next sample, but its index still is.
	["confirmed absent after an unreadable sample", true, 7],
] as const) {
	test(`a known netdev ${sample} at the poll's commit ${withdrawn ? "is withdrawn" : "stays published"} beside a pending sibling`, async () => {
		const [sibling] = constructedTwins;
		if (!sibling) throw new Error("missing sibling fixture");
		let present: boolean | undefined = true;
		spyOn(netdevPresence, "inSysfs").mockImplementation((name) =>
			name === ROUTER ? present : true,
		);
		spyOn(netdevPresence, "ifindex").mockImplementation((name) =>
			name !== ROUTER
				? undefined
				: present
					? 7
					: present === undefined
						? unreadableIndex
						: undefined,
		);
		await routerScan().settle();
		pollRouter(7);
		expect(addressedBond()?.linkId).toBe(ROUTER_LINK);
		const scan = firstSightScan(
			`${firstSightIfconfig(ROUTER, IP)}\n\n${firstSightIfconfig(sibling.ifname, "192.0.2.10")}`,
			{
				usbReader: routerDongleDeps(),
				buses: { [ROUTER]: "usb", [sibling.ifname]: "usb" },
				blocked: [sibling.ifname],
			},
		);
		if (sample === "confirmed absent after an unreadable sample") {
			present = undefined;
		}
		const poll = updateNetif();
		try {
			await scan.enteredFor(sibling.ifname);
			present = withdrawn ? false : undefined;
			jest.advanceTimersByTime(2_000);
			await poll;
			expect(addressedBond()?.linkId).toBe(withdrawn ? undefined : ROUTER_LINK);
			expect(netIfBuildMsg()[ROUTER]?.ip).toBe(withdrawn ? undefined : IP);
			expect(getUsbPhysicalDescriptor(ROUTER) !== undefined).toBe(!withdrawn);
			expect(netIfBuildMsg()[sibling.ifname]).toMatchObject({
				ip: "192.0.2.10",
				enabled: false,
			});
		} finally {
			scan.release();
			await poll;
		}
	});
}

test("the sysfs readers report absence and unreadable nodes but never hide a fault", () => {
	const stat = spyOn(fs, "statSync").mockReturnValue(undefined);
	expect(netdevPresence.inSysfs(ROUTER)).toBe(false);
	expect(readNetdevWitness(ROUTER)).toMatchObject({ present: false });
	stat.mockImplementation(() => {
		throw Object.assign(new Error("sysfs I/O error"), { code: "EIO" });
	});
	expect(netdevPresence.inSysfs(ROUTER)).toBeUndefined();
	expect(readNetdevWitness(ROUTER).node).toBeUndefined();
	stat.mockImplementation(() => {
		throw new TypeError("not an operating-system error");
	});
	expect(() => netdevPresence.inSysfs(ROUTER)).toThrow(TypeError);
	expect(() => readNetdevWitness(ROUTER)).toThrow(TypeError);
	stat.mockRestore();
	spyOn(fs, "readFileSync").mockImplementation(() => {
		throw new TypeError("not an operating-system error");
	});
	expect(() => netdevPresence.ifindex(ROUTER)).toThrow(TypeError);
	expect(() => netdevRunning(ROUTER)).toThrow(TypeError);
});

test("a connected-only reappearance that first establishes a kernel witness is held for reclassification", async () => {
	const index = spyOn(netdevPresence, "ifindex").mockReturnValue(undefined);
	spyOn(netdevPresence, "inSysfs").mockReturnValue(true);
	await routerScan().settle();
	await updateNetif();
	expect(addressedBond()?.linkId).toBe(ROUTER_LINK);

	index.mockReturnValue(7);
	routerState("connected");
	expect(addressedBond()).toBeUndefined();

	await routerScan().settle();
	pollRouter(7);
	expect(addressedBond()?.linkId).toBe(ROUTER_LINK);
});

for (const row of [
	{
		returning: "the same node and index with a new MAC",
		node: true,
		index: 7,
		kept: true,
	},
	{
		returning: "the same node with a new index",
		node: true,
		index: 17,
		kept: false,
	},
	{
		returning: "a reused index with a new MAC and no node witness",
		node: false,
		index: 7,
		kept: false,
	},
] as const) {
	test(`a flap ${row.kept ? "keeps" : "drops"} admission when the netdev returns with ${row.returning}`, async () => {
		const work = fs.mkdtempSync(join(tmpdir(), "usb-net-flap-"));
		const stat = row.node
			? spyOn(fs, "statSync").mockReturnValue(
					fs.statSync(work, { bigint: true }),
				)
			: undefined;
		try {
			const index = spyOn(netdevPresence, "ifindex").mockReturnValue(7);
			spyOn(netdevPresence, "inSysfs").mockReturnValue(true);
			await routerScan().settle();
			pollRouter(7);
			expect(addressedBond()?.linkId).toBe(ROUTER_LINK);
			routerState("disconnected");
			index.mockReturnValue(row.index);
			const renewed = firstSightIfconfig(ROUTER, IP).replace(
				"02:00:00:00:00:01",
				"02:00:00:00:00:02",
			);
			spyOn(runner, "run").mockImplementation(async (bin) =>
				bin === "ifconfig" ? renewed : ipSample(ROUTER, row.index, IP),
			);

			await updateNetif();

			expect(netIfBuildMsg()[ROUTER]?.enabled).toBe(row.kept);
			expect(addressedBond()?.linkId).toBe(row.kept ? ROUTER_LINK : undefined);
			expect(
				genSrtlaBondEntriesForLocalIpAddress("192.168.8.1").map(
					(entry) => entry.linkId,
				),
			).toEqual(row.kept ? [ROUTER_LINK] : []);
		} finally {
			stat?.mockRestore();
			fs.rmSync(work, { recursive: true });
		}
	});
}

test("an unindexed descriptor is withdrawn on ambiguous same-name reappearance", async () => {
	await routerScan().settle();
	await updateNetif();
	expect(addressedBond()).toBeDefined();
	spyOn(netdevPresence, "inSysfs").mockReturnValue(true);
	spyOn(netdevPresence, "ifindex").mockReturnValue(undefined);

	routerState("disconnected");
	routerState("connected");

	expect(getUsbPhysicalDescriptor(ROUTER)).toBeUndefined();
	expect(addressedBond()).toBeUndefined();
});

test("a late down event cannot remove an addressed replacement already seen up", async () => {
	spyOn(fs, "readFileSync").mockReturnValue("up\n");
	await routerScan().settle();
	pollRouter(7);
	spyOn(netdevPresence, "inSysfs").mockReturnValue(true);
	spyOn(netdevPresence, "ifindex").mockReturnValue(17);
	routerState("connected");
	await routerScan("replacement-serial").settle();
	pollRouter(17);
	const replacement = addressedBond()?.linkId;
	expect(replacement).toBeDefined();
	expect(replacement).not.toBe(ROUTER_LINK);

	routerState("disconnected");

	expect(addressedBond()?.linkId).toBe(replacement);
});

for (const name of [ROUTER, "enx0c5b8f279a65"]) {
	test(`a replug at ${name} restores only the original exact bond opt-out`, async () => {
		const work = fs.mkdtempSync(join(tmpdir(), "usb-net-opt-out-"));
		const configPath = join(work, "config.json");
		setConfigFilePath(configPath);
		try {
			await routerScan().settle();
			pollRouter(7);
			const original = addressedBond()?.linkId;
			expect(original).toBe(ROUTER_LINK);
			setBondOptOut(ROUTER, true);
			spyOn(netdevPresence, "inSysfs").mockReturnValue(true);
			spyOn(netdevPresence, "ifindex").mockReturnValue(17);
			routerState("connected");
			await routerScan("replacement-serial").settle();
			pollRouter(17);
			expect(addressedBond()?.linkId).toBeDefined();
			expect(addressedBond()?.linkId).not.toBe(original);

			processIfconfigOutput("");
			await routerScan(undefined, name).settle();
			processIfconfigOutput(firstSightIfconfig(name, IP));

			expect(addressedBond(name)).toBeUndefined();
			expect(getConfig().bond_opt_out).toEqual({ [ROUTER_LINK]: true });
			expect(
				JSON.parse(fs.readFileSync(configPath, "utf8")).bond_opt_out,
			).toEqual({
				[ROUTER_LINK]: true,
			});
		} finally {
			setConfigFilePath("config.json");
			fs.rmSync(work, { recursive: true });
		}
	});
}

test("retired admin observations and late SIM, signal, URL and open evidence do not reach a replacement", async () => {
	const targets = new Map([[ROUTER, "12d1:14dc"]]);
	const observed = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let parked = false;
	const deps: RouterAdminProbeDeps = {
		isRealDevice: async () => true,
		runIpRouteShowDefault: async () => `default via 192.168.8.1 dev ${ROUTER}`,
		postViaInterface: async () => "",
		fetchViaInterface: async (_name, urls) => {
			if (urls.length === 1) {
				return [
					"<response><SesInfo>SessionID=fixture</SesInfo><TokInfo>token</TokInfo></response>",
				];
			}
			if (parked) {
				observed.resolve();
				await release.promise;
			}
			return urls.map((url) => {
				if (url.endsWith("/user/state-login"))
					return "<response><State>0</State><password_type>0</password_type></response>";
				if (url.endsWith("/monitoring/status"))
					return "<response><SimStatus>0</SimStatus></response>";
				if (url.endsWith("/device/signal"))
					return "<response><rsrp>-85dBm</rsrp></response>";
				return "<response><DeviceName>fixture</DeviceName></response>";
			});
		},
	};
	await routerScan().settle();
	pollRouter(7);
	await refreshRouterCellularAdmin(targets, deps);
	expect(getRouterCellularAdmin(ROUTER)?.admin_url).toBe("http://192.168.8.1");
	expect(getRouterCellularAdmin(ROUTER)?.sim).toBe("absent");
	expect(readLockOpenEvidence(ROUTER)).toBe("open");

	parked = true;
	const pending = refreshRouterCellularAdmin(targets, deps);
	try {
		await observed.promise;
		spyOn(netdevPresence, "inSysfs").mockReturnValue(true);
		spyOn(netdevPresence, "ifindex").mockReturnValue(17);
		routerState("connected");
		await routerScan("replacement-serial").settle();
		pollRouter(17);
		expect(getRouterCellularAdmin(ROUTER)).toBeUndefined();
		expect(readLockOpenEvidence(ROUTER)).toBeUndefined();
		await refreshRouterCellularAdmin(targets, {
			...deps,
			runIpRouteShowDefault: async () =>
				`default via 192.168.8.2 dev ${ROUTER}`,
			fetchViaInterface: async () => [],
		});
	} finally {
		release.resolve();
		await pending;
	}
	expect(getRouterCellularAdmin(ROUTER)).toMatchObject({
		admin_url: "http://192.168.8.2",
		reachable: false,
	});
	expect(getRouterCellularAdmin(ROUTER)?.sim).toBeUndefined();
	expect(readLockOpenEvidence(ROUTER)).toBeUndefined();
	expect(addressedBond()).toBeDefined();
});

test("re-enumeration with the same name, index and MAC retires the old sysfs node", async () => {
	const work = fs.mkdtempSync(join(tmpdir(), "usb-net-node-"));
	const a = join(work, "a");
	const b = join(work, "b");
	fs.mkdirSync(a);
	fs.mkdirSync(b);
	const first = fs.statSync(a, { bigint: true });
	const second = fs.statSync(b, { bigint: true });
	const stat = spyOn(fs, "statSync").mockReturnValue(first);
	try {
		spyOn(netdevPresence, "ifindex").mockReturnValue(7);
		await routerScan().settle();
		pollRouter(7);
		expect(addressedBond()?.linkId).toBe(ROUTER_LINK);
		stat.mockReturnValue(second);
		routerState("connected");
		expect(addressedBond()).toBeUndefined();
		await routerScan("replacement-serial").settle();
		pollRouter(7);
		expect(addressedBond()?.linkId).not.toBe(ROUTER_LINK);
		expect(addressedBond()?.ip).toBe(IP);
	} finally {
		stat.mockRestore();
		fs.rmSync(work, { recursive: true });
	}
});

test("a USB read spanning a replacement cannot commit the old tree without a monitor event", async () => {
	let index = 7;
	spyOn(netdevPresence, "ifindex").mockImplementation(() => index);
	const entered = Promise.withResolvers<void>();
	const old = Promise.withResolvers<void>();
	const fresh = Promise.withResolvers<void>();
	const resampling = Promise.withResolvers<void>();
	const oldTree = routerDongleDeps();
	const replacement = routerDongleDeps("replacement-serial");
	let first = true;
	let tree = oldTree;
	spyOn(defaultRouterCellularScanDeps, "resolveLink").mockImplementation(
		async (path) => {
			if (first) {
				first = false;
				entered.resolve();
				await old.promise;
				return oldTree.resolveLink(path);
			}
			resampling.resolve();
			await fresh.promise;
			tree = replacement;
			return replacement.resolveLink(path);
		},
	);
	spyOn(defaultRouterCellularScanDeps, "readAttr").mockImplementation((path) =>
		tree.readAttr(path),
	);
	spyOn(defaultRouterCellularScanDeps, "listDir").mockImplementation(
		oldTree.listDir,
	);
	spyOn(defaultRouterCellularScanDeps, "readLinkName").mockImplementation(
		oldTree.readLinkName,
	);
	const pending = refreshUsbNetMarkers([ROUTER]);
	try {
		await entered.promise;
		index = 17;
		old.resolve();
		await pending;
		expect(getUsbPhysicalDescriptor(ROUTER)).toBeUndefined();
		expect(usbNetScanCovers(ROUTER)).toBe(false);
		await resampling.promise;
	} finally {
		old.resolve();
		fresh.resolve();
		await pending;
		await refreshUsbNetMarkers([ROUTER]);
	}
	expect(getUsbPhysicalDescriptor(ROUTER)?.serial).toBe("replacement-serial");
});

test("a late credential open check cannot reauthorize the replacement name", async () => {
	const index = spyOn(netdevPresence, "ifindex").mockReturnValue(7);
	spyOn(netdevPresence, "inSysfs").mockReturnValue(true);
	await routerScan().settle();
	pollRouter(7);
	const physical = listPresentPhysicalDevices().find(
		(row) => row.ifname === ROUTER,
	);
	if (!physical) throw new Error("missing router identity");
	const started = Promise.withResolvers<void>();
	const result = Promise.withResolvers<"open">();
	const pending = verifyModemCredential("fixture", {
		...defaultCredentialVerifyDeps,
		resolveTarget: () => ({
			ifname: ROUTER,
			adminUrl: "http://192.168.8.1",
			device: physical,
			dialect: "hilink",
		}),
		now: () => 0,
		isRealDevice: async () => true,
		readCredential: () => undefined,
		transport: {
			fetchViaInterface: async () => [],
			postViaInterface: async () => "",
		},
		loginPort: {
			detectOpen: async () => {
				started.resolve();
				return result.promise;
			},
			attempt: async () => "auth-accepted",
		},
	});
	try {
		await started.promise;
		index.mockReturnValue(17);
		pollRouter(17);
		await routerScan("replacement-serial").settle();
	} finally {
		result.resolve("open");
		await pending;
	}
	expect(readLockOpenEvidence(ROUTER)).toBeUndefined();
	expect((await pending).success).toBe(false);
});

for (const phase of ["request", "receipt"] as const) {
	test(`a replacement fences the old credential ${phase}`, async () => {
		const index = spyOn(netdevPresence, "ifindex").mockReturnValue(7);
		spyOn(netdevPresence, "inSysfs").mockReturnValue(true);
		await routerScan().settle();
		pollRouter(7);
		const physical = listPresentPhysicalDevices().find(
			(row) => row.ifname === ROUTER,
		);
		if (!physical) throw new Error("missing router identity");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const post = spyOn({ send: async () => "device-response" }, "send");
		const pending = verifyModemCredential(
			"fixture",
			{
				...defaultCredentialVerifyDeps,
				resolveTarget: () => ({
					ifname: ROUTER,
					adminUrl: "http://192.168.8.1",
					device: physical,
					dialect: "hilink",
				}),
				now: () => 0,
				isRealDevice: async () => true,
				readCredential: () => undefined,
				transport: {
					fetchViaInterface: async () => [],
					postViaInterface: post,
				},
				loginPort: {
					detectOpen: async () => "locked",
					attempt: async (target, _credential, transport) => {
						started.resolve();
						if (phase === "request") await release.promise;
						const body = await transport.postViaInterface(
							target.ifname,
							target.adminUrl,
							"fixture body",
						);
						if (phase === "receipt") await release.promise;
						return body ? "auth-rejection" : "protocol-mismatch";
					},
				},
			},
			{ username: "fixture-user", password: "fixture-password" },
		);
		try {
			await started.promise;
			index.mockReturnValue(17);
			pollRouter(17);
			await routerScan("replacement-serial").settle();
		} finally {
			release.resolve();
			await pending;
		}
		expect(post).toHaveBeenCalledTimes(phase === "request" ? 0 : 1);
		expect(await pending).toMatchObject({
			success: false,
			error: "no_credential",
		});
	});
}

const live: { index: number | undefined; listed: boolean | undefined } = {
	index: 7,
	listed: true,
};

const credentialLifetimes: ReadonlyArray<{
	readonly lifetime: string;
	readonly beforeIssue?: () => void;
	readonly whileHeld?: () => void | Promise<void>;
	readonly posts: number;
}> = [
	{
		lifetime: "an unannounced takeover after a flap",
		whileHeld: () => {
			routerState("disconnected");
			live.index = 17;
		},
		posts: 0,
	},
	{
		lifetime: "a takeover already in place at issue",
		beforeIssue: () => {
			live.index = 17;
		},
		posts: 0,
	},
	{
		lifetime: "a witness that can no longer be read",
		whileHeld: () => {
			live.index = undefined;
		},
		posts: 0,
	},
	{
		lifetime: "no readable witness at issue or dispatch",
		beforeIssue: () => {
			live.index = undefined;
		},
		posts: 0,
	},
	{
		lifetime: "no witness recorded for the resolved identity",
		beforeIssue: resetNetdevLifetimesForTest,
		posts: 0,
	},
	{
		lifetime: "nonoverlapping issue and dispatch witnesses",
		whileHeld: () => {
			const node = fs.statSync(tmpdir(), { bigint: true });
			spyOn(fs, "statSync").mockReturnValue(node);
			live.index = undefined;
		},
		posts: 0,
	},
	{
		lifetime: "the same sysfs node with a new index",
		beforeIssue: () => {
			const node = fs.statSync(tmpdir(), { bigint: true });
			spyOn(fs, "statSync").mockReturnValue(node);
		},
		whileHeld: () => {
			live.index = 17;
		},
		posts: 0,
	},
	{
		// A production observer retires the name while the kernel still reports
		// the same netdev, so only the retirement epoch can refuse the request.
		lifetime: "a retirement recorded by a degraded poll after a flap",
		whileHeld: async () => {
			let retired = false;
			const stop = onNetdevRetired((name) => {
				if (name === ROUTER) retired = true;
			});
			routerState("disconnected");
			live.index = undefined;
			live.listed = undefined;
			spyOn(runner, "run").mockImplementation(async (bin) => {
				if (bin === "ifconfig") return firstSightIfconfig(ROUTER, IP);
				throw new Error("ip not available");
			});
			try {
				await updateNetif();
			} finally {
				stop();
			}
			live.index = 7;
			live.listed = true;
			expect(retired).toBe(true);
		},
		posts: 0,
	},
	{
		lifetime: "a genuine flap of the same netdev",
		whileHeld: () => routerState("disconnected"),
		posts: 1,
	},
];

for (const row of credentialLifetimes) {
	test(`a credential request reaches only its issuing kernel lifetime: ${row.lifetime}`, async () => {
		live.index = 7;
		live.listed = true;
		resetModemLockSessionsForTest();
		spyOn(netdevPresence, "ifindex").mockImplementation(() => live.index);
		spyOn(netdevPresence, "inSysfs").mockImplementation(() => live.listed);
		await routerScan().settle();
		pollRouter(7);
		const physical = listPresentPhysicalDevices().find(
			(device) => device.ifname === ROUTER,
		);
		if (!physical) throw new Error("missing router identity");
		row.beforeIssue?.();
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const post = spyOn({ send: async () => "device-response" }, "send");
		const pending = verifyModemCredential(
			"fixture",
			{
				...defaultCredentialVerifyDeps,
				resolveTarget: () => ({
					ifname: ROUTER,
					adminUrl: "http://192.168.8.1",
					device: physical,
					dialect: "hilink",
				}),
				now: () => 0,
				isRealDevice: async () => true,
				readCredential: () => undefined,
				transport: {
					fetchViaInterface: async () => [],
					postViaInterface: post,
				},
				loginPort: {
					detectOpen: async () => "locked",
					attempt: async (target, _credential, transport) => {
						held.resolve();
						await release.promise;
						const body = await transport.postViaInterface(
							target.ifname,
							target.adminUrl,
							"fixture body",
						);
						return body ? "auth-rejection" : "protocol-mismatch";
					},
				},
			},
			{ username: "fixture-user", password: "fixture-password" },
		);
		try {
			await Promise.race([held.promise, pending]);
			await row.whileHeld?.();
		} finally {
			release.resolve();
			await pending;
		}
		expect(post).toHaveBeenCalledTimes(row.posts);
		expect(await pending).toMatchObject({
			success: false,
			error: row.posts === 1 ? "auth_failed" : "no_credential",
		});
	});
}

test("same-name same-address replacement clears health and rejects the in-flight probe", async () => {
	const started = Promise.withResolvers<void>();
	const result = Promise.withResolvers<UplinkHealthOutcome>();
	setUplinkHealthEngineForTest(new UplinkHealthEngine());
	let probe = async (): Promise<UplinkHealthOutcome> => "success";
	const runtime = new UplinkHealthRuntime({
		now: () => 1_000,
		interfaces: getNetworkInterfaces,
		streaming: () => false,
		telemetry: () => null,
		resolveTarget: async () => "192.0.2.10",
		publish: () => undefined,
		probe: () => probe(),
	});
	try {
		await routerScan().settle();
		pollRouter(7);
		await runtime.tick();
		expect(runtime.records()[0]?.state).toBe("up");
		probe = () => {
			started.resolve();
			return result.promise;
		};
		const pending = runtime.tick();
		try {
			await started.promise;
			pollRouter(17);
			expect(netIfBuildMsg()[ROUTER]?.enabled).toBe(false);
			expect(genSrtlaBondEntriesForLocalIpAddress("192.168.8.1")).toEqual([]);
			await routerScan("replacement-serial").settle();
			pollRouter(17);
			expect(runtime.records()).toEqual([]);
		} finally {
			result.resolve("captive_portal");
			await pending;
		}
		expect(runtime.records()).toEqual([]);
	} finally {
		runtime.dispose();
		setUplinkHealthEngineForTest(null);
	}
});

function expectRouterIdentity(kept: boolean) {
	expect(usbNetScanCovers(ROUTER)).toBe(kept);
	expect(getUsbPhysicalDescriptor(ROUTER) !== undefined).toBe(kept);
	expect(getRouterCellularMarker(ROUTER) !== undefined).toBe(kept);
	expect(listPresentPhysicalDevices().length).toBe(kept ? 1 : 0);
}

for (const replacement of [
	"before-down",
	"before-up",
	"before-poll",
] as const) {
	test(`same-name router replacement drops the committed identity at ${replacement}`, async () => {
		await routerScan().settle();
		pollRouter(7);
		let ifindex = replacement === "before-down" ? 8 : 7;
		spyOn(netdevPresence, "inSysfs").mockReturnValue(true);
		spyOn(netdevPresence, "ifindex").mockImplementation(() => ifindex);

		routerState("disconnected");
		if (replacement !== "before-down") {
			expectRouterIdentity(true);
			ifindex = 8;
			if (replacement === "before-up") routerState("connected");
			else pollRouter(8);
		}

		expectRouterIdentity(false);
	});
}

test("a link flap under the same ifindex keeps the committed identity", async () => {
	await routerScan().settle();
	pollRouter(7);
	spyOn(netdevPresence, "inSysfs").mockReturnValue(true);
	spyOn(netdevPresence, "ifindex").mockReturnValue(7);

	routerState("disconnected");
	routerState("connected");
	pollRouter(7);

	expectRouterIdentity(true);
});

test("a poll sampled before a replacement does not restore the old ifindex", async () => {
	await routerScan().settle();
	pollRouter(7);
	let ifindex = 7;
	spyOn(netdevPresence, "inSysfs").mockReturnValue(true);
	spyOn(netdevPresence, "ifindex").mockImplementation(() => ifindex);
	const ifconfig = Promise.withResolvers<string>();
	const sampled = Promise.withResolvers<void>();
	spyOn(runner, "run").mockImplementation(async (bin) => {
		if (bin === "ifconfig") {
			sampled.resolve();
			return ifconfig.promise;
		}
		return ipSample(ROUTER, 7, IP);
	});
	const poll = updateNetif();
	await sampled.promise;

	ifindex = 8;
	routerState("disconnected");
	routerState("connected");
	await routerScan("replacement-serial", ROUTER, REPLACEMENT_IP).settle();
	ifconfig.resolve(firstSightIfconfig(ROUTER, IP));
	await poll;
	expect(getNetworkInterfaces()[ROUTER]?.ip).toBeUndefined();
	expect(addressedBond()).toBeUndefined();
	processIfconfigOutput(
		firstSightIfconfig(ROUTER, REPLACEMENT_IP),
		undefined,
		undefined,
		undefined,
		new Map([[ROUTER, 8]]),
	);

	expectRouterIdentity(true);
	expect(addressedBond()?.ip).toBe(REPLACEMENT_IP);
	expect(addressedBond()?.linkId).not.toBe(ROUTER_LINK);
});
