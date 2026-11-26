import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { call } from "@orpc/server";
import * as runner from "../helpers/run.ts";
import * as roster from "../modules/modems/modem-wire-producer.ts";
import * as identity from "../modules/modems/mutation-identity.ts";
import {
	commitMutationEntry,
	defaultMutationJournalFs,
	readMutationEntry,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import {
	mutationSlotName,
	parseMutationJournalEntry,
} from "../modules/modems/mutation-journal-parse.ts";
import * as lease from "../modules/modems/mutation-lease.ts";
import {
	initMutationRecovery,
	runMutationReplay,
} from "../modules/modems/mutation-replay.ts";
import {
	registerMutationRollback,
	setMutationCaptureDeps,
} from "../modules/modems/mutation-rollback.ts";
import { hilinkDhcpSettingsBody } from "../modules/network/hilink-documents.ts";
import {
	HILINK_CONNECTION_PATH,
	HILINK_NET_MODE_LIST_PATH,
	HILINK_NET_MODE_PATH,
	HILINK_SESSION_PATH,
} from "../modules/network/hilink-session.ts";
import {
	netdevPresence,
	noteNetdevWitness,
	readNetdevWitness,
} from "../modules/network/netdev-lifetime.ts";
import * as network from "../modules/network/network-interfaces.ts";
import {
	handleNetifMonitorEvent,
	resetNetifSnapshotForTest,
	updateNetif,
} from "../modules/network/network-interfaces.ts";
import { defaultRouterAdminProbeDeps } from "../modules/network/router-cellular-admin.ts";
import * as scan from "../modules/network/router-cellular-scan.ts";
import * as subnet from "../modules/network/router-subnet-hygiene.ts";
import { defaultSubnetRewriteDeps } from "../modules/network/router-subnet-hygiene.ts";
import {
	type HilinkDhcpRecord,
	parseHilinkDhcpSettings,
} from "../modules/network/router-subnet-plan.ts";
import {
	planFromPreState,
	preStateFor,
	routerSubnetRollback,
} from "../modules/network/router-subnet-rollback.ts";
import * as boot from "../modules/streaming/armed-stream-marker.ts";
import { readSystemBootId } from "../modules/streaming/armed-stream-marker.ts";
import { awaitRecoveryBarrier } from "../modules/streaming/recovery-barrier.ts";
import { stopWifiUpdateLoopForTest } from "../modules/wifi/wifi-interfaces.ts";
import {
	setRouterControlProcedure,
	setRouterNetModeProcedure,
	setRouterSubnetProcedure,
} from "../rpc/procedures/modems-router.procedure.ts";
import {
	firstSightIfconfig,
	firstSightScan,
} from "./helpers/bond-first-sight-fixture.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";
import { JournalRetryClock } from "./helpers/journal-reconciliation-harness.ts";
import {
	replayHardware,
	useReplayHarness,
} from "./helpers/journal-replay-harness.ts";

const KEY = "usb:a";
const IFNAME = "enx0c5b8f279a64";
const CURRENT: HilinkDhcpRecord = {
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
const TARGET: HilinkDhcpRecord = {
	...CURRENT,
	address: "192.168.9.1",
	startAddress: "192.168.9.100",
	endAddress: "192.168.9.200",
	primaryDns: "192.168.9.1",
};
const harness = useReplayHarness();
beforeEach(() =>
	registerMutationRollback("router-subnet", routerSubnetRollback),
);
afterEach(() => {
	stopWifiUpdateLoopForTest();
	jest.restoreAllMocks();
	resetNetifSnapshotForTest();
	scan.resetUsbNetMarkers();
});

async function scenario(
	options: {
		readonly state?: "armed" | "executing";
		readonly change?:
			| "absent"
			| "unreadable"
			| "index only"
			| "replaced"
			| "renamed"
			| "reboot"
			| "legacy";
		readonly swapAt?: "write session" | "disconnect" | "rollback reply";
		readonly order?: "address only" | "monitor first" | "poll first";
		readonly crash?: boolean;
		readonly live?: boolean;
	} = {},
) {
	const boot = readSystemBootId();
	if (!boot) throw new Error("fixture needs a kernel boot id");
	const a = fs.statSync(import.meta.dir, { bigint: true });
	const b = fs.statSync(import.meta.path, { bigint: true });
	const rawStat = fs.statSync;
	const name = options.change === "renamed" ? "enx0c5b8f279a65" : IFNAME;
	let node =
		options.change === "replaced" || options.change === "reboot" ? b : a;
	let index = node === a ? 7 : 17;
	let plugged = options.change !== "absent";
	let running = true;
	let addressed = true;
	let record = options.state === "armed" || options.live ? CURRENT : TARGET;
	const calls: string[] = [];
	const commands: string[][] = [];
	const replace = () => {
		node = b;
		index = 17;
	};
	const unplug = () => {
		plugged = false;
	};
	spyOn(fs, "statSync").mockImplementation((path, opts?) => {
		if (!String(path).startsWith("/sys/class/net/"))
			return Reflect.apply(rawStat, fs, [path, opts]);
		if (String(path) !== `/sys/class/net/${name}` || !plugged) {
			return Reflect.apply(rawStat, fs, [`${harness.root()}/absent`, opts]);
		}
		if (options.change === "unreadable" || options.change === "index only")
			throw Object.assign(new Error("unreadable"), { code: "EIO" });
		return Reflect.apply(rawStat, fs, [
			node === a ? import.meta.dir : import.meta.path,
			opts,
		]);
	});
	spyOn(netdevPresence, "ifindex").mockImplementation((ifname) =>
		ifname === name && options.change !== "unreadable" && plugged
			? index
			: undefined,
	);
	const readDir = fs.readdirSync;
	spyOn(fs, "readdirSync").mockImplementation((path, opts?) =>
		Reflect.apply(
			String(path) === "/sys/class/net" ? () => [name] : readDir,
			fs,
			[path, opts],
		),
	);
	if (options.change === "absent") {
		setMutationCaptureDeps({ enumerate: async () => [] });
	} else {
		setMutationCaptureDeps({
			enumerate: async () => [{ ...replayHardware(KEY), ifname: name }],
		});
	}
	const render = () => {
		const up = firstSightIfconfig(name, record.startAddress);
		const body = addressed
			? up
			: up
					.split("\n")
					.filter((line) => !line.includes("inet "))
					.join("\n");
		return running ? body : body.replace(",RUNNING", "");
	};
	const event = (state: string) =>
		handleNetifMonitorEvent({ type: "device-state", device: name, state });
	await firstSightScan(render(), {
		blocked: [],
		buses: { [name]: "usb" },
	}).settle();
	let targetSessions = 0;
	spyOn(defaultSubnetRewriteDeps, "fetchViaInterface").mockImplementation(
		async (ifname, urls) =>
			urls.map((url) => {
				calls.push(`GET ${ifname} ${index}`);
				if (new URL(url).hostname !== record.address) return "";
				if (url.endsWith(HILINK_SESSION_PATH)) {
					if (
						record === TARGET &&
						++targetSessions === 2 &&
						options.swapAt === "write session"
					)
						replace();
					return "<response><SesInfo>cookie</SesInfo><TokInfo>token</TokInfo></response>";
				}
				const body = hilinkDhcpSettingsBody(record)
					.replace("<request>", "<response>")
					.replace("</request>", "</response>");
				if (
					record.address === CURRENT.address &&
					options.swapAt === "rollback reply"
				)
					replace();
				return body;
			}),
	);
	spyOn(defaultSubnetRewriteDeps, "postViaInterface").mockImplementation(
		async (ifname, _url, body) => {
			calls.push(`POST ${ifname} ${index}`);
			record =
				parseHilinkDhcpSettings(
					body
						.replace("<request>", "<response>")
						.replace("</request>", "</response>"),
				) ?? record;
			return "";
		},
	);
	spyOn(runner, "run").mockImplementation(async (bin, argv) => {
		if (bin === "ifconfig") return render();
		if (bin !== "nmcli") return "";
		commands.push([...argv, String(index)]);
		if (argv[1] === "disconnect") {
			if (options.swapAt === "disconnect") replace();
			addressed = false;
			if (options.order) await updateNetif();
			if (options.order && options.order !== "address only") {
				running = false;
				if (options.order === "monitor first") event("disconnected");
				await updateNetif();
				if (options.order === "poll first") event("disconnected");
			}
		} else {
			addressed = true;
			running = true;
			if (options.order && options.order !== "address only") event("connected");
			if (options.order) await updateNetif();
		}
		return "";
	});
	if (options.order) await updateNetif();
	const state = options.state ?? "executing";
	const plan = {
		ifname: IFNAME,
		adminUrl: `http://${CURRENT.address}`,
		current: CURRENT,
		target: TARGET,
	};
	const netdev = {
		bootId:
			options.change === "reboot"
				? "00000000-0000-4000-8000-000000000001"
				: boot,
		ifindex: 7,
		node: `${a.dev}:${a.ino}`,
	};
	if (options.live) {
		noteNetdevWitness(name, { ifindex: 7, node: netdev.node, present: true });
		spyOn(roster, "routerCellularIfnameForWireId").mockReturnValue(name);
		spyOn(scan, "getRouterCellularMarker").mockReturnValue({
			vendor: "Huawei",
			model: "HiLink",
			vid_pid: "12d1:14dc",
			kind: "router-cellular",
			duplicate_model: false,
		});
		spyOn(identity, "modemStableKeyForIfname").mockReturnValue(KEY);
		spyOn(defaultSubnetRewriteDeps, "isRealDevice").mockResolvedValue(true);
		spyOn(defaultSubnetRewriteDeps, "runIpRouteShowDefault").mockResolvedValue(
			`default via ${CURRENT.address} dev ${name}`,
		);
		spyOn(defaultSubnetRewriteDeps, "runIpAddrShow").mockResolvedValue("");
		return {
			name,
			calls,
			commands,
			record: () => record,
			netdev,
			replace,
			unplug,
		};
	}
	if (options.crash) {
		const child = Bun.spawn({
			cmd: [
				process.execPath,
				new URL("./helpers/router-subnet-crash-child.ts", import.meta.url)
					.pathname,
				harness.root(),
				state,
				JSON.stringify({ plan, netdev }),
			],
			stdout: "ignore",
			stderr: "pipe",
			timeout: 3000,
		});
		const [exit, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
		]);
		if (child.signalCode !== "SIGKILL" || exit === 0)
			throw new Error(`child did not crash at ${state}: ${stderr}`);
		return {
			name,
			calls,
			commands,
			record: () => record,
			netdev,
			replace,
			unplug,
		};
	}
	await commitMutationEntry({
		version: 1,
		stableKey: KEY,
		kind: "router-subnet",
		state,
		attemptId: "interrupted",
		startedAt: 1,
		updatedAt: 1,
		preState: {
			...preStateFor(plan),
			...(options.change === "legacy" ? {} : { netdev }),
		},
		history:
			state === "armed"
				? [{ state, at: 1 }]
				: [
						{ state: "armed", at: 1 },
						{ state, at: 1 },
					],
	});
	return {
		name,
		calls,
		commands,
		record: () => record,
		netdev,
		replace,
		unplug,
	};
}

for (const path of ["control", "mode"] as const) {
	test(`the ${path} RPC cannot issue proof for a successor at lease admission`, async () => {
		const unit = await scenario({ live: true });
		const admit = lease.withModemMutation;
		spyOn(lease, "withModemMutation").mockImplementation(async (key, work) => {
			unit.replace();
			// The successor has already been observed before the callback runs.
			noteNetdevWitness(IFNAME, readNetdevWitness(IFNAME));
			return admit(key, work);
		});
		spyOn(defaultRouterAdminProbeDeps, "isRealDevice").mockResolvedValue(true);
		spyOn(
			defaultRouterAdminProbeDeps,
			"runIpRouteShowDefault",
		).mockResolvedValue(`default via ${CURRENT.address} dev ${IFNAME}`);
		const transport = spyOn(
			defaultRouterAdminProbeDeps,
			"fetchViaInterface",
		).mockResolvedValue([]);
		const context = { context: makeRpcContext() };
		const result =
			path === "control"
				? await call(
						setRouterControlProcedure,
						{ device: "42", control: "mobile_data", value: false },
						context,
					)
				: await call(
						setRouterNetModeProcedure,
						{ device: "42", mode: "03" },
						context,
					);
		expect(result).toEqual({ success: false, error: "unreachable" });
		expect(transport).not.toHaveBeenCalled();
	});
}

test("a subnet plan is refused if host subnet inspection outlives the issuing netdev", async () => {
	const unit = await scenario({ live: true });
	const admission = spyOn(lease, "withJournaledModemMutation");
	spyOn(defaultSubnetRewriteDeps, "runIpAddrShow").mockImplementation(
		async () => {
			unit.replace();
			return "";
		},
	);
	const result = await call(
		setRouterSubnetProcedure,
		{ device: "42", address: TARGET.address, confirm: true },
		{ context: makeRpcContext() },
	);
	expect(result).toEqual({ status: "refused", error: "unreachable" });
	expect(admission).not.toHaveBeenCalled();
	expect(await readMutationEntry(KEY)).toBeUndefined();
	expect(unit.calls.filter((effect) => effect.startsWith("POST"))).toEqual([]);
});

const settings = [
	{
		name: "mobile data",
		reading: { controls: { mobile_data: true, roaming_autoconnect: true } },
		write: () =>
			call(
				setRouterControlProcedure,
				{ device: "42", control: "mobile_data", value: true },
				{ context: makeRpcContext() },
			),
	},
	{
		name: "Connect while roaming",
		reading: { controls: { mobile_data: true, roaming_autoconnect: true } },
		write: () =>
			call(
				setRouterControlProcedure,
				{ device: "42", control: "roaming_autoconnect", value: true },
				{ context: makeRpcContext() },
			),
	},
	{
		name: "radio mode",
		reading: {
			capabilities: {
				net_mode: {
					state: "reported",
					modes: [{ id: "00" }, { id: "03" }],
					current: "03",
				},
			},
		},
		write: () =>
			call(
				setRouterNetModeProcedure,
				{ device: "42", mode: "03" },
				{ context: makeRpcContext() },
			),
	},
] as const;

async function settingWrite(onSession: () => void = () => {}) {
	const unit = await scenario({ live: true });
	spyOn(defaultRouterAdminProbeDeps, "isRealDevice").mockResolvedValue(true);
	spyOn(defaultRouterAdminProbeDeps, "runIpRouteShowDefault").mockResolvedValue(
		`default via ${CURRENT.address} dev ${IFNAME}`,
	);
	spyOn(defaultRouterAdminProbeDeps, "fetchViaInterface").mockImplementation(
		async (_name, urls) =>
			urls.map((url) => {
				if (url.endsWith(HILINK_SESSION_PATH)) {
					onSession();
					return "<response><SesInfo>cookie</SesInfo><TokInfo>token</TokInfo></response>";
				}
				if (url.endsWith(HILINK_NET_MODE_LIST_PATH))
					return "<response><NetworkModeList><NetworkMode><Index>00</Index></NetworkMode><NetworkMode><Index>03</Index></NetworkMode></NetworkModeList></response>";
				if (url.endsWith(HILINK_NET_MODE_PATH))
					return "<response><NetworkMode>03</NetworkMode></response>";
				return url.endsWith(HILINK_CONNECTION_PATH)
					? "<response><RoamAutoConnectEnable>1</RoamAutoConnectEnable></response>"
					: "<response><dataswitch>1</dataswitch></response>";
			}),
	);
	const post = spyOn(
		defaultRouterAdminProbeDeps,
		"postViaInterface",
	).mockResolvedValue("");
	return { unit, post };
}

for (const setting of settings) {
	test(`${setting.name} reports its reading while the dongle stays`, async () => {
		const { post } = await settingWrite();
		const refresh = spyOn(
			network,
			"refreshRouterAdminState",
		).mockResolvedValue();
		expect(await setting.write()).toEqual({
			success: true,
			...setting.reading,
		});
		expect(post).toHaveBeenCalledTimes(1);
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	for (const leave of ["unplug", "replace"] as const) {
		// The setting was read back, so a refusal would deny a change that landed.
		test(`${setting.name} is not denied after ${leave} during refresh`, async () => {
			const { unit, post } = await settingWrite();
			spyOn(network, "refreshRouterAdminState").mockImplementation(async () =>
				unit[leave](),
			);
			expect(await setting.write()).toEqual({ success: true });
			expect(post).toHaveBeenCalledTimes(1);
		});

		test(`${setting.name} is refused when ${leave} precedes the write`, async () => {
			const unit = { leave: () => {} };
			const { unit: live, post } = await settingWrite(() => unit.leave());
			unit.leave = live[leave];
			const refresh = spyOn(network, "refreshRouterAdminState");
			expect(await setting.write()).toEqual({
				success: false,
				error: "unreachable",
			});
			expect(post).not.toHaveBeenCalled();
			expect(refresh).not.toHaveBeenCalled();
		});
	}
}

test("the live RPC keeps the original witness and the failed journal after losing proof", async () => {
	const unit = await scenario({ live: true, swapAt: "disconnect" });
	const result = await call(
		setRouterSubnetProcedure,
		{ device: "42", address: TARGET.address, confirm: true },
		{ context: makeRpcContext() },
	);
	expect(result.status).toBe("blocked");
	expect(result).toMatchObject({
		detail:
			"The original dongle could no longer be verified. The LAN change is unconfirmed.",
	});
	expect(unit.record()).toEqual(TARGET);
	expect(unit.commands).toEqual([["device", "disconnect", IFNAME, "7"]]);
	expect(await readMutationEntry(KEY)).toMatchObject({
		state: "failed",
		detail:
			"The original dongle could no longer be verified. The LAN change is unconfirmed.",
		preState: { netdev: unit.netdev },
	});
	expect((await runMutationReplay()).blocked).toBe(1);
	expect(unit.calls.filter((effect) => effect.startsWith("POST"))).toEqual([
		`POST ${IFNAME} 7`,
	]);
});

test("the live journal decision cannot retire a matching reply from a lost netdev", async () => {
	const unit = await scenario({ live: true });
	const execute = subnet.executeSubnetRewrite;
	spyOn(subnet, "executeSubnetRewrite").mockImplementation(async (...args) => {
		const result = await execute(...args);
		expect(result.status).toBe("applied");
		unit.replace();
		return result;
	});
	const result = await call(
		setRouterSubnetProcedure,
		{ device: "42", address: TARGET.address, confirm: true },
		{ context: makeRpcContext() },
	);
	expect(result.status).toBe("blocked");
	expect((await readMutationEntry(KEY))?.state).toBe("failed");
});

test("a rejecting subnet POST after netdev loss reports continuity loss without recovery I/O", async () => {
	const unit = await scenario({ live: true });
	const post = spyOn(
		defaultSubnetRewriteDeps,
		"postViaInterface",
	).mockImplementation(async () => {
		unit.replace();
		throw new Error("transport lost while posting");
	});
	const result = await call(
		setRouterSubnetProcedure,
		{ device: "42", address: TARGET.address, confirm: true },
		{ context: makeRpcContext() },
	);
	expect(result).toEqual({
		status: "blocked",
		detail:
			"The original dongle could no longer be verified. The LAN change is unconfirmed.",
	});
	expect(post).toHaveBeenCalledTimes(1);
	expect(unit.commands).toEqual([]);
	expect((await readMutationEntry(KEY))?.state).toBe("failed");
});

test("the replay decision cannot archive a restored reply from a lost netdev", async () => {
	const unit = await scenario();
	const restore = subnet.restoreSubnet;
	spyOn(subnet, "restoreSubnet").mockImplementation(async (...args) => {
		const restored = await restore(...args);
		expect(restored).toBe(true);
		unit.replace();
		return restored;
	});
	expect((await runMutationReplay()).blocked).toBe(1);
	expect((await readMutationEntry(KEY))?.state).toBe("failed");
	expect(unit.record()).toEqual(CURRENT);
});

test("the applied subnet RPC waits for router state refresh", async () => {
	await scenario({ live: true });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	spyOn(network, "refreshRouterAdminState").mockImplementation(async () => {
		entered.resolve();
		await release.promise;
	});
	const result = call(
		setRouterSubnetProcedure,
		{ device: "42", address: TARGET.address, confirm: true },
		{ context: makeRpcContext() },
	);
	try {
		await entered.promise;
		expect(
			await Promise.race([
				result.then(() => "replied"),
				new Promise((resolve) => setImmediate(() => resolve("waiting"))),
			]),
		).toBe("waiting");
	} finally {
		release.resolve();
	}
	expect(await result).toEqual({ status: "applied" });
});

for (const order of ["address only", "monitor first", "poll first"] as const) {
	test(`the live RPC confirms the original netdev after renewal: ${order}`, async () => {
		const unit = await scenario({ live: true, order });
		const result = await call(
			setRouterSubnetProcedure,
			{ device: "42", address: TARGET.address, confirm: true },
			{ context: makeRpcContext() },
		);
		expect(result).toEqual({ status: "applied" });
		expect(unit.record()).toEqual(TARGET);
		expect(unit.commands).toEqual([
			["device", "disconnect", IFNAME, "7"],
			["device", "connect", IFNAME, "7"],
		]);
		expect(await readMutationEntry(KEY)).toBeUndefined();
	});
}

for (const state of ["armed", "executing"] as const) {
	test(`a process killed at ${state} leaves a compatible slot and does not roll back a successor`, async () => {
		const unit = await scenario({ state, change: "replaced", crash: true });
		const slot = `${mutationSlotName(KEY)}.json`;
		const raw = await Bun.file(join(harness.root(), slot)).text();
		const parsed = parseMutationJournalEntry(raw, slot);
		expect(parsed?.state).toBe(state);
		expect(planFromPreState(parsed?.preState ?? {})).toEqual({
			ifname: IFNAME,
			adminUrl: `http://${CURRENT.address}`,
			current: CURRENT,
			target: TARGET,
		});
		expect((await runMutationReplay()).blocked).toBe(1);
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
		expect(unit.calls).toEqual([]);
		expect(unit.commands).toEqual([]);
	});
}

test("the slot parser and rollback plan reader accept the additive witness", async () => {
	const unit = await scenario({ crash: true });
	const slot = `${mutationSlotName(KEY)}.json`;
	const raw = await Bun.file(join(harness.root(), slot)).text();
	const parsed = parseMutationJournalEntry(raw, slot);
	expect(parsed?.preState.netdev).toEqual(unit.netdev);
	expect(planFromPreState(parsed?.preState ?? {})).toEqual({
		ifname: IFNAME,
		adminUrl: `http://${CURRENT.address}`,
		current: CURRENT,
		target: TARGET,
	});
});

for (const change of [
	"replaced",
	"absent",
	"unreadable",
	"index only",
] as const) {
	for (const state of ["armed", "executing"] as const) {
		test(`same boot ${state} journal blocks a ${change} netdev without dispatch`, async () => {
			const unit = await scenario({ change, state });
			const summary = await runMutationReplay();
			expect(unit.calls).toEqual([]);
			expect(unit.commands).toEqual([]);
			expect(summary).toMatchObject({ rolledBack: 0, blocked: 1 });
			expect((await readMutationEntry(KEY))?.state).toBe("failed");
		}, 1000);
	}
}

for (const order of ["address only", "monitor first", "poll first"] as const) {
	test(`same-boot replay restores through renewal: ${order}`, async () => {
		const unit = await scenario({ order });
		expect((await runMutationReplay()).rolledBack).toBe(1);
		expect(await readMutationEntry(KEY)).toBeUndefined();
		expect(unit.record()).toEqual(CURRENT);
		expect(unit.commands).toEqual([
			["device", "disconnect", IFNAME, "7"],
			["device", "connect", IFNAME, "7"],
		]);
	});
}

for (const change of ["renamed", "reboot"] as const) {
	test(`replay targets the expected device: ${change}`, async () => {
		const unit = await scenario({ change });
		expect((await runMutationReplay()).rolledBack).toBe(1);
		expect(unit.record()).toEqual(CURRENT);
		expect(unit.calls.filter((call) => call.startsWith("POST"))).toEqual([
			`POST ${unit.name} ${change === "reboot" ? 17 : 7}`,
		]);
	});
}

for (const state of ["armed", "executing"] as const) {
	test(`replay refuses a ${state} entry with no boot provenance`, async () => {
		const unit = await scenario({ change: "legacy", state });
		expect(await runMutationReplay()).toMatchObject({
			rolledBack: 0,
			blocked: 1,
		});
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
		expect(unit.calls).toEqual([]);
		expect(unit.commands).toEqual([]);
	});
}

for (const value of [undefined, "not-a-kernel-boot-id"]) {
	test(`replay cannot infer a different boot from ${value ?? "unreadable boot ID"}`, async () => {
		const unit = await scenario();
		spyOn(boot, "readSystemBootId").mockReturnValue(value);
		expect(await runMutationReplay()).toMatchObject({
			rolledBack: 0,
			blocked: 1,
		});
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
		expect(unit.calls).toEqual([]);
		expect(unit.commands).toEqual([]);
	});
}

for (const swapAt of [
	"write session",
	"disconnect",
	"rollback reply",
] as const) {
	test(`replay blocks when proof is lost during ${swapAt}`, async () => {
		const unit = await scenario({ swapAt });
		const summary = await runMutationReplay();
		expect(unit.calls.some((call) => call.endsWith(" 17"))).toBe(false);
		expect(unit.commands.some((command) => command.at(-1) === "17")).toBe(
			false,
		);
		expect(summary).toMatchObject({ rolledBack: 0, blocked: 1 });
		expect((await readMutationEntry(KEY))?.state).toBe("failed");
	});
}

test("recovery-owner replay retry blocks the successor and does not retry the failed entry", async () => {
	const unit = await scenario({ change: "replaced" });
	const clock = new JournalRetryClock();
	let fault = true;
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			readText: async (path) => {
				if (fault)
					throw Object.assign(new Error("unreadable journal"), { code: "EIO" });
				return defaultMutationJournalFs.readText(path);
			},
		},
	});
	expect(
		(await initMutationRecovery({ sleep: clock.sleep })).unreadable,
	).toBeGreaterThan(0);
	expect(unit.calls).toEqual([]);
	const done = awaitRecoveryBarrier();
	fault = false;
	clock.advance();
	await Promise.race([done, clock.at(2)]);
	expect((await readMutationEntry(KEY))?.state).toBe("failed");
	expect((await runMutationReplay()).blocked).toBe(1);
	expect(unit.calls).toEqual([]);
	expect(unit.commands).toEqual([]);
});
