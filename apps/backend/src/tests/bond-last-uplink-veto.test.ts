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
import {
	listPhysicalDevices,
	resetPhysicalIdentityRegistry,
	resolvePhysicalDevice,
	setPresentPhysicalDevices,
} from "../modules/modems/physical-identity.ts";
import { isBondOptedOut } from "../modules/network/bond-preference.ts";
import { MockMonitorEmitter } from "../modules/network/monitor/mock-monitor.ts";
import {
	createMonitorManager,
	NmcliMonitorManager,
} from "../modules/network/monitor/monitor-manager.ts";
import * as netif from "../modules/network/network-interfaces.ts";
import {
	notePublishedNetifSnapshot,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
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
	bondDeviceProbe,
	pendingProbeIp,
} from "./helpers/bond-device-replay.ts";
import { bootDevice, installDevice } from "./helpers/bond-guard-install.ts";
import {
	markerRows,
	oweBondMarkerRetractions,
	primeBondMarkers,
	resetBondMarkerReplay,
} from "./helpers/bond-marker-replay.ts";
import {
	makeRpcContext,
	physicalRecord,
	resetBondFixture,
} from "./helpers/bond-toggle-fixture.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./helpers/constructed-usb-twins.ts";

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
type Mode =
	| (typeof modes)[number]
	| "WITHDRAW-OVERRIDE"
	| "KEEP-OVERRIDE"
	| "HARDWARE"
	| "HARDWARE-FORCED"
	| "PENDING-HARDWARE"
	| "PENDING-NON-DEVICE"
	| "SKIPPED-PROBE"
	| "ERRORED-PROBE"
	| "EMULATED-TO-REAL"
	| "SCRIPTED-TO-REAL"
	| "SKIPPED-AUTO-PROBE"
	| "ERRORED-AUTO-PROBE"
	| "RETRY-POSITIVE"
	| "RETRY-NEGATIVE";
type Topology =
	| "twins"
	| "fallback"
	| "held-lan"
	| "survivor"
	| "duplicate"
	| "shared-key"
	| "empty"
	| "raw-last"
	| "overlap"
	| "deadline"
	| "marker"
	| "alias"
	| "alias-survivor"
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
	if (topology === "alias" || topology === "alias-survivor") {
		add("eth0", { error: netif.NETIF_ERR_SHAREDLAN });
		add("held0", { error: netif.NETIF_ERR_SHAREDLAN });
		add("wwu0", { usb: true, identitySettled: true });
		if (topology === "alias-survivor") add("eth1");
		return;
	}
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
		topology === "fallback" ||
			topology === "deadline" ||
			topology === "marker" ||
			topology === "held-lan"
			? null
			: (name) =>
					physicalRecord(
						name,
						`fixture:${topology === "shared-key" && name === "eth1" ? "eth0" : name}`,
					),
	);
	if (topology === "deadline") {
		add("wwu0", { usb: true });
		add("wwu1");
		netif.setBondOptOut("wwu1", true);
		notePublishedNetifSnapshot(
			Object.keys(netif.getNetworkInterfaces()),
			10_000,
		);
	} else if (topology === "marker") {
		for (const { name } of markerRows) {
			add(name, { error: netif.NETIF_ERR_SHAREDLAN });
		}
	} else if (topology === "held-lan") {
		add("eth0", { ip: pendingProbeIp });
		add("eth1", { enabled: false });
		add("eth2", { error: netif.NETIF_ERR_SHAREDLAN });
		add("eth3", { error: netif.NETIF_ERR_SHAREDLAN });
	} else if (topology === "twins" || topology === "fallback") {
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
		if (topology === "overlap") {
			add("held0", { error: netif.NETIF_ERR_SHAREDLAN });
			netif.setBondOptOut("eth1", true);
		}
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

async function waitMicrotasks(count: number) {
	while (count-- > 0) await Promise.resolve();
}

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
	if (label === "fuzz-seed-31-seq-926") process.env.NODE_ENV = "development";
	process.env.CERALIVE_DEVICE_TYPE =
		mode === "EMULATED" ||
		mode === "EMULATED-TO-REAL" ||
		mode === "SCRIPTED-TO-REAL"
			? "emulated"
			: "real";
	if (
		mode === "HARDWARE" ||
		mode === "SKIPPED-AUTO-PROBE" ||
		mode === "ERRORED-AUTO-PROBE"
	)
		delete process.env.CERALIVE_DEVICE_TYPE;
	const skippedProbe =
		mode === "SKIPPED-PROBE" || mode === "SKIPPED-AUTO-PROBE";
	const retryProbe = mode === "RETRY-POSITIVE" || mode === "RETRY-NEGATIVE";
	const erroredProbe =
		mode === "ERRORED-PROBE" || mode === "ERRORED-AUTO-PROBE" || retryProbe;
	if (mode === "MOCK" || mode === "OVERLAY" || skippedProbe)
		process.env.MOCK_MODE = "true";
	if (
		mode === "SCENARIO" ||
		mode === "FLIP-MONITOR" ||
		mode === "SCRIPTED-TO-REAL"
	)
		process.env.MOCK_SCENARIO = "multi-modem-wifi";
	if (mode === "HWSIM") process.env.HWSIM_REPO = "/fixture";
	const roleOverlap = label.startsWith("fuzz-seed-11-seq-189");
	if (roleOverlap) delete process.env.CERALIVE_DEVICE_TYPE;
	const roleHardware = roleOverlap
		? [
				spyOn(
					defaultDeviceDetectionDeps,
					"readDeviceTreeCompatible",
				).mockResolvedValue(""),
				spyOn(
					defaultDeviceDetectionDeps,
					"readDeviceTreeModel",
				).mockResolvedValue(""),
				spyOn(
					defaultDeviceDetectionDeps,
					"readCeraliveRelease",
				).mockResolvedValue(""),
			]
		: [];
	updateMockState({ initialized: mode === "OVERLAY", netifConfigs: new Map() });
	const monitor = createMonitorManager(() => undefined);
	installDevice(undefined, monitor);
	const pendingWithdrawal =
		mode === "PENDING-HARDWARE" || mode === "PENDING-NON-DEVICE";
	const probe = bondDeviceProbe(
		mode === "BOOT",
		mode === "BOOT" ||
			mode === "HARDWARE" ||
			mode === "HARDWARE-FORCED" ||
			mode === "PENDING-HARDWARE" ||
			skippedProbe ||
			erroredProbe,
		mode === "BOOT" || pendingWithdrawal,
	);
	let compatibleReads = 0;
	const retry = Promise.withResolvers<string>();
	const deps = {
		...probe.deps,
		readDeviceTreeCompatible: async () => {
			++compatibleReads;
			if (compatibleReads === 1 && erroredProbe)
				throw Object.assign(new Error("Transient compatible read"), {
					code: "EIO",
				});
			if (compatibleReads === 2 && retryProbe) return retry.promise;
			return probe.deps.readDeviceTreeCompatible();
		},
	};
	const device = bootDevice(deps);
	const arm = async () => {
		await device.ready;
		installDevice(device, monitor);
	};
	const boot = mode === "BOOT" ? arm() : undefined;
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
		if (topology === "marker") await primeBondMarkers();
		if (topology === "alias" || topology === "alias-survivor") {
			const fixture = constructedTwins[0];
			if (fixture === undefined) throw new Error("Missing USB fixture");
			// Two network functions from one USB parent, not two ports with
			// a factory serial collision.
			const siblingLink = fixture.readlink.replace(/:\d+\.\d+$/, ":1.1");
			const devices = [
				{ ...fixture, ifname: "wwu0", serial: "FIXTURE-UNIT-A" },
				{
					...fixture,
					ifname: "eth0",
					readlink: siblingLink,
					serial: "FIXTURE-UNIT-A",
				},
			];
			await refreshUsbNetMarkers(
				["wwu0", "eth0"],
				constructedTwinDeps(devices),
			);
		}
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
		if (!boot) await arm();
		if (mode === "FLIP-MONITOR") delete process.env.MOCK_SCENARIO;
		if (mode === "FLIP-DEVICE") process.env.CERALIVE_DEVICE_TYPE = "emulated";
		if (
			skippedProbe ||
			(erroredProbe && !retryProbe) ||
			mode === "EMULATED-TO-REAL"
		) {
			expect(monitor).toBeInstanceOf(NmcliMonitorManager);
			if (skippedProbe) {
				expect(compatibleReads).toBe(0);
				delete process.env.MOCK_MODE;
				if (label === "fuzz-seed-31-seq-926")
					process.env.NODE_ENV = "production";
			}
			if (mode === "EMULATED-TO-REAL")
				process.env.CERALIVE_DEVICE_TYPE = "real";
			else delete process.env.CERALIVE_DEVICE_TYPE;
			expect(await isRealDevice(deps)).toBe(true);
		}
		if (retryProbe) {
			delete process.env.CERALIVE_DEVICE_TYPE;
			device.refresh();
			device.refresh();
			retry.resolve(mode === "RETRY-POSITIVE" ? "rockchip,rk3588" : "");
			await new Promise<void>((resolve) => setImmediate(resolve));
			device.refresh();
		}
		if (mode === "SCRIPTED-TO-REAL") {
			delete process.env.MOCK_SCENARIO;
			process.env.CERALIVE_DEVICE_TYPE = "real";
			expect(monitor).toBeInstanceOf(MockMonitorEmitter);
			expect(compatibleReads).toBe(0);
		}
		if (pendingWithdrawal) {
			expect(monitor).toBeInstanceOf(NmcliMonitorManager);
			expect(probe.firstReadPending).toBe(true);
			delete process.env.CERALIVE_DEVICE_TYPE;
			expect(await isRealDevice(deps)).toBe(mode === "PENDING-HARDWARE");
			expect(probe.firstReadPending).toBe(true);
		}
		if (mode === "WITHDRAW-OVERRIDE" || mode === "HARDWARE-FORCED")
			delete process.env.CERALIVE_DEVICE_TYPE;
		if (
			mode === "WITHDRAW-OVERRIDE" ||
			mode === "FLIP-DEVICE" ||
			mode === "KEEP-OVERRIDE" ||
			mode === "HARDWARE" ||
			mode === "HARDWARE-FORCED"
		)
			expect(await isRealDevice(deps)).toBe(
				mode !== "WITHDRAW-OVERRIDE" && mode !== "FLIP-DEVICE",
			);
		const watcher = watchConfigWrite(file, fault);
		const requestMs =
			label === "deadline-after"
				? 25_001
				: label === "deadline-at"
					? 25_000
					: 24_999;
		const timeTuple = (ms: number): [number, number] => [
			Math.floor(ms / 1000),
			(ms % 1000) * 1_000_000,
		];
		const deadlineClock =
			topology === "deadline"
				? spyOn(process, "hrtime").mockReturnValue(timeTuple(requestMs))
				: undefined;
		try {
			let monotonic = requestMs;
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
			const testingMarkers = topology === "marker";
			if (testingMarkers) oweBondMarkerRetractions(anchor);
			const before = snapshot(file);
			const stopWire = onNetifChange(() =>
				broadcastMsg("netif", netif.netIfBuildMsg()),
			);
			const edges: string[][] = [];
			const stopEdges = netif.onNetworkInterfacesChange(() => {
				edges.push(genSrtlaBondEntries().map((entry) => entry.iface));
			});
			if (testingMarkers) {
				resetPhysicalIdentityRegistry();
				resolvePhysicalDevice({ ifname: "fixture-gone" });
			}
			const beforeRegistry = listPhysicalDevices();
			let afterRegistry = beforeRegistry;
			let flushStart = 0;
			try {
				deadlineClock?.mockImplementation(
					Object.assign(
						(): [number, number] => {
							const ms = monotonic;
							if (label === "deadline-crossing") monotonic = 25_000;
							return timeTuple(ms);
						},
						{ bigint: process.hrtime.bigint },
					),
				);
				const socket = requester("requester");
				if (roleOverlap) {
					await Promise.all([
						(async () => {
							await waitMicrotasks(2);
							await handleORPCMessage(requester("requester-role"), {
								id: "role",
								path: ["network", "setEthernetRole"],
								input: { name: "eth1", role: "shared-lan" },
							});
						})(),
						(async () => {
							await waitMicrotasks(mode === "MOCK" ? 5 : 11);
							await handleORPCMessage(requester("requester-configure"), {
								id: "configure",
								path: ["network", "configure"],
								input: backupOn,
							});
						})(),
					]);
				} else
					await Promise.all(
						requests.map((input, i) =>
							handleORPCMessage(split ? requester(`requester-${i}`) : socket, {
								id: `request-${i}`,
								path: ["network", "configure"],
								input,
							}),
						),
					);
				afterRegistry = listPhysicalDevices();
				if (testingMarkers) {
					flushStart = trace.length;
					broadcastMsg("netif", netif.netIfBuildMsg());
					broadcastMsg("netif", netif.netIfBuildMsg());
				}
			} finally {
				deadlineClock?.mockReturnValue(timeTuple(monotonic));
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
				...(!testingMarkers
					? {}
					: {
							retraction: {
								observerDuring: normalized
									.slice(0, flushStart)
									.filter(({ source }) => source === "observer"),
								nextBroadcasts: normalized
									.slice(flushStart)
									.map(({ frame }): unknown => JSON.parse(frame)),
								beforeRegistry,
								afterRegistry,
							},
						}),
			};
			if (process.env.BOND_VETO_TRACE)
				appendFileSync(process.env.BOND_VETO_TRACE, `${JSON.stringify(row)}\n`);
			const frames: unknown[] = trace
				.filter(({ source }) => source !== "observer")
				.map(({ frame }) => JSON.parse(frame));
			return { ...row, frames };
		} finally {
			watcher.restore();
			deadlineClock?.mockRestore();
		}
	} finally {
		removeClient(observer);
		for (const reader of roleHardware) reader.mockRestore();
		probe.release();
		await boot;
		retry.resolve("");
		installDevice(undefined, monitor);
		if (monitor instanceof MockMonitorEmitter) monitor.reset();
		resetBondFixture();
		resetUsbNetMarkers();
		resetBondMarkerReplay();
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

for (const mode of [
	"SKIPPED-PROBE",
	"ERRORED-PROBE",
	"EMULATED-TO-REAL",
	"SKIPPED-AUTO-PROBE",
	"ERRORED-AUTO-PROBE",
	"RETRY-POSITIVE",
	"RETRY-NEGATIVE",
	"SCRIPTED-TO-REAL",
] as const) {
	test(`native evidence recovery: ${mode}`, async () => {
		const row = await replay("native-recovery", mode, "none", "held-lan", [
			{ ...off, ip: pendingProbeIp },
		]);
		expect(row.before.bond.map(({ iface }) => iface)).toEqual(["eth0"]);
		if (mode === "RETRY-NEGATIVE" || mode === "SCRIPTED-TO-REAL") {
			expect(row.frames.at(-1)).toEqual({
				...changed,
				result: {
					...changed.result,
					applied: { ...changed.result.applied, ip: pendingProbeIp },
				},
			});
			expect(row.after.bond).toEqual([]);
			expect(row.steps).toEqual([]);
		} else expectVeto(row);
	});
}

function expectVeto(row: Awaited<ReturnType<typeof replay>>) {
	expect(row.frames).toEqual([notice, refused(0)]);
	expect(row.edges).toEqual([]);
	expect(row.steps).toEqual([]);
	expect(row.after).toEqual(row.before);
}

test("fuzz seed 31, sequence 926: dev boot then dev and override withdrawal", async () => {
	expectVeto(
		await replay("fuzz-seed-31-seq-926", "SKIPPED-PROBE", "none", "held-lan", [
			{ ...off, ip: pendingProbeIp },
		]),
	);
});

for (const mode of ["MOCK", "REAL"] as const) {
	test(`fuzz seed 11, sequence 189: ${mode} reply order matches main`, async () => {
		const row = await replay(
			`fuzz-seed-11-seq-189-${mode}`,
			mode,
			"none",
			"survivor",
			[backupOn],
			true,
		);
		expect(
			row.frames.filter(
				(frame) =>
					typeof frame === "object" &&
					frame !== null &&
					"id" in frame &&
					"result" in frame,
			),
		).toEqual([
			{
				id: "role",
				result: { success: false, error: "unavailable_in_emulated_mode" },
			},
			{ id: "configure", result: { success: true, applied: backupOn } },
		]);
	});
}

for (const mode of ["PENDING-HARDWARE", "PENDING-NON-DEVICE"] as const) {
	test(`pending probe withdrawal: ${mode} retains eth0 with the real monitor`, async () => {
		const row = await replay("pending-withdrawal", mode, "none", "held-lan", [
			{ ...off, ip: pendingProbeIp },
		]);
		expect(row.before.bond.map(({ iface }) => iface)).toEqual(["eth0"]);
		expectVeto(row);
		expect(row.after.bond.map(({ iface }) => iface)).toEqual(["eth0"]);
	});
}

for (const [mode, armed] of [
	["WITHDRAW-OVERRIDE", false],
	["KEEP-OVERRIDE", true],
	["FLIP-DEVICE", false],
	["HARDWARE", true],
	["HARDWARE-FORCED", true],
] as const) {
	test(`classifier seam: ${mode} controls veto on the selected real monitor`, async () => {
		const row = await replay("late-classifier", mode, "none", "fallback", [
			off,
		]);
		if (armed) expectVeto(row);
		else {
			expect(row.frames.at(-1)).toEqual(changed);
			expect(row.after.bond).toEqual([]);
			expect(row.steps).toEqual([]);
		}
	});
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
				if (mode === "REAL" && !reverse) {
					const control = await replay(
						"overlap-surviving-step",
						mode,
						"none",
						"overlap",
						[backupOn],
						split,
					);
					expect(control.frames.at(-1)).toEqual({
						id: "request-0",
						result: { success: true, applied: backupOn },
					});
					expect(control.steps.filter((step) => step === "rename")).toEqual([
						"rename",
					]);
					expect(control.before.preferences).toEqual({
						[physicalRecord("eth1", "fixture:eth1").linkId]: true,
					});
					expect(
						JSON.parse(
							Buffer.from(
								control.after.disk && "bytes" in control.after.disk
									? (control.after.disk.bytes ?? "")
									: "",
								"base64",
							).toString(),
						),
					).not.toHaveProperty("bond_opt_out");
					expect(control.after.bond.map(({ iface }) => iface)).toEqual([
						"eth0",
						"eth1",
					]);
				}
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

test("a veto leaves all three marker retractions for the next observer broadcast only", async () => {
	const row = await replay("marker-retraction", "REAL", "none", "marker", [
		off,
	]);
	const twin = await replay("marker-no-request", "REAL", "none", "marker", []);
	const actual = row.retraction;
	const control = twin.retraction;
	if (!actual || !control) throw new Error("Missing marker traces");
	expect(actual.observerDuring).toEqual([]);
	expect(actual.beforeRegistry).toEqual(control.beforeRegistry);
	expect(actual.afterRegistry).toEqual(control.afterRegistry);
	expect(actual.afterRegistry).toEqual(actual.beforeRegistry);
	expect(actual.nextBroadcasts).toEqual(control.nextBroadcasts);
	expect(actual.nextBroadcasts).toHaveLength(2);
	for (const { name, key } of markerRows) {
		expect(actual.nextBroadcasts[0]).toMatchObject({
			netif: { [name]: { [key]: null } },
		});
		expect(actual.nextBroadcasts[1]).toHaveProperty(["netif", name, "ip"]);
		expect(actual.nextBroadcasts[1]).not.toHaveProperty(["netif", name, key]);
	}
	expectVeto(row);
});

test("a later sender crossing the cutoff does not change the earlier request-time decision", async () => {
	const row = await replay("deadline-crossing", "REAL", "none", "deadline", [
		off,
	]);
	expect(row.before.bond.map(({ iface }) => iface)).toEqual(["eth0"]);
	expect(row.frames).toEqual([notice, refused(0)]);
	expect(row.edges).toEqual([]);
	expect(row.steps).toEqual([]);
	expect(row.after.bond.map(({ iface }) => iface)).toEqual(["eth0", "wwu0"]);
});

test("a stable identity deadline is inclusive and does not release a peer early", async () => {
	const before = await replay("deadline-before", "REAL", "none", "deadline", [
		off,
	]);
	const at = await replay("deadline-at", "REAL", "none", "deadline", [off]);
	const after = await replay("deadline-after", "REAL", "none", "deadline", [
		off,
	]);
	for (const ready of [at, after]) {
		expect(ready.before.bond.map(({ iface }) => iface)).toEqual([
			"eth0",
			"wwu0",
		]);
		expect(ready.frames.at(-1)).toEqual(changed);
		expect(ready.edges).toEqual([["wwu0"]]);
		expect(ready.after.bond.map(({ iface }) => iface)).toEqual(["wwu0"]);
	}
	expectVeto(before);
});

test("an ineligible alias is vetoed only if the actual legacy migration leaves no candidate", async () => {
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

test("a held USB function is vetoed only if the shared exact opt-out removes the last candidate", async () => {
	const last = await replay("held-exact-alias", "REAL", "none", "alias", [off]);
	const survivor = await replay(
		"held-exact-survivor",
		"REAL",
		"none",
		"alias-survivor",
		[off],
	);
	expect(last.before.bond.map(({ iface }) => iface)).toEqual(["wwu0"]);
	expect(survivor.frames.at(-1)).toEqual(changed);
	expect(survivor.after.bond.map(({ iface }) => iface)).toEqual(["eth1"]);
	const exact = last.before.bond[0]?.linkId;
	if (exact === undefined) throw new Error("Expected a stable exact key");
	expect(survivor.after.preferences).toEqual({ [exact]: true });
	expect(survivor.steps.filter((step) => step === "rename")).toEqual([
		"rename",
	]);
	expectVeto(last);
});
