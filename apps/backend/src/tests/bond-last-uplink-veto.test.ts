import { expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMockState, updateMockState } from "../mocks/mock-service.ts";
import {
	getConfig,
	getConfigFilePath,
	loadConfig,
	saveConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import { setPresentPhysicalDevices } from "../modules/modems/physical-identity.ts";
import { isBondOptedOut } from "../modules/network/bond-preference.ts";
import { MockMonitorEmitter } from "../modules/network/monitor/mock-monitor.ts";
import {
	createMonitorManager,
	NmcliMonitorManager,
} from "../modules/network/monitor/monitor-manager.ts";
import * as netif from "../modules/network/network-interfaces.ts";
import { resetUsbNetMarkers } from "../modules/network/router-cellular-scan.ts";
import {
	getNetifState,
	onNetifChange,
} from "../modules/network/state/netif-state.ts";
import { setBondIdentityResolverForTest } from "../modules/streaming/bond-entry.ts";
import {
	genSrtlaBondEntries,
	genSrtlaBondEntriesForLocalIpAddress,
} from "../modules/streaming/srtla.ts";
import {
	defaultDeviceDetectionDeps,
	isRealDevice,
} from "../modules/system/device-detection.ts";
import { handleORPCMessage } from "../rpc/adapter.ts";
import { broadcastMsg, setSocketSenderId } from "../rpc/compat.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import {
	type BondStorageFault,
	bondStorageFaults,
	configFileSnapshot,
	configStage,
	watchConfigWrite,
} from "./helpers/bond-config-faults.ts";
import {
	makeRpcContext,
	physicalRecord,
	resetBondFixture,
} from "./helpers/bond-toggle-fixture.ts";

const envKeys = [
	"NODE_ENV",
	"MOCK_MODE",
	"MOCK_SCENARIO",
	"CERALIVE_DEVICE_TYPE",
	"HWSIM_REPO",
] as const;
const modes = [
	"REAL",
	"MOCK",
	"OVERLAY",
	"HWSIM",
	"EMULATED",
	"SCENARIO",
	"TEST",
	"BOOT",
	"FLIP-MONITOR",
	"FLIP-DEVICE",
] as const;
type Mode = (typeof modes)[number];
type Topology =
	| "twins"
	| "fallback"
	| "survivor"
	| "duplicate"
	| "shared-key"
	| "empty"
	| "raw-last"
	| "overlap"
	| "migrate"
	| "unseen-legacy";
const IP = "192.0.2.20";
const changed = {
	id: "request-0",
	result: { success: true, applied: { name: "eth0", ip: IP, enabled: false } },
};
const refused = (i: number) => ({
	id: `request-${i}`,
	result: { success: false, error: "disable_all_refused" },
});
const notice = {
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
	id: "fixture-sender",
};

// These same test bytes also run on the unpatched baseline. In production this
// context is supplied by main.ts after classification and monitor selection.
function setBootContext(
	real: boolean,
	monitor: ReturnType<typeof createMonitorManager>,
) {
	const set = Reflect.get(netif, "setBondDisableGuardContext");
	if (typeof set === "function")
		set(real, monitor instanceof NmcliMonitorManager);
}

function add(name: string, changes: Partial<netif.NetworkInterface> = {}) {
	netif.getNetworkInterfaces()[name] = {
		ip: name === "eth0" ? IP : "192.0.2.21",
		netmask: "255.255.255.0",
		enabled: true,
		error: 0,
		tp: 0,
		txb: 0,
		rxb: 0,
		...changes,
	};
}

function seed(topology: Topology) {
	add("eth0");
	if (topology === "migrate" || topology === "unseen-legacy") {
		const legacy = physicalRecord("legacy", "fixture:legacy").linkId;
		const identity = (name: string) => ({
			...physicalRecord(name, `fixture:${name === "held0" ? "eth0" : name}`),
			...(name === "eth0" ? {} : { legacyLinkId: legacy }),
		});
		setBondIdentityResolverForTest(identity);
		add("eth1");
		add("held0", { error: netif.NETIF_ERR_SHAREDLAN });
		getConfig().bond_opt_out = { [legacy]: true };
		setPresentPhysicalDevices(topology === "migrate" ? [identity("eth1")] : []);
		return;
	}
	setBondIdentityResolverForTest(
		topology === "fallback"
			? null
			: (name) =>
					physicalRecord(
						name,
						`fixture:${topology === "shared-key" && name === "eth1" ? "eth0" : name}`,
					),
	);
	if (topology === "twins" || topology === "fallback") {
		for (const name of ["wwan0", "wwan1"]) {
			add(name);
			netif.setBondOptOut(name, true);
		}
	} else if (topology === "duplicate") {
		add("eth0", { enabled: false, error: netif.NETIF_ERR_DUPIPV4 });
	} else if (topology === "empty") {
		add("eth0", { enabled: false });
	} else if (topology !== "raw-last") {
		add("eth1", { enabled: topology !== "overlap" });
		if (topology === "overlap")
			add("held0", { error: netif.NETIF_ERR_SHAREDLAN });
	}
}

function snapshot(file: string) {
	const raw = netif.getNetworkInterfaces();
	return structuredClone({
		raw,
		cache: getNetifState(),
		bond: genSrtlaBondEntries(),
		local: genSrtlaBondEntriesForLocalIpAddress("192.0.2.99"),
		optOut: Object.keys(raw).map((name) => [name, isBondOptedOut(name)]),
		preferences: getConfig().bond_opt_out,
		overlay: [...getMockState().netifConfigs],
		disk: configFileSnapshot(file),
		stage: configFileSnapshot(configStage(file)),
	});
}

type Request = {
	readonly name: string;
	readonly enabled: boolean;
	readonly ip?: string;
};
const off = { name: "eth0", enabled: false, ip: IP };
const backupOn = { name: "eth1", enabled: true, ip: "192.0.2.21" };
const backupOff = { ...backupOn, enabled: false };
let time = 1_000_000;

async function replay(
	label: string,
	mode: Mode,
	fault: BondStorageFault,
	topology: Topology,
	requests: readonly Request[],
	split = false,
) {
	const priorEnv = envKeys.map((key) => [key, process.env[key]] as const);
	const priorConfig = getConfigFilePath();
	const { initialized, netifConfigs } = getMockState();
	const dir = mkdtempSync(join(tmpdir(), "bond-veto-"));
	const file = join(dir, "config.json");
	const clock = spyOn(Date, "now");
	clock.mockImplementation(() => (time += 10_000));
	for (const key of envKeys) delete process.env[key];
	process.env.NODE_ENV = mode === "TEST" ? "test" : "production";
	process.env.CERALIVE_DEVICE_TYPE = mode === "EMULATED" ? "emulated" : "real";
	if (mode === "MOCK" || mode === "OVERLAY") process.env.MOCK_MODE = "true";
	if (mode === "SCENARIO" || mode === "FLIP-MONITOR")
		process.env.MOCK_SCENARIO = "multi-modem-wifi";
	if (mode === "HWSIM") process.env.HWSIM_REPO = "/fixture";
	updateMockState({ initialized: mode === "OVERLAY", netifConfigs: new Map() });
	const monitor = createMonitorManager(() => undefined);
	setBootContext(false, monitor);
	const pending = Promise.withResolvers<string>();
	const boot =
		mode === "BOOT"
			? isRealDevice({
					...defaultDeviceDetectionDeps,
					getDeviceTypeOverride: () => undefined,
					readDeviceTreeCompatible: () => pending.promise,
				}).then((real) => setBootContext(real, monitor))
			: undefined;
	const trace: { source: string; frame: string }[] = [];
	const observer = makeRpcContext().ws;
	observer.send = (frame) => {
		if (typeof frame !== "string") throw new Error("Expected a text frame");
		return trace.push({ source: "observer", frame });
	};
	const requester = (source: string) => {
		const socket = makeRpcContext().ws;
		socket.send = (frame) => {
			if (typeof frame !== "string") throw new Error("Expected a text frame");
			return trace.push({ source, frame });
		};
		setSocketSenderId(socket, "fixture-sender");
		return socket;
	};
	try {
		setConfigFilePath(file);
		writeFileSync(file, "{}");
		await loadConfig();
		resetBondFixture();
		netif.resetNetifSnapshotForTest();
		resetUsbNetMarkers();
		seed(topology);
		if (monitor instanceof MockMonitorEmitter) {
			const delivered = Promise.withResolvers<void>();
			monitor.on("monitor-event", (event) => {
				netif.handleNetifMonitorEvent(event);
				delivered.resolve();
			});
			monitor.script([
				{
					delayMs: 0,
					event: { type: "device-state", device: "wlan9", state: "connected" },
				},
			]);
			monitor.start();
			await delivered.promise;
		}
		netif.triggerNetworkInterfacesChange();
		saveConfig();
		if (!boot) setBootContext(await isRealDevice(), monitor);
		if (mode === "FLIP-MONITOR") delete process.env.MOCK_SCENARIO;
		if (mode === "FLIP-DEVICE") process.env.CERALIVE_DEVICE_TYPE = "emulated";
		const watcher = watchConfigWrite(file, fault);
		try {
			const before = snapshot(file);
			addClient(observer);
			broadcastMsg("netif", netif.netIfBuildMsg());
			const anchor: unknown = JSON.parse(trace.pop()?.frame ?? "{}");
			if (
				typeof anchor !== "object" ||
				anchor === null ||
				!("seq" in anchor) ||
				typeof anchor.seq !== "number"
			)
				throw new Error("Missing sequence anchor");
			const seq = anchor.seq;
			const stopWire = onNetifChange(() =>
				broadcastMsg("netif", netif.netIfBuildMsg()),
			);
			const edges: string[][] = [];
			const stopEdges = netif.onNetworkInterfacesChange(() => {
				edges.push(genSrtlaBondEntries().map((entry) => entry.iface));
			});
			try {
				const socket = requester("requester");
				await Promise.all(
					requests.map((input, i) =>
						handleORPCMessage(split ? requester(`requester-${i}`) : socket, {
							id: `request-${i}`,
							path: ["network", "configure"],
							input,
						}),
					),
				);
			} finally {
				stopEdges();
				stopWire();
			}
			let nextSeq = seq;
			const normalized = trace.map(({ source, frame }) => {
				// Keep wire bytes intact except fixture path and the global counter
				// offset after permitted vetoes, checking every increment first.
				if (source === "observer") {
					const suffix = `,"seq":${++nextSeq}}`;
					expect(frame.endsWith(suffix)).toBe(true);
					return {
						source,
						frame: `${frame.slice(0, -suffix.length)},"seq":${nextSeq - seq}}`,
					};
				}
				return {
					source,
					frame: frame
						.replaceAll(configStage(file), "<stage>")
						.replaceAll(file, "<config>"),
				};
			});
			const after = snapshot(file);
			const steps = [...watcher.steps];
			const row = {
				label,
				mode,
				fault,
				topology,
				requests,
				split,
				before,
				after,
				frames: normalized,
				edges,
				steps,
			};
			if (process.env.BOND_VETO_TRACE)
				appendFileSync(process.env.BOND_VETO_TRACE, `${JSON.stringify(row)}\n`);
			const frames: unknown[] = trace
				.filter(({ source }) => source !== "observer")
				.map(({ frame }) => JSON.parse(frame));
			return { ...row, frames };
		} finally {
			watcher.restore();
		}
	} finally {
		removeClient(observer);
		pending.resolve("rockchip,rk3588");
		await boot;
		setBootContext(false, monitor);
		if (monitor instanceof MockMonitorEmitter) monitor.reset();
		resetBondFixture();
		resetUsbNetMarkers();
		updateMockState({ initialized, netifConfigs });
		for (const [key, value] of priorEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		setConfigFilePath(priorConfig);
		clock.mockRestore();
		rmSync(dir, { recursive: true });
	}
}

function expectVeto(row: Awaited<ReturnType<typeof replay>>) {
	expect(row.frames).toEqual([notice, refused(0)]);
	expect(row.edges).toEqual([]);
	expect(row.steps).toEqual([]);
	expect(row.after).toEqual(row.before);
}

for (const topology of [
	"twins",
	"fallback",
	"duplicate",
	"shared-key",
] as const)
	test(`real disable retains the bond: ${topology}`, async () => {
		expectVeto(await replay(topology, "REAL", "none", topology, [off]));
	});

for (const fault of bondStorageFaults)
	for (const mode of modes) {
		test(`${mode} / ${fault}: last candidate and surviving-peer control`, async () => {
			const sole = await replay("fault-last", mode, fault, "twins", [off]);
			const peer = await replay("fault-peer", mode, fault, "survivor", [off]);
			if (mode === "REAL") expectVeto(sole);
			for (const row of mode === "REAL" ? [peer] : [sole, peer]) {
				if (fault === "none" || fault === "read-only-file") {
					expect(row.frames.at(-1)).toEqual(changed);
					expect(row.steps.filter((step) => step === "rename")).toEqual([
						"rename",
					]);
				} else {
					const code =
						fault === "unwritable-dir"
							? "EACCES"
							: fault === "once-fsync" || fault === "final-rename"
								? "EIO"
								: fault;
					expect(row.frames.at(-1)).toMatchObject({
						id: "request-0",
						error: {
							code: "INTERNAL_ERROR",
							message: expect.stringContaining(code),
						},
					});
					expect(row.steps.filter((step) => step === "open")).toEqual(["open"]);
					expect(row.after.disk).toEqual(row.before.disk);
					if (fault === "EISDIR" || fault === "final-rename")
						expect(row.steps.slice(-2)).toEqual(["rename", "unlink"]);
					if (fault === "once-fsync")
						expect(row.steps.slice(-2)).toEqual(["fsync", "close"]);
				}
			}
		});
	}

for (const mode of modes)
	for (const split of [false, true])
		for (const reverse of [false, true]) {
			test(`${mode}: overlapping adapter frames (split=${split}, reverse=${reverse})`, async () => {
				const requests = reverse ? [backupOn, off] : [off, backupOn];
				const row = await replay(
					"overlap-off-on",
					mode,
					"none",
					"overlap",
					requests,
					split,
				);
				const twoOff = await replay(
					"overlap-two-off",
					mode,
					"none",
					"survivor",
					reverse ? [off, backupOff] : [backupOff, off],
					split,
				);
				if (mode === "REAL" && !reverse)
					await replay(
						"overlap-surviving-step",
						mode,
						"none",
						"overlap",
						[backupOn],
						split,
					);
				expect(row.edges).toEqual(
					reverse
						? [["eth0", "eth1"], ["eth1"]]
						: mode === "REAL"
							? [["eth0", "eth1"]]
							: [[], ["eth1"]],
				);
				if (!reverse && mode === "REAL")
					expect(row.frames).toContainEqual(refused(0));
				const simulatedMonitor =
					mode === "SCENARIO" || mode === "TEST" || mode === "FLIP-MONITOR";
				expect(twoOff.edges).toEqual([
					[reverse ? "eth1" : "eth0"],
					...(simulatedMonitor ? [[]] : []),
				]);
				if (!simulatedMonitor && mode !== "OVERLAY")
					expect(twoOff.frames).toContainEqual(refused(1));
			});
		}

test("real zero-to-zero, stale, malformed and legacy-refused inputs keep their old receipts", async () => {
	const empty = await replay("zero", "REAL", "none", "empty", [off]);
	expect(empty.frames.at(-1)).toEqual(changed);
	const stale = await replay("stale", "REAL", "none", "twins", [
		{ ...off, ip: "192.0.2.60" },
	]);
	expect(stale.frames).toEqual([
		{ id: "request-0", result: { success: false, error: "stale_address" } },
	]);
	const invalid = await replay("malformed", "REAL", "none", "twins", [
		{ ...off, ip: "not-an-ip" },
	]);
	expect(invalid.frames[0]).toMatchObject({
		error: { code: "VALIDATION_ERROR" },
	});
	expect(
		(await replay("legacy", "REAL", "none", "raw-last", [off])).frames,
	).toEqual([notice, refused(0)]);
});

test("legacy migration can retain an exclusion, while removing an unmigrated legacy key can admit a peer", async () => {
	const request = { ...backupOff, name: "held0" };
	const migrated = await replay("legacy-migrated", "REAL", "none", "migrate", [
		request,
	]);
	const unseen = await replay(
		"legacy-unseen",
		"REAL",
		"none",
		"unseen-legacy",
		[request],
	);
	expect(unseen.frames.at(-1)).toEqual({
		id: "request-0",
		result: { success: true, applied: request },
	});
	expect(unseen.after.bond.map(({ iface }) => iface)).toEqual(["eth1"]);
	expectVeto(migrated);
});
