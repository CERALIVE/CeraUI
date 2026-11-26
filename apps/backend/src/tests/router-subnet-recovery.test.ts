import { afterEach, expect, jest, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsbEnumerator } from "@ceralive/modem-control";
import { modemMutationKindSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import * as runner from "../helpers/run.ts";
import * as udev from "../modules/modems/modem-id-path-source.ts";
import { parseNetIdPaths } from "../modules/modems/modem-id-path-source.ts";
import {
	refreshMutationBlocks,
	setMutationBlockDeps,
} from "../modules/modems/mutation-blocks.ts";
import {
	commitMutationEntry,
	defaultMutationJournalFs,
	readMutationEntry,
	removeMutationEntry,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import { setMutationCaptureDeps } from "../modules/modems/mutation-rollback.ts";
import {
	modemPciSysfs,
	routerUsbSysfs,
} from "../modules/modems/router-subnet-recovery-device.ts";
import { hilinkDhcpSettingsBody } from "../modules/network/hilink-documents.ts";
import {
	HILINK_DHCP_SETTINGS_PATH,
	HILINK_SESSION_PATH,
} from "../modules/network/hilink-session.ts";
import {
	netdevPresence,
	noteNetdevWitness,
	resetNetdevLifetimesForTest,
} from "../modules/network/netdev-lifetime.ts";
import {
	defaultSubnetRewriteDeps,
	prepareSubnetRewrite,
} from "../modules/network/router-subnet-hygiene.ts";
import { preStateFor } from "../modules/network/router-subnet-rollback.ts";
import { readSystemBootId } from "../modules/streaming/armed-stream-marker.ts";
import {
	streamingBlockingMutation,
	tryAcquireModemMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	awaitRecoveryBarrier,
	isRecoveryPending,
} from "../modules/streaming/recovery-barrier.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import {
	acknowledgeMutationProcedure,
	decommissionMutationProcedure,
	listMutationBlocksProcedure,
	rebaselineMutationProcedure,
} from "../rpc/procedures/modems.procedure.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";
import { useReplayHarness } from "./helpers/journal-replay-harness.ts";
import { retirementFault } from "./helpers/journal-retirement-harness.ts";

const KEY = "platform-xhci-hcd.0.auto-usb-0:1";
const IFNAME = "enx0c5b8f279a64";
const USB_PATH = "/devices/platform/xhci/xhci-hcd.0.auto/usb1/1-1";
const ROUTER_UDEV = `P: ${USB_PATH}
E: SUBSYSTEM=usb
E: DEVTYPE=usb_device
E: ID_VENDOR_ID=12d1
E: ID_MODEL_ID=14dc
E: ID_MODEL=HiLink
E: ID_PATH=${KEY}

P: ${USB_PATH}/1-1:1.0/net/${IFNAME}
E: SUBSYSTEM=net
E: INTERFACE=${IFNAME}
E: ID_PATH=${KEY}:1.0
`;
const NO_ROUTER_UDEV = `P: /devices/virtual/net/lo
E: SUBSYSTEM=net
E: INTERFACE=lo
`;
const SUCCESSOR_UDEV = ROUTER_UDEV.replace(
	"ID_MODEL=HiLink",
	"ID_MODEL=successor",
);
const ORIGINAL = {
	address: "192.168.8.1",
	netmask: "255.255.255.0",
	dhcpStatus: "1",
	startAddress: "192.168.8.100",
	endAddress: "192.168.8.200",
	leaseTime: "86400",
	dnsStatus: "1",
	primaryDns: "192.168.8.1",
	secondaryDns: "8.8.8.8",
};
const TARGET = {
	...ORIGINAL,
	address: "192.168.9.1",
	startAddress: "192.168.9.100",
	endAddress: "192.168.9.200",
	primaryDns: "192.168.9.1",
};
const harness = useReplayHarness();
const listBlocks = () =>
	call(listMutationBlocksProcedure, undefined, { context: makeRpcContext() });

const acknowledge = (
	mode: "verified-rollback" | "force-rebaseline",
	context = makeRpcContext(),
) =>
	call(
		acknowledgeMutationProcedure,
		{ stableKey: KEY, mode, confirm: true },
		{ context },
	);
const decommission = (context = makeRpcContext()) =>
	call(
		decommissionMutationProcedure,
		{ stableKey: KEY, confirm: true },
		{ context },
	);
const rebaseline = () =>
	call(
		rebaselineMutationProcedure,
		{ stableKey: KEY, confirm: true },
		{ context: makeRpcContext() },
	);

async function recovery(
	options: {
		readonly witness?: "legacy" | "old boot";
		readonly record?: typeof ORIGINAL | "unreadable";
		readonly body?: (body: string) => string;
	} = {},
) {
	const initial = fs.statSync(import.meta.dir, { bigint: true });
	const replacement = fs.statSync(import.meta.path, { bigint: true });
	const kernelUsb = spyOn(routerUsbSysfs, "names").mockReturnValue([
		"usb1",
		"1-1",
	]);
	const roots = spyOn(routerUsbSysfs, "rootPath").mockReturnValue(
		"/sys/devices/platform/xhci/xhci-hcd.0.auto/usb1",
	);
	const deviceClass = spyOn(routerUsbSysfs, "deviceClass").mockReturnValue(
		"00",
	);
	const bootId = readSystemBootId();
	if (!bootId) throw new Error("fixture needs a kernel boot id");
	const stat = spyOn(fs, "statSync").mockReturnValue(initial);
	const listed = spyOn(netdevPresence, "inSysfs").mockReturnValue(true);
	const index = spyOn(netdevPresence, "ifindex").mockReturnValue(7);
	noteNetdevWitness(IFNAME, {
		ifindex: 7,
		node: `${initial.dev}:${initial.ino}`,
		present: true,
	});
	const readDb = spyOn(udev, "readUdevExportDb").mockResolvedValue(ROUTER_UDEV);
	setMutationCaptureDeps(
		createUsbEnumerator({ readUdevDatabase: () => readDb() }),
	);
	setMutationBlockDeps({ presentStableKeys: async () => new Set([KEY]) });
	const requests = spyOn(
		defaultSubnetRewriteDeps,
		"fetchViaInterface",
	).mockImplementation(async (_name, urls) =>
		urls.map((url) => {
			if (url.endsWith(HILINK_SESSION_PATH))
				return "<response><SesInfo>fixture</SesInfo><TokInfo>fixture</TokInfo></response>";
			if (options.record === "unreadable")
				throw new Error("fixture read fault");
			const body = hilinkDhcpSettingsBody(options.record ?? ORIGINAL)
				.replace("<request>", "<response>")
				.replace("</request>", "</response>");
			return options.body?.(body) ?? body;
		}),
	);
	const posts = spyOn(
		defaultSubnetRewriteDeps,
		"postViaInterface",
	).mockRejectedValue(new Error("recovery cannot write"));
	const host = spyOn(runner, "run").mockRejectedValue(
		new Error("recovery cannot run commands"),
	);
	await commitMutationEntry({
		version: 1,
		stableKey: KEY,
		kind: "router-subnet",
		state: "failed",
		attemptId: "router-subnet-fixture",
		startedAt: 1,
		updatedAt: 1,
		preState: {
			ifname: IFNAME,
			adminUrl: `http://${ORIGINAL.address}`,
			current: ORIGINAL,
			target: TARGET,
			...(options.witness === "legacy"
				? {}
				: {
						netdev: {
							bootId:
								options.witness === "old boot"
									? "00000000-0000-4000-8000-000000000001"
									: bootId,
							ifindex: 7,
							node: `${initial.dev}:${initial.ino}`,
						},
					}),
		},
		history: [{ state: "failed", at: 1 }],
	});
	await refreshMutationBlocks();
	let launches = 0;
	let attempt = 0;
	const session = createStreamSessionOrchestrator({
		initialLiveness: () => "idle",
		createAttemptId: () => `recovery-start-${++attempt}`,
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		awaitRecovery: awaitRecoveryBarrier,
		recoveryPending: isRecoveryPending,
		blockingMutation: streamingBlockingMutation,
	});
	return {
		kernelUsb,
		roots,
		deviceClass,
		readDb,
		requests,
		posts,
		host,
		launches: () => launches,
		start: () =>
			session.start({
				origin: "ui",
				launch: async () => {
					launches++;
				},
			}),
		replace: () => {
			kernelUsb.mockReturnValue(["usb1", "1-1"]);
			stat.mockReturnValue(replacement);
			listed.mockReturnValue(true);
			index.mockReturnValue(7);
			noteNetdevWitness(IFNAME, {
				ifindex: 7,
				node: `${replacement.dev}:${replacement.ino}`,
				present: true,
			});
			// The successor reuses the ifindex, port, name, and DHCP record.
			readDb.mockResolvedValue(SUCCESSOR_UDEV);
		},
		absent: () => {
			kernelUsb.mockReturnValue(["usb1"]);
			stat.mockReturnValue(undefined);
			listed.mockReturnValue(false);
			index.mockReturnValue(undefined);
			readDb.mockResolvedValue(NO_ROUTER_UDEV);
		},
	};
}

afterEach(() => {
	jest.restoreAllMocks();
	resetNetdevLifetimesForTest();
});

test("preflight records the kernel witness alongside the original DHCP read", async () => {
	await recovery({ witness: "legacy" });
	spyOn(defaultSubnetRewriteDeps, "isRealDevice").mockResolvedValue(true);
	spyOn(defaultSubnetRewriteDeps, "runIpRouteShowDefault").mockResolvedValue(
		`default via ${ORIGINAL.address} dev ${IFNAME}`,
	);
	spyOn(defaultSubnetRewriteDeps, "runIpAddrShow").mockResolvedValue("");
	const prepared = await prepareSubnetRewrite(
		IFNAME,
		"12d1:14dc",
		TARGET.address,
	);
	expect(prepared.ok).toBe(true);
	if (!prepared.ok) return;
	expect(preStateFor(prepared.plan)).toMatchObject({
		current: ORIGINAL,
		netdev: {
			bootId: readSystemBootId(),
			ifindex: 7,
			node: expect.any(String),
		},
	});
});

for (const [tag, field, fallback] of [
	["SecondaryDns", "secondaryDns", ORIGINAL.address],
	["DhcpLeaseTime", "leaseTime", "86400"],
	["DnsStatus", "dnsStatus", "1"],
	["PrimaryDns", "primaryDns", ORIGINAL.address],
] as const) {
	test(`LAN preflight still accepts omitted ${tag} with its exact fallback`, async () => {
		await recovery({
			body: (body) => body.replace(new RegExp(`<${tag}>[^<]*</${tag}>`), ""),
		});
		spyOn(defaultSubnetRewriteDeps, "isRealDevice").mockResolvedValue(true);
		spyOn(defaultSubnetRewriteDeps, "runIpRouteShowDefault").mockResolvedValue(
			`default via ${ORIGINAL.address} dev ${IFNAME}`,
		);
		spyOn(defaultSubnetRewriteDeps, "runIpAddrShow").mockResolvedValue("");
		const prepared = await prepareSubnetRewrite(
			IFNAME,
			"12d1:14dc",
			TARGET.address,
		);
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(prepared.plan.current).toEqual({ ...ORIGINAL, [field]: fallback });
		expect(preStateFor(prepared.plan)).toMatchObject({
			originalDhcpComplete: false,
		});
	});
}

test("Gone finds an unkeyed modem on the journaled ARM PCIe port", async () => {
	const unit = await recovery({ witness: "legacy" });
	unit.kernelUsb.mockReturnValue(["usb3"]);
	unit.roots.mockReturnValue(
		"/sys/devices/platform/fd500000.pcie/pci0000:00/0000:00:00.0/0000:01:00.0/usb3",
	);
	const key = "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.2";
	const old = await readMutationEntry(KEY);
	if (old === undefined) throw new Error("missing fixture entry");
	await commitMutationEntry({
		...old,
		stableKey: key,
		state: "device-absent-quarantine",
	});
	unit.readDb.mockResolvedValue(`P: /devices/platform/fd500000.pcie/pci0000:00/0000:00:00.0/0000:01:00.0/usb3/3-1/3-1.2
E: SUBSYSTEM=usb
E: DEVTYPE=usb_device
E: ID_VENDOR_ID=12d1
E: ID_MODEL_ID=14dc
`);
	const answer = await call(
		decommissionMutationProcedure,
		{ stableKey: key, confirm: true },
		{ context: makeRpcContext() },
	);
	expect(answer).toEqual({ success: false, error: "read_failed" });
	expect((await readMutationEntry(key))?.state).toBe(
		"device-absent-quarantine",
	);
});

const unfamiliarHosts = [
	[
		"dual-role PCI",
		"pci-0000:00:16.0-platform-xhci-hcd.1.auto",
		"/pci0000:00/0000:00:16.0/dwc3.0.auto/xhci-hcd.1.auto",
	],
	["long PCI domain", "pci-10000:e1:00.0", "/pci10000:e1/10000:e1:00.0"],
	["ACPI host", "acpi-PNP0D10:00", "/LNXSYSTM:00/PNP0D10:00"],
];
let prefixSeed = 730;
for (let i = 0; i < 8; i++) {
	prefixSeed = (Math.imul(prefixSeed, 1664525) + 1013904223) >>> 0;
	const id = prefixSeed.toString(36);
	const controller = `usb-host-${id}.auto`;
	unfamiliarHosts.push([
		`seeded prefix ${id}`,
		`unseen-${id}-bridge-${i}-${controller}`,
		`/unseen/${id}/${controller}`,
	]);
}

for (const [name, ancestry, path] of unfamiliarHosts) {
	test(`Gone cannot decommission an unkeyed modem under ${name}`, async () => {
		const unit = await recovery({ witness: "legacy" });
		// Even if the kernel snapshot no longer lists the device, the positive
		// udev path vetoes the decision until both sources agree on absence.
		unit.kernelUsb.mockReturnValue(["usb7"]);
		unit.roots.mockReturnValue(`/sys/devices${path}/usb7`);
		const entry = await readMutationEntry(KEY);
		if (entry === undefined) throw new Error("missing fixture entry");
		const stableKey = `${ancestry}-usb-0:1.2`;
		await commitMutationEntry({
			...entry,
			stableKey,
			state: "device-absent-quarantine",
		});
		unit.readDb.mockResolvedValue(`P: /devices${path}/usb7/7-1/7-1.2
E: SUBSYSTEM=usb
E: DEVTYPE=usb_device
E: ID_VENDOR_ID=12d1
E: ID_MODEL_ID=14dc
`);
		expect(
			await call(
				decommissionMutationProcedure,
				{ stableKey, confirm: true },
				{ context: makeRpcContext() },
			),
		).toEqual({
			success: false,
			error: "read_failed",
		});
		expect((await readMutationEntry(stableKey))?.state).toBe(
			"device-absent-quarantine",
		);
	});
}

test("Gone releases Start for an unlisted opaque key without a USB route", async () => {
	const unit = await recovery({ witness: "legacy" });
	unit.absent();
	const entry = await readMutationEntry(KEY);
	if (entry === undefined) throw new Error("missing fixture entry");
	const stableKey = "unknown-controller-usb-0:not-a-port";
	await removeMutationEntry(KEY);
	await commitMutationEntry({
		...entry,
		stableKey,
		state: "device-absent-quarantine",
	});
	await refreshMutationBlocks();
	expect(
		await call(
			decommissionMutationProcedure,
			{ stableKey, confirm: true },
			{ context: makeRpcContext() },
		),
	).toEqual({
		success: true,
		state: "decommissioned",
	});
	expect((await readMutationEntry(stableKey))?.state).toBe("decommissioned");
	expect(await unit.start()).toMatchObject({ result: "started" });
});

test("Gone cannot prove an empty port from a partial udev dump while sysfs still lists the USB device", async () => {
	const unit = await recovery({ witness: "legacy" });
	unit.readDb.mockResolvedValue(NO_ROUTER_UDEV);
	expect(await decommission()).toEqual({
		success: false,
		error: "read_failed",
	});
	expect((await readMutationEntry(KEY))?.state).toBe("failed");
});

const primary = "/sys/devices/platform/xhci/xhci-hcd.0.auto/usb1";
const renamed = "/sys/devices/platform/xhci/xhci-hcd.9.auto/usb1";
const other = "/sys/devices/platform/other-host/usb2";
const onboardHubPath = `${other.slice(4)}/2-1`;
const onboardHubUdev = `P: ${onboardHubPath}
E: SUBSYSTEM=usb
E: DEVTYPE=usb_device
E: TYPE=9/0/2
E: ID_PATH=platform-other-host-usb-0:1

P: ${onboardHubPath}/2-1:1.0
E: SUBSYSTEM=usb
E: DEVTYPE=usb_interface
E: INTERFACE=9/0/0
`;
const rootHubUdev = `P: ${other.slice(4)}
E: SUBSYSTEM=usb
E: DEVTYPE=usb_device
E: TYPE=9/0/3
`;
for (const row of [
	{ name: "controller removed", names: [], root: renamed, unknown: false },
	{
		name: "controller renamed and empty",
		names: ["usb1"],
		root: renamed,
		unknown: false,
	},
	{
		name: "controller renamed and same chain occupied",
		names: ["usb1", "1-1"],
		root: renamed,
		unknown: true,
	},
	{
		name: "controller swapped and empty",
		names: ["usb1"],
		root: "/sys/devices/platform/different-controller/usb1",
		unknown: false,
	},
	{
		name: "controller swapped and same chain occupied",
		names: ["usb1", "1-1"],
		root: "/sys/devices/platform/different-controller/usb1",
		unknown: true,
	},
	{
		name: "gadget mode",
		names: ["usb2", "2-2"],
		root: renamed,
		unknown: false,
	},
	{
		name: "two hosts with the same chain on the other host",
		names: ["usb1", "usb2", "2-1"],
		root: primary,
		unknown: false,
	},
	{
		name: "missing controller with the same chain on the second host",
		names: ["usb1", "usb2", "2-1"],
		root: renamed,
		unknown: true,
	},
	{
		name: "missing controller with an onboard hub",
		names: ["usb2", "2-1"],
		root: renamed,
		hubUdev: onboardHubUdev,
		hubClass: "09",
		unknown: false,
	},
	{
		name: "renamed controller with an onboard hub",
		names: ["usb1", "usb2", "2-1"],
		root: renamed,
		hubUdev: onboardHubUdev,
		hubClass: "09",
		unknown: false,
	},
	{
		name: "missing controller with a hub only in udev",
		names: ["usb2"],
		root: renamed,
		hubUdev: `${rootHubUdev}\n${onboardHubUdev}`,
		unknown: false,
	},
	{
		name: "missing controller with a raw-only dongle below a root hub",
		names: ["usb2"],
		root: renamed,
		hubUdev: `${rootHubUdev}
P: ${onboardHubPath}
E: SUBSYSTEM=usb
E: DEVTYPE=usb_device
E: TYPE=0/0/0
`,
		unknown: true,
	},
	{
		name: "renamed controller with a raw-only dongle interface below an onboard hub",
		names: ["usb1", "usb2", "2-1"],
		root: renamed,
		stableKey: `${KEY}.2`,
		hubUdev: `${rootHubUdev}\n${onboardHubUdev}
P: ${onboardHubPath}/2-1.2/2-1.2:1.0/net/${IFNAME}
E: SUBSYSTEM=net
E: INTERFACE=${IFNAME}
`,
		unknown: true,
	},
	{
		name: "missing controller with a hub only in sysfs",
		names: ["usb2", "2-1"],
		root: renamed,
		hubClass: "09",
		unknown: false,
	},
	{
		name: "missing controller with a truncated udev hub descriptor",
		names: ["usb2"],
		root: renamed,
		hubUdev: onboardHubUdev.replace("TYPE=9/0/2", "TYPE=9/"),
		unknown: true,
	},
	{
		name: "missing controller with stale udev hub evidence",
		names: ["usb2", "2-1"],
		root: renamed,
		hubUdev: onboardHubUdev,
		hubClass: "00",
		unknown: true,
	},
	{
		name: "missing controller with a non-hub class",
		names: ["usb2", "2-1"],
		root: renamed,
		hubUdev: onboardHubUdev.replace("TYPE=9/0/2", "TYPE=0/0/0"),
		hubClass: "00",
		unknown: true,
	},
	{
		name: "hub replaced at the recorded port",
		names: ["usb1", "1-1", "1-1.2"],
		root: primary,
		unknown: true,
	},
	{
		name: "device moved to a different port",
		names: ["usb1", "1-2"],
		root: primary,
		unknown: false,
	},
]) {
	test(`Keep and Gone agree on USB topology: ${row.name}`, async () => {
		const unit = await recovery({ witness: "legacy" });
		unit.absent();
		const stableKey = row.stableKey ?? KEY;
		if (stableKey !== KEY) {
			const entry = await readMutationEntry(KEY);
			if (entry === undefined) throw new Error("missing fixture entry");
			await removeMutationEntry(KEY);
			await commitMutationEntry({ ...entry, stableKey });
			await refreshMutationBlocks();
		}
		const context = makeRpcContext();
		const input = { stableKey, confirm: true as const };
		const ack = (mode: "verified-rollback" | "force-rebaseline") =>
			call(acknowledgeMutationProcedure, { ...input, mode }, { context });
		const gone = () => call(decommissionMutationProcedure, input, { context });
		unit.kernelUsb.mockReturnValue(row.names);
		unit.roots.mockImplementation((name) =>
			name === "usb1" ? row.root : other,
		);
		if (row.hubUdev) unit.readDb.mockResolvedValue(row.hubUdev);
		if (row.hubClass !== undefined)
			unit.deviceClass.mockReturnValue(row.hubClass);
		const blocks = (await listBlocks()).blocks;
		const check = await ack("verified-rollback");
		const keep = await ack("force-rebaseline");
		expect(await gone()).toEqual(
			row.unknown
				? { success: false, error: "read_failed" }
				: { success: true, state: "decommissioned" },
		);
		expect(blocks).toMatchObject([
			{ stableKey, devicePresent: row.unknown, checkable: false },
		]);
		expect(check).toEqual({
			success: false,
			error: row.unknown ? "read_failed" : "device_absent",
		});
		expect(keep).toEqual({
			success: false,
			error: row.unknown ? "read_failed" : "device_absent",
		});
		expect((await readMutationEntry(stableKey))?.state).toBe(
			row.unknown ? "failed" : "decommissioned",
		);
		if (row.unknown) {
			expect(await unit.start()).toMatchObject({
				result: "failed",
				failure: { class: "mutation_blocked" },
			});
			unit.kernelUsb.mockReturnValue(
				row.names.filter((name) => /^usb\d+$/.test(name)),
			);
			unit.readDb.mockResolvedValue(NO_ROUTER_UDEV);
			expect(await gone()).toEqual({
				success: true,
				state: "decommissioned",
			});
		}
		expect(await unit.start()).toMatchObject({ result: "started" });
		expect(unit.requests).not.toHaveBeenCalled();
		expect(unit.posts).not.toHaveBeenCalled();
	});
}

test("defaulted DHCP metadata hides and refuses Check again even with a valid witness", async () => {
	const unit = await recovery();
	const entry = await readMutationEntry(KEY);
	if (entry === undefined) throw new Error("missing fixture entry");
	expect(entry.preState.netdev).toBeDefined();
	await commitMutationEntry({
		...entry,
		preState: { ...entry.preState, originalDhcpComplete: false },
	});
	await refreshMutationBlocks();
	expect((await listBlocks()).blocks).toMatchObject([
		{ stableKey: KEY, checkable: false },
	]);
	expect(await acknowledge("verified-rollback")).toEqual({
		success: false,
		error: "read_failed",
	});
	expect(unit.requests).not.toHaveBeenCalled();
	expect(unit.posts).not.toHaveBeenCalled();
	expect((await readMutationEntry(KEY))?.state).toBe("failed");
});

test("a journaled preflight with DHCP defaults cannot become checkable on the same boot", async () => {
	const unit = await recovery({
		record: { ...ORIGINAL, secondaryDns: ORIGINAL.address },
		body: (body) => body.replace(/<SecondaryDns>[^<]*<\/SecondaryDns>/, ""),
	});
	spyOn(defaultSubnetRewriteDeps, "isRealDevice").mockResolvedValue(true);
	spyOn(defaultSubnetRewriteDeps, "runIpRouteShowDefault").mockResolvedValue(
		`default via ${ORIGINAL.address} dev ${IFNAME}`,
	);
	spyOn(defaultSubnetRewriteDeps, "runIpAddrShow").mockResolvedValue("");
	const prepared = await prepareSubnetRewrite(
		IFNAME,
		"12d1:14dc",
		TARGET.address,
	);
	expect(prepared.ok).toBe(true);
	if (!prepared.ok) return;
	const preState = preStateFor(prepared.plan);
	expect(preState).toMatchObject({
		originalDhcpComplete: false,
		current: { secondaryDns: ORIGINAL.address },
	});
	if ("isCurrent" in prepared.plan) {
		// Replay needs this witness; it does not certify DHCP defaults.
		const { dev, ino } = fs.statSync(import.meta.dir, { bigint: true });
		expect(preState.netdev).toEqual({
			bootId: readSystemBootId(),
			ifindex: 7,
			node: `${dev}:${ino}`,
		});
	} else {
		expect(preState).not.toHaveProperty("netdev");
	}
	const entry = await readMutationEntry(KEY);
	if (entry === undefined) throw new Error("missing fixture entry");
	await commitMutationEntry({ ...entry, preState });
	await refreshMutationBlocks();
	unit.requests.mockClear();
	unit.requests.mockImplementation(async (_name, urls) =>
		urls.map((url) =>
			url.endsWith(HILINK_SESSION_PATH)
				? "<response><SesInfo>fixture</SesInfo><TokInfo>fixture</TokInfo></response>"
				: hilinkDhcpSettingsBody({
						...ORIGINAL,
						secondaryDns: ORIGINAL.address,
					})
						.replace("<request>", "<response>")
						.replace("</request>", "</response>"),
		),
	);
	expect((await listBlocks()).blocks).toMatchObject([
		{ stableKey: KEY, checkable: false },
	]);
	expect(await acknowledge("verified-rollback")).toEqual({
		success: false,
		error: "read_failed",
	});
	expect(unit.requests).not.toHaveBeenCalled();
	expect(unit.posts).not.toHaveBeenCalled();
	expect((await readMutationEntry(KEY))?.state).toBe("failed");
});

test("Gone reports the identified occupant of a failed legacy row as still connected", async () => {
	const unit = await recovery({ witness: "legacy" });
	expect(await decommission()).toEqual({
		success: false,
		error: "state_mismatch",
	});
	expect(unit.requests).not.toHaveBeenCalled();
	expect((await readMutationEntry(KEY))?.state).toBe("failed");
});

for (const kind of modemMutationKindSchema.options) {
	test(`Gone on a failed ${kind} entry distinguishes physical presence from absence`, async () => {
		const unit = await recovery({ witness: "legacy" });
		const entry = await readMutationEntry(KEY);
		if (entry === undefined) throw new Error("missing fixture entry");
		await commitMutationEntry({ ...entry, kind });
		expect(await decommission()).toEqual({
			success: false,
			error: "state_mismatch",
		});
		unit.readDb.mockRejectedValue(new Error("inventory failed"));
		expect(await decommission()).toEqual({
			success: false,
			error: "read_failed",
		});
		unit.replace();
		expect(await decommission()).toEqual({
			success: false,
			error: "state_mismatch",
		});
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
		unit.absent();
		expect(await decommission()).toEqual({
			success: true,
			state: "decommissioned",
		});
		expect(
			(await readMutationEntry(KEY))?.history.map(({ state }) => state),
		).toEqual(["failed", "device-absent-quarantine", "decommissioned"]);
		expect(tryAcquireModemMutation(KEY)).toMatchObject({
			admitted: false,
			refusal: "device_decommissioned",
		});
		await unit.start();
		expect(unit.launches()).toBe(1);
		expect(unit.requests).not.toHaveBeenCalled();
		expect(unit.posts).not.toHaveBeenCalled();
	});
}

test("Gone on an absent failed subnet row releases Start without a settings probe", async () => {
	const unit = await recovery({ witness: "legacy" });
	unit.absent();
	expect(await decommission()).toEqual({
		success: true,
		state: "decommissioned",
	});
	expect(
		(await readMutationEntry(KEY))?.history.map(({ state }) => state),
	).toEqual(["failed", "device-absent-quarantine", "decommissioned"]);
	expect(unit.requests).not.toHaveBeenCalled();
	await unit.start();
	expect(unit.launches()).toBe(1);
});

test("a swapped preflight cannot journal the original witness alongside the successor's record", async () => {
	const unit = await recovery({ record: { ...ORIGINAL, leaseTime: "60" } });
	const fetch = unit.requests.getMockImplementation();
	unit.requests.mockImplementation(async (name, urls) => {
		if (urls[0]?.endsWith(HILINK_DHCP_SETTINGS_PATH)) unit.replace();
		return (await fetch?.(name, urls)) ?? [];
	});
	spyOn(defaultSubnetRewriteDeps, "isRealDevice").mockResolvedValue(true);
	spyOn(defaultSubnetRewriteDeps, "runIpRouteShowDefault").mockResolvedValue(
		`default via ${ORIGINAL.address} dev ${IFNAME}`,
	);
	spyOn(defaultSubnetRewriteDeps, "runIpAddrShow").mockResolvedValue("");
	const prepared = await prepareSubnetRewrite(
		IFNAME,
		"12d1:14dc",
		TARGET.address,
	);
	if (!prepared.ok) {
		// A post-GET fence discards the settings reply.
		expect(prepared.reason).toBe("unreadable");
	} else {
		expect(prepared.plan.current.leaseTime).toBe("60");
		expect(preStateFor(prepared.plan)).not.toHaveProperty("netdev");
	}
	expect(unit.requests.mock.calls.at(-1)?.[1]).toEqual([
		`http://${ORIGINAL.address}${HILINK_DHCP_SETTINGS_PATH}`,
	]);
	expect(unit.posts).not.toHaveBeenCalled();
});

test("rebaseline keeps an unresolved same-port recommission pending", async () => {
	const unit = await recovery({ witness: "legacy" });
	const entry = await readMutationEntry(KEY);
	if (entry === undefined) throw new Error("missing fixture entry");
	await commitMutationEntry({ ...entry, state: "recommission-pending" });
	unit.readDb.mockResolvedValue(ROUTER_UDEV.replace(/^E: ID_PATH=.*\n/gm, ""));
	expect(await rebaseline()).toEqual({ success: false, error: "read_failed" });
	expect((await readMutationEntry(KEY))?.state).toBe("recommission-pending");
	expect(unit.requests).not.toHaveBeenCalled();
});

test("Check again reads the original router DHCP record and releases both admission paths", async () => {
	const unit = await recovery();
	const enumerator = createUsbEnumerator({
		readUdevDatabase: async () => ROUTER_UDEV,
	});
	const [physical] = await enumerator.enumerate();
	expect(physical).toMatchObject({ physicalUid: KEY });
	expect(physical?.ifname).toBeUndefined();
	expect(parseNetIdPaths(ROUTER_UDEV).get(IFNAME)).toBe(`${KEY}:1.0`);
	expect((await listBlocks()).blocks).toMatchObject([
		{ stableKey: KEY, kind: "router-subnet", checkable: true },
	]);
	expect(unit.requests).not.toHaveBeenCalled();
	expect(await unit.start()).toMatchObject({
		result: "failed",
		failure: { class: "mutation_blocked" },
	});
	expect(tryAcquireModemMutation(KEY)).toMatchObject({
		admitted: false,
		refusal: "mutation_blocked",
	});
	expect(await acknowledge("verified-rollback")).toEqual({
		success: true,
		state: "acknowledged",
	});
	expect(unit.requests.mock.calls.map(([name, urls]) => [name, urls])).toEqual([
		[IFNAME, [`http://${ORIGINAL.address}${HILINK_SESSION_PATH}`]],
		[IFNAME, [`http://${ORIGINAL.address}${HILINK_DHCP_SETTINGS_PATH}`]],
	]);
	expect(unit.posts).not.toHaveBeenCalled();
	expect(unit.host).not.toHaveBeenCalled();
	expect(await readMutationEntry(KEY)).toBeUndefined();
	const lease = tryAcquireModemMutation(KEY);
	expect(lease.admitted).toBe(true);
	if (lease.admitted) lease.lease.release();
	await unit.start();
	expect(unit.launches()).toBe(1);
});

for (const refusal of [
	"legacy",
	"old boot",
	"invalid saved baseline",
	"target",
	"unreadable",
	"successor",
] as const) {
	test(`Check again retains the block: ${refusal}`, async () => {
		const unit = await recovery({
			witness:
				refusal === "legacy" || refusal === "old boot" ? refusal : undefined,
			record:
				refusal === "target"
					? TARGET
					: refusal === "unreadable"
						? refusal
						: ORIGINAL,
		});
		if (refusal === "invalid saved baseline") {
			const entry = await readMutationEntry(KEY);
			if (entry === undefined) throw new Error("missing fixture entry");
			await commitMutationEntry({
				...entry,
				preState: {
					...entry.preState,
					current: { ...ORIGINAL, leaseTime: "invalid" },
				},
			});
			await refreshMutationBlocks();
		}
		if (refusal === "successor") unit.replace();
		expect((await listBlocks()).blocks[0]?.checkable).toBe(
			refusal === "target" || refusal === "unreadable",
		);
		expect(unit.requests).not.toHaveBeenCalled();
		expect(await acknowledge("verified-rollback")).toEqual({
			success: false,
			error: refusal === "target" ? "state_mismatch" : "read_failed",
		});
		if (refusal !== "target" && refusal !== "unreadable")
			expect(unit.requests).not.toHaveBeenCalled();
		expect(unit.posts).not.toHaveBeenCalled();
		expect(unit.host).not.toHaveBeenCalled();
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
	});
}

for (const [field, value] of Object.entries({
	address: TARGET.address,
	netmask: "255.255.0.0",
	dhcpStatus: "0",
	startAddress: TARGET.startAddress,
	endAddress: TARGET.endAddress,
	leaseTime: "60",
	dnsStatus: "0",
	primaryDns: TARGET.address,
	secondaryDns: TARGET.address,
})) {
	test(`Check again refuses a complete DHCP record with changed ${field}`, async () => {
		const unit = await recovery({ record: { ...ORIGINAL, [field]: value } });
		expect(await acknowledge("verified-rollback")).toEqual({
			success: false,
			error: "state_mismatch",
		});
		expect(unit.requests).toHaveBeenCalledTimes(2);
		expect(unit.posts).not.toHaveBeenCalled();
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
	});
}

const malformedRecords: Record<string, (body: string) => string> = {
	truncated: (body) => body.replace("</response>", ""),
	partial: (body) => body.replace(/<DnsStatus>[^<]*<\/DnsStatus>/, ""),
	"duplicate field": (body) =>
		body.replace(
			"<PrimaryDns>",
			"<PrimaryDns>1.1.1.1</PrimaryDns><PrimaryDns>",
		),
	"invalid field": (body) => body.replace(ORIGINAL.secondaryDns, "300.0.0.1"),
	"extra document": (body) => `${body}${body}`,
};
for (const [fault, body] of Object.entries(malformedRecords)) {
	test(`Check again cannot verify a ${fault} DHCP reply`, async () => {
		const unit = await recovery({ body });
		expect(await acknowledge("verified-rollback")).toEqual({
			success: false,
			error: "read_failed",
		});
		expect(unit.requests).toHaveBeenCalledTimes(2);
		expect(unit.posts).not.toHaveBeenCalled();
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
	});
}

test("Check again does not send the settings GET if the netdev changes during the session GET", async () => {
	const unit = await recovery();
	const fetch = unit.requests.getMockImplementation();
	unit.requests.mockImplementation(async (name, urls) => {
		const response = (await fetch?.(name, urls)) ?? [];
		if (urls[0]?.endsWith(HILINK_SESSION_PATH)) unit.replace();
		return response;
	});
	expect(await acknowledge("verified-rollback")).toEqual({
		success: false,
		error: "read_failed",
	});
	expect(unit.requests).toHaveBeenCalledTimes(1);
	expect(unit.posts).not.toHaveBeenCalled();
	expect((await readMutationEntry(KEY))?.state).toBe("failed");
});

test("the card offers Check again for a USB mode row with a readable descriptor baseline", async () => {
	const unit = await recovery();
	const db =
		ROUTER_UDEV.replace(
			"E: ID_MODEL=HiLink",
			"E: ID_MODEL=HiLink\nE: ID_REVISION=0001\nE: ID_USB_INTERFACES=:ff0000:",
		) +
		`
P: ${USB_PATH}/1-1:1.0
E: SUBSYSTEM=usb
E: DEVTYPE=usb_interface
E: DRIVER=qmi_wwan
`;
	unit.readDb.mockResolvedValue(db);
	const entry = await readMutationEntry(KEY);
	if (entry === undefined) throw new Error("missing fixture entry");
	await commitMutationEntry({
		...entry,
		kind: "usb-mode",
		preState: {
			vidPid: "12d1:14dc",
			model: "HiLink",
			firmwareRevision: "0001",
			mode: "qmi",
		},
	});
	await refreshMutationBlocks();
	expect((await listBlocks()).blocks).toMatchObject([
		{ stableKey: KEY, kind: "usb-mode", checkable: true },
	]);
	expect(await acknowledge("verified-rollback")).toEqual({
		success: true,
		state: "acknowledged",
	});
	expect(unit.requests).not.toHaveBeenCalled();
});

for (const [kind, preState] of [
	["band-lock", { bands: ["any"] }],
	["five-g-pref", { allowed: "5g", preferred: "" }],
	[
		"modem-config",
		{
			apn: "internet",
			username: "",
			roaming: true,
			network: "",
			autoconfig: true,
		},
	],
	["fcc-unlock", { key: "12d1:14dc", enabled: false }],
	["usb-mode", { mode: "qmi" }],
] as const) {
	test(`the card hides Check again for ${kind} without a descriptor baseline`, async () => {
		const unit = await recovery();
		const entry = await readMutationEntry(KEY);
		if (entry === undefined) throw new Error("missing fixture entry");
		await commitMutationEntry({ ...entry, kind, preState });
		await refreshMutationBlocks();
		expect((await listBlocks()).blocks).toMatchObject([
			{ stableKey: KEY, kind, checkable: false },
		]);
		expect(await acknowledge("verified-rollback")).toEqual({
			success: false,
			error: "state_mismatch",
		});
		expect(unit.requests).not.toHaveBeenCalled();
	});
}

for (const change of ["netdev", "journal"] as const) {
	test(`Check again cannot clear a stale ${change} observation`, async () => {
		const unit = await recovery();
		const fetch = unit.requests.getMockImplementation();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		unit.requests.mockImplementation(async (name, urls) => {
			if (urls[0]?.endsWith(HILINK_DHCP_SETTINGS_PATH)) {
				entered.resolve();
				await release.promise;
			}
			return (await fetch?.(name, urls)) ?? [];
		});
		const action = acknowledge("verified-rollback");
		try {
			const started = await Promise.race([
				entered.promise.then(() => true),
				action.then(() => false),
			]);
			expect(started).toBe(true);
			if (change === "netdev") unit.replace();
			else {
				const entry = await readMutationEntry(KEY);
				if (entry === undefined) throw new Error("missing fixture entry");
				await commitMutationEntry({ ...entry, attemptId: "newer-authority" });
			}
		} finally {
			release.resolve();
		}
		expect(await action).toEqual({
			success: false,
			error: change === "netdev" ? "read_failed" : "not_blocked",
		});
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
		expect(unit.posts).not.toHaveBeenCalled();
	});
}

test("an absent failed subnet enters quarantine, decommission frees Start, and a successor needs explicit rebaseline", async () => {
	const unit = await recovery({ witness: "legacy" });
	unit.absent();
	expect(await acknowledge("force-rebaseline")).toEqual({
		success: false,
		error: "device_absent",
	});
	expect((await readMutationEntry(KEY))?.state).toBe(
		"device-absent-quarantine",
	);
	expect(await decommission()).toEqual({
		success: true,
		state: "decommissioned",
	});
	await unit.start();
	expect(unit.launches()).toBe(1);
	expect(tryAcquireModemMutation(KEY)).toMatchObject({
		admitted: false,
		refusal: "device_decommissioned",
	});
	unit.replace();
	await initMutationRecovery();
	expect((await readMutationEntry(KEY))?.state).toBe("recommission-pending");
	expect(await rebaseline()).toEqual({ success: true, state: "acknowledged" });
	expect(await readMutationEntry(KEY)).toBeUndefined();
	const lease = tryAcquireModemMutation(KEY);
	expect(lease.admitted).toBe(true);
	if (lease.admitted) lease.lease.release();
	expect(unit.requests).not.toHaveBeenCalled();
	expect(unit.posts).not.toHaveBeenCalled();
});

test("decommission does not declare a now occupied subnet slot absent", async () => {
	const unit = await recovery({ witness: "legacy" });
	unit.absent();
	expect(await acknowledge("verified-rollback")).toEqual({
		success: false,
		error: "device_absent",
	});
	unit.replace();
	expect(await decommission()).toEqual({
		success: false,
		error: "state_mismatch",
	});
	expect((await readMutationEntry(KEY))?.state).toBe("failed");
	expect(await unit.start()).toMatchObject({
		result: "failed",
		failure: { class: "mutation_blocked" },
	});
	expect(await acknowledge("force-rebaseline")).toEqual({
		success: true,
		state: "acknowledged",
	});
	expect(unit.requests).not.toHaveBeenCalled();
	expect(unit.posts).not.toHaveBeenCalled();
});

for (const fault of [
	"unkeyed device in this port",
	"capture failure",
	"empty inventory",
] as const) {
	test(`decommission keeps quarantine on ${fault}`, async () => {
		const unit = await recovery({ witness: "legacy" });
		unit.absent();
		expect(await acknowledge("force-rebaseline")).toMatchObject({
			error: "device_absent",
		});
		if (fault === "unkeyed device in this port") {
			unit.readDb.mockResolvedValue(
				ROUTER_UDEV.replace(/^E: ID_PATH=.*\n/gm, ""),
			);
		} else if (fault === "empty inventory") {
			unit.readDb.mockResolvedValue("");
		} else {
			unit.readDb.mockRejectedValue(new Error("udevadm failed"));
		}
		expect(await decommission()).toEqual({
			success: false,
			error: "read_failed",
		});
		expect((await readMutationEntry(KEY))?.state).toBe(
			"device-absent-quarantine",
		);
		expect(await unit.start()).toMatchObject({
			result: "failed",
			failure: { class: "mutation_blocked" },
		});
	});
}

test("persistent udev failure settles replay but leaves quarantine and Start blocked", async () => {
	const unit = await recovery({ witness: "legacy" });
	unit.absent();
	expect(await acknowledge("force-rebaseline")).toMatchObject({
		error: "device_absent",
	});
	unit.readDb.mockRejectedValue(
		new Error("udevadm still unavailable after restart"),
	);
	const replay = await initMutationRecovery();
	expect(replay.unreadable).toBe(0);
	expect(await decommission()).toEqual({
		success: false,
		error: "read_failed",
	});
	expect(await acknowledge("force-rebaseline")).toEqual({
		success: false,
		error: "read_failed",
	});
	expect((await readMutationEntry(KEY))?.state).toBe(
		"device-absent-quarantine",
	);
	expect(await unit.start()).toMatchObject({
		result: "failed",
		failure: { class: "mutation_blocked" },
	});
	expect(unit.launches()).toBe(0);
});

test("decommission is not refused by an unkeyed device in another port", async () => {
	const unit = await recovery({ witness: "legacy" });
	unit.absent();
	expect(await acknowledge("force-rebaseline")).toMatchObject({
		error: "device_absent",
	});
	unit.readDb.mockResolvedValue(
		ROUTER_UDEV.replaceAll("/1-1", "/1-2").replace(/^E: ID_PATH=.*\n/gm, ""),
	);
	expect(await decommission()).toEqual({
		success: true,
		state: "decommissioned",
	});
	await unit.start();
	expect(unit.launches()).toBe(1);
});

test("two force-rebaseline clients serialize, and only one retires the occupied slot", async () => {
	const unit = await recovery({ witness: "legacy" });
	unit.replace();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	unit.readDb.mockImplementation(async () => {
		entered.resolve();
		await release.promise;
		return SUCCESSOR_UDEV;
	});
	const first = acknowledge("force-rebaseline");
	await entered.promise;
	const second = acknowledge("force-rebaseline");
	release.resolve();
	expect(await first).toEqual({ success: true, state: "acknowledged" });
	expect(await second).toEqual({ success: false, error: "no_entry" });
	expect(await readMutationEntry(KEY)).toBeUndefined();
	expect(unit.requests).not.toHaveBeenCalled();
});

test("startup archives a durably acknowledged subnet decision without probing or writing again", async () => {
	const unit = await recovery({ witness: "legacy" });
	unit.replace();
	retirementFault(harness.root(), 1);
	expect(await acknowledge("force-rebaseline")).toEqual({
		success: false,
		error: "journal_write_failed",
	});
	expect(await readMutationEntry(KEY)).toMatchObject({
		state: "acknowledged",
		acknowledgedMode: "force-rebaseline",
		preState: { model: "successor" },
	});
	setMutationJournalDeps({ dir: harness.root(), fs: defaultMutationJournalFs });
	expect((await initMutationRecovery()).pruned).toBe(1);
	expect(await readMutationEntry(KEY)).toBeUndefined();
	expect(unit.requests).not.toHaveBeenCalled();
	expect(unit.posts).not.toHaveBeenCalled();
});

async function killOperatorChild(db: string, mode: "keep" | "gone") {
	const bin = await mkdtemp(join(tmpdir(), "router-recovery-udev-"));
	try {
		const fake = join(bin, "udevadm");
		await Bun.write(
			fake,
			'#!/bin/sh\n[ "$*" = "info --export-db" ] || exit 2\nprintf "%s" "$RECOVERY_TEST_UDEV"\n',
		);
		await chmod(fake, 0o700);
		const child = Bun.spawn({
			cmd: [
				process.execPath,
				new URL("./helpers/router-subnet-ack-crash-child.ts", import.meta.url)
					.pathname,
				harness.root(),
				KEY,
				mode,
			],
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH ?? ""}`,
				RECOVERY_TEST_UDEV: db,
			},
			stderr: "pipe",
			stdout: "ignore",
			timeout: 3000,
		});
		const [, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
		]);
		expect(child.signalCode, stderr).toBe("SIGKILL");
	} finally {
		await rm(bin, { recursive: true });
	}
}

test("restart after SIGKILL at the subnet acknowledgement archive resumes the durable decision", async () => {
	const unit = await recovery({ witness: "legacy" });
	await killOperatorChild(SUCCESSOR_UDEV, "keep");
	expect(await readMutationEntry(KEY)).toMatchObject({
		state: "acknowledged",
		acknowledgedMode: "force-rebaseline",
		preState: { model: "successor" },
	});
	expect((await initMutationRecovery()).pruned).toBe(1);
	expect(await readMutationEntry(KEY)).toBeUndefined();
	const lease = tryAcquireModemMutation(KEY);
	expect(lease.admitted).toBe(true);
	if (lease.admitted) lease.lease.release();
	await unit.start();
	expect(unit.launches()).toBe(1);
});

test("restart between the two Gone commits leaves quarantine until absence is confirmed again", async () => {
	const unit = await recovery({ witness: "legacy" });
	const entry = await readMutationEntry(KEY);
	if (entry === undefined) throw new Error("missing fixture entry");
	await commitMutationEntry({ ...entry, kind: "band-lock" });
	unit.absent();
	await killOperatorChild(NO_ROUTER_UDEV, "gone");
	expect(
		(await readMutationEntry(KEY))?.history.map(({ state }) => state),
	).toEqual(["failed", "device-absent-quarantine"]);
	await initMutationRecovery();
	expect(await unit.start()).toMatchObject({
		result: "failed",
		failure: { class: "mutation_blocked" },
	});
	unit.replace();
	expect(await decommission()).toEqual({
		success: false,
		error: "state_mismatch",
	});
	expect((await readMutationEntry(KEY))?.state).toBe("failed");
	unit.absent();
	expect(await decommission()).toEqual({
		success: true,
		state: "decommissioned",
	});
	expect(tryAcquireModemMutation(KEY)).toMatchObject({
		admitted: false,
		refusal: "device_decommissioned",
	});
	await unit.start();
	expect(unit.launches()).toBe(1);
});

test("Gone answers correctly after Keep succeeds or enters quarantine first", async () => {
	const unit = await recovery({ witness: "legacy" });
	const entry = await readMutationEntry(KEY);
	if (entry === undefined) throw new Error("missing fixture entry");
	await commitMutationEntry({ ...entry, kind: "usb-mode" });
	expect(await acknowledge("force-rebaseline")).toEqual({
		success: true,
		state: "acknowledged",
	});
	expect(await decommission()).toEqual({ success: false, error: "no_entry" });
	await commitMutationEntry({ ...entry, kind: "band-lock" });
	unit.absent();
	expect(await acknowledge("force-rebaseline")).toEqual({
		success: false,
		error: "device_absent",
	});
	expect(await decommission()).toEqual({
		success: true,
		state: "decommissioned",
	});
	expect(unit.posts).not.toHaveBeenCalled();
});

test("two Gone clients cannot decommission the same failed non-router row twice", async () => {
	const unit = await recovery({ witness: "legacy" });
	const entry = await readMutationEntry(KEY);
	if (entry === undefined) throw new Error("missing fixture entry");
	await commitMutationEntry({ ...entry, kind: "modem-config" });
	unit.absent();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	unit.readDb.mockImplementation(async () => {
		entered.resolve();
		await release.promise;
		return NO_ROUTER_UDEV;
	});
	const first = decommission();
	await Promise.race([entered.promise, first]);
	const second = decommission();
	release.resolve();
	expect(await first).toEqual({ success: true, state: "decommissioned" });
	expect(await second).toEqual({ success: false, error: "not_blocked" });
	expect(
		(await readMutationEntry(KEY))?.history.filter(
			({ state }) => state === "decommissioned",
		),
	).toHaveLength(1);
});

test("Gone rechecks when a replacement arrives during the quarantine commit", async () => {
	const unit = await recovery({ witness: "legacy" });
	const entry = await readMutationEntry(KEY);
	if (entry === undefined) throw new Error("missing fixture entry");
	await commitMutationEntry({ ...entry, kind: "modem-config" });
	unit.absent();
	let renames = 0;
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			rename: async (from, to) => {
				await defaultMutationJournalFs.rename(from, to);
				if (++renames === 1) unit.replace();
			},
		},
	});
	expect(await decommission()).toEqual({
		success: false,
		error: "state_mismatch",
	});
	expect(
		(await readMutationEntry(KEY))?.history.map(({ state }) => state),
	).toEqual(["failed", "device-absent-quarantine", "failed"]);
	expect(await unit.start()).toMatchObject({
		result: "failed",
		failure: { class: "mutation_blocked" },
	});
});

test("Gone handles an identified native PCI modem and refuses incomplete PCI evidence", async () => {
	const unit = await recovery({ witness: "legacy" });
	const entry = await readMutationEntry(KEY);
	if (entry === undefined) throw new Error("missing fixture entry");
	const stableKey = "platform-fd500000.pcie-pci-10000:e1:00.0";
	await commitMutationEntry({ ...entry, stableKey, kind: "fcc-unlock" });
	const gone = () =>
		call(
			decommissionMutationProcedure,
			{ stableKey, confirm: true },
			{ context: makeRpcContext() },
		);
	const pci = spyOn(modemPciSysfs, "addresses");
	const pciPath =
		"P: /devices/platform/fd500000.pcie/pci10000:e1/10000:e1:00.0\nE: SUBSYSTEM=pci\n";
	unit.readDb.mockResolvedValue(`${pciPath}E: ID_PATH=${stableKey}\n`);
	expect(await gone()).toEqual({ success: false, error: "state_mismatch" });
	unit.readDb.mockResolvedValue(pciPath);
	expect(await gone()).toEqual({ success: false, error: "read_failed" });
	unit.readDb.mockResolvedValue(NO_ROUTER_UDEV);
	pci.mockReturnValue(["10000:e1:00.0"]);
	expect(await gone()).toEqual({ success: false, error: "read_failed" });
	pci.mockReturnValue(["10000:e1:00.1"]);
	expect(await gone()).toEqual({ success: true, state: "decommissioned" });
});

const nativePciKey = "platform-fd500000.pcie-pci-10000:e1:00.0";
const nativeSocKey = "platform-modem-mhi";

for (const row of [
	{
		name: "missing PCI bus",
		code: "ENOENT",
		appearsInUdev: false,
		absent: true,
	},
	{
		name: "unreadable PCI bus",
		code: "EACCES",
		appearsInUdev: false,
		absent: false,
	},
	{
		name: "missing PCI bus with an unkeyed function in udev",
		code: "ENOENT",
		appearsInUdev: true,
		absent: false,
	},
]) {
	test(`Keep and Gone agree on ${row.name}`, async () => {
		const unit = await recovery({ witness: "legacy" });
		unit.absent();
		const entry = await readMutationEntry(KEY);
		if (!entry) throw new Error("missing fixture entry");
		await removeMutationEntry(KEY);
		await commitMutationEntry({
			...entry,
			kind: "modem-config",
			stableKey: nativePciKey,
		});
		await refreshMutationBlocks();
		if (row.appearsInUdev) {
			unit.readDb.mockResolvedValue(
				"P: /devices/platform/fd500000.pcie/pci10000:e1/10000:e1:00.0\nE: SUBSYSTEM=pci\n",
			);
		}
		spyOn(modemPciSysfs, "addresses").mockImplementation(() => {
			throw Object.assign(new Error(row.name), { code: row.code });
		});
		const context = makeRpcContext();
		const key = { stableKey: nativePciKey, confirm: true as const };
		expect((await listBlocks()).blocks).toMatchObject([
			{ stableKey: nativePciKey, devicePresent: !row.absent, checkable: false },
		]);
		expect(
			await call(
				acknowledgeMutationProcedure,
				{ ...key, mode: "force-rebaseline" },
				{ context },
			),
		).toEqual({
			success: false,
			error: row.absent ? "device_absent" : "read_failed",
		});
		expect(await call(decommissionMutationProcedure, key, { context })).toEqual(
			row.absent
				? { success: true, state: "decommissioned" }
				: { success: false, error: "read_failed" },
		);
		expect(await unit.start()).toMatchObject(
			row.absent
				? { result: "started" }
				: { result: "failed", failure: { class: "mutation_blocked" } },
		);
		expect(unit.requests).not.toHaveBeenCalled();
		expect(unit.posts).not.toHaveBeenCalled();
	});
}

for (const [family, stableKey, devpath] of [
	[
		"native PCIe",
		nativePciKey,
		"/devices/platform/fd500000.pcie/pci10000:e1/10000:e1:00.0",
	],
	["opaque SoC", nativeSocKey, "/devices/platform/modem/wwan0"],
] as const) {
	for (const isPresent of [true, false]) {
		test(`Keep and Gone agree on ${family}: ${isPresent ? "present" : "removed"}`, async () => {
			const unit = await recovery({ witness: "legacy" });
			unit.absent();
			const entry = await readMutationEntry(KEY);
			if (!entry) throw new Error("missing fixture entry");
			await removeMutationEntry(KEY);
			await commitMutationEntry({ ...entry, stableKey, kind: "modem-config" });
			await refreshMutationBlocks();
			spyOn(modemPciSysfs, "addresses").mockReturnValue(
				isPresent ? ["10000:e1:00.0"] : [],
			);
			if (isPresent)
				unit.readDb.mockResolvedValue(
					`P: ${devpath}\nE: ID_PATH=${stableKey}\n`,
				);
			const ack = (mode: "force-rebaseline" | "verified-rollback") =>
				call(
					acknowledgeMutationProcedure,
					{ stableKey, mode, confirm: true },
					{ context: makeRpcContext() },
				);
			const gone = () =>
				call(
					decommissionMutationProcedure,
					{ stableKey, confirm: true },
					{ context: makeRpcContext() },
				);
			expect((await listBlocks()).blocks).toMatchObject([
				{ stableKey, devicePresent: isPresent, checkable: false },
			]);
			expect(await ack("verified-rollback")).toEqual({
				success: false,
				error: isPresent ? "state_mismatch" : "device_absent",
			});
			if (isPresent) {
				expect(await gone()).toEqual({
					success: false,
					error: "state_mismatch",
				});
				// Also keep a previously quarantined native row without rebooting.
				const current = await readMutationEntry(stableKey);
				if (!current) throw new Error("missing native row");
				await commitMutationEntry({
					...current,
					state: "device-absent-quarantine",
				});
				expect(await ack("force-rebaseline")).toEqual({
					success: true,
					state: "acknowledged",
				});
				expect(await readMutationEntry(stableKey)).toBeUndefined();
			} else {
				expect(await ack("force-rebaseline")).toEqual({
					success: false,
					error: "device_absent",
				});
				expect(await gone()).toEqual({
					success: true,
					state: "decommissioned",
				});
				expect(await tryAcquireModemMutation(stableKey)).toMatchObject({
					refusal: "device_decommissioned",
				});
			}
			expect(await unit.start()).toMatchObject({ result: "started" });
			expect(unit.requests).not.toHaveBeenCalled();
			expect(unit.posts).not.toHaveBeenCalled();
		});
	}
}

test("hotplug after the last Gone observation is noticed by existing startup replay", async () => {
	const unit = await recovery({ witness: "legacy" });
	unit.absent();
	expect(await acknowledge("force-rebaseline")).toEqual({
		success: false,
		error: "device_absent",
	});
	const rename = defaultMutationJournalFs.rename;
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			rename: async (from, to) => {
				unit.replace();
				await rename(from, to);
			},
		},
	});
	expect(await decommission()).toEqual({
		success: true,
		state: "decommissioned",
	});
	expect(await tryAcquireModemMutation(KEY)).toMatchObject({
		refusal: "device_decommissioned",
	});
	setMutationJournalDeps({ dir: harness.root() });
	await initMutationRecovery();
	expect((await readMutationEntry(KEY))?.state).toBe("recommission-pending");
	expect(await tryAcquireModemMutation(KEY)).toMatchObject({
		refusal: "rebaseline_required",
	});
	expect(await unit.start()).toMatchObject({ result: "started" });
});

for (const mode of ["force-rebaseline", "decommission"] as const) {
	test(`${mode} leaves newer subnet authority alone when capture is held`, async () => {
		const unit = await recovery({ witness: "legacy" });
		if (mode === "decommission") {
			unit.absent();
			expect(await acknowledge("force-rebaseline")).toMatchObject({
				error: "device_absent",
			});
		}
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		unit.readDb.mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return mode === "force-rebaseline" ? ROUTER_UDEV : NO_ROUTER_UDEV;
		});
		const action =
			mode === "force-rebaseline" ? acknowledge(mode) : decommission();
		try {
			expect(
				await Promise.race([
					entered.promise.then(() => true),
					action.then(() => false),
				]),
			).toBe(true);
			const entry = await readMutationEntry(KEY);
			if (entry === undefined) throw new Error("missing fixture entry");
			await commitMutationEntry({ ...entry, attemptId: "newer-authority" });
		} finally {
			release.resolve();
		}
		expect(await action).toEqual({ success: false, error: "not_blocked" });
		expect(await readMutationEntry(KEY)).toMatchObject({
			attemptId: "newer-authority",
		});
	});
}

test("two decommission clients cannot declare the same absent subnet slot twice", async () => {
	const unit = await recovery({ witness: "legacy" });
	unit.absent();
	expect(await acknowledge("force-rebaseline")).toMatchObject({
		error: "device_absent",
	});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	unit.readDb.mockImplementation(async () => {
		entered.resolve();
		await release.promise;
		return NO_ROUTER_UDEV;
	});
	const first = decommission();
	await entered.promise;
	const second = decommission();
	release.resolve();
	expect(await first).toEqual({ success: true, state: "decommissioned" });
	expect(await second).toEqual({ success: false, error: "not_blocked" });
	expect((await readMutationEntry(KEY))?.state).toBe("decommissioned");
});
