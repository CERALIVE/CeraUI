import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as runner from "../helpers/run.ts";
import { resetGsmAutoconfigProbe } from "../modules/modems/gsm-autoconfig.ts";
import { resetGsmConnections } from "../modules/modems/gsm-connections.ts";
import { setModemReadyActivationDepsForTest } from "../modules/modems/modem-ready-activation.ts";
import {
	refreshModemStatus,
	registerModemSafe,
	resolveLateModemConfig,
} from "../modules/modems/modem-registration.ts";
import {
	discoverModems,
	initModemUpdateLoop,
	runModemStatusPoll,
	setModemPresenceDepsForTest,
	stopModemUpdateLoop,
	whenModemUpdatesSettled,
} from "../modules/modems/modem-update-loop.ts";
import {
	refreshModemIdPaths,
	resetModemWireProducer,
	setModemIdPathReader,
} from "../modules/modems/modem-wire-producer.ts";
import {
	getModem,
	getModemIds,
	type Modem,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";
import { refreshMutationBlocks } from "../modules/modems/mutation-blocks.ts";
import {
	defaultMutationJournalFs,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { settlePendingMutationRemovals } from "../modules/modems/mutation-journal-retirement.ts";
import { beginModemMutation } from "../modules/modems/mutation-lease.ts";
import { setModemsState } from "../modules/modems/state/modems-state-cache.ts";
import { withModemUpdateLock } from "../modules/network/state/device-lock.ts";
import {
	isModemMutationHeld,
	resetLifecycleInterlock,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	completeRecoveryBarrier,
	isRecoveryPending,
	resetRecoveryBarrier,
} from "../modules/streaming/recovery-barrier.ts";
import { assertNmDeviceShowFields } from "./helpers/nm-device-show-fixture.ts";

const UUID = "d848da09-f700-4530-b888-be8b99ec8c85";
const KEY = "platform-xhci-hcd.0.auto-usb-0:1.4.1";
const DEVICE_ID = "synthetic-mbim-device";
const SIM_ID = "89000000000000000001";
let dir: string;
let now = 0;
let roster: number[];
let nmState: string;
let mmState: string;
let autoconnect: string;
let simReadable: boolean;
let existingProfile: boolean;
let activationFails: boolean;
let realRegistration: boolean;
let profileAddFails: boolean;
let simReadFails: boolean;
let profileReadFails: boolean;
let profileFieldsFailure: "none" | "unreadable" | "incomplete";
let commands: string[][];
let unexpected: string[];
let onStateRead: (() => Promise<void>) | undefined;
let onConnect: (() => Promise<void>) | undefined;
let onModemRead: (() => Promise<void>) | undefined;

function modem(): Modem {
	return {
		ifname: "wwan0",
		name: "MBIM modem",
		sim_network: "Test",
		network_type: { supported: {}, active: null },
		config: {
			conn: UUID,
			autoconfig: false,
			apn: "internet",
			username: "",
			password: "",
			roaming: false,
			network: "",
		},
	};
}

function activations(): string[][] {
	return commands.filter(
		([binary, ...args]) => binary === "nmcli" && args.includes("up"),
	);
}

function profileWrites(): string[][] {
	return commands.filter(
		([binary, ...args]) =>
			binary === "nmcli" &&
			args.some((arg) => ["add", "modify", "del"].includes(arg)),
	);
}

function holdLease(): { release(): void } {
	const acquired = beginModemMutation(KEY);
	if (!acquired.ok) throw new Error(`Lease refused: ${acquired.refusal}`);
	return acquired.lease;
}

beforeEach(async () => {
	now = 0;
	roster = [2];
	nmState = "30 (disconnected)";
	mmState = "registered";
	autoconnect = "yes";
	simReadable = true;
	existingProfile = true;
	activationFails = false;
	realRegistration = false;
	profileAddFails = false;
	simReadFails = false;
	profileReadFails = false;
	profileFieldsFailure = "none";
	commands = [];
	unexpected = [];
	onStateRead = undefined;
	onConnect = undefined;
	onModemRead = undefined;
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	resetGsmConnections();
	resetGsmAutoconfigProbe();
	setModemReadyActivationDepsForTest({ now: () => now });
	dir = await mkdtemp(join(tmpdir(), "modem-ready-"));
	setMutationJournalDeps({ dir });
	for (const id of getModemIds()) removeModem(id);
	setModemsState({});
	setModemIdPathReader(async () => new Map([["wwan0", KEY]]));
	setModemPresenceDepsForTest({
		listModems: async () => roster,
		registerModem: async (id) => {
			if (realRegistration) await registerModemSafe(id);
			else setModem(id, modem());
		},
		refreshStatus: refreshModemStatus,
		refreshIdPaths: refreshModemIdPaths,
	});
	spyOn(runner, "run").mockImplementation(async (binary, args) => {
		commands.push([binary, ...args]);
		if (binary === "mmcli") {
			if (args.includes("-i") && simReadFails)
				throw new Error("SIM read failed");
			if (args.includes("-i"))
				return `sim.properties.iccid : ${simReadable ? SIM_ID : "--"}
sim.properties.operator-name : Test`;
			await onModemRead?.();
			return `modem.generic.model : MBIM modem
modem.generic.state : ${mmState}
modem.generic.device-identifier : ${DEVICE_ID}
modem.generic.sim : /org/freedesktop/ModemManager1/SIM/1
modem.generic.ports.length : 1
modem.generic.ports.value[1] : wwan0 (net)`;
		}
		if (binary === "nmcli") {
			if (args.includes("device") && args.includes("show")) {
				const fields = args[args.indexOf("--get-values") + 1];
				if (fields === undefined) throw new Error("missing device show fields");
				assertNmDeviceShowFields(fields);
			}
			if (args.includes("DEVICE,TYPE")) return "cdc-wdm0:gsm";
			if (args.includes("GENERAL.CON-UUID")) return "";
			if (args.includes("CONNECTIONS.AVAILABLE-CONNECTIONS")) {
				expect(args.slice(0, 2)).toEqual(["--mode", "multiline"]);
				return `CONNECTIONS.AVAILABLE-CONNECTIONS[1]:${UUID} | profile-a`;
			}
			if (args.includes("GENERAL.IP-IFACE")) return "";
			if (args.includes("GENERAL.STATE")) {
				await onStateRead?.();
				return nmState;
			}
			if (args.includes("connection.autoconnect")) return autoconnect;
			if (args.includes("uuid,type,state")) {
				if (profileReadFails) throw new Error("Profile lookup failed");
				return existingProfile ? `${UUID}:gsm:` : "";
			}
			if (args.includes("add")) {
				if (profileAddFails) throw new Error("Profile creation failed");
				return `Connection 'gsm' (${UUID}) successfully added.`;
			}
			if (args.includes("gsm.auto-config")) return "no";
			if (
				args.includes(
					"gsm.device-id,gsm.sim-id,connection.autoconnect,connection.timestamp",
				)
			)
				return `${DEVICE_ID}\n${SIM_ID}\nyes\n0`;
			if (
				args.some((arg) =>
					arg.startsWith("gsm.device-id,gsm.sim-id,gsm.sim-operator-id"),
				)
			) {
				if (profileFieldsFailure === "unreadable")
					throw new Error("Profile fields unreadable");
				if (profileFieldsFailure === "incomplete")
					return `${DEVICE_ID}\n${SIM_ID}`;
				return `${DEVICE_ID}\n${SIM_ID}\n\ninternet\n\n\nyes\n\nno`;
			}
			if (args.includes("up")) {
				expect(isModemMutationHeld(KEY)).toBe(true);
				// A connection wait must never hold the global reconciliation lock.
				let entered = false;
				await withModemUpdateLock(async () => {
					entered = true;
				});
				expect(entered).toBe(true);
				await onConnect?.();
				if (activationFails) throw new Error("Connection activation failed");
				return "Connection successfully activated";
			}
		}
		const command = `${binary} ${args.join(" ")}`;
		unexpected.push(command);
		throw new Error(`Unexpected command: ${command}`);
	});
});

afterEach(async () => {
	stopModemUpdateLoop();
	spyOn(runner, "run").mockRestore();
	setModemPresenceDepsForTest(null);
	setModemReadyActivationDepsForTest(null);
	setModemIdPathReader(null);
	resetModemWireProducer();
	resetMutationJournalDeps();
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	resetGsmConnections();
	resetGsmAutoconfigProbe();
	for (const id of getModemIds()) removeModem(id);
	setModemsState({});
	await rm(dir, { recursive: true, force: true });
	expect(unexpected).toEqual([]);
});

test("a newly registered idle modem gets one activation after discovery", async () => {
	await discoverModems();
	expect(activations()).toEqual([]);
	await runModemStatusPoll();
	await runModemStatusPoll();
	expect(activations()).toEqual([["nmcli", "-w", "45", "conn", "up", UUID]]);
});

test("an empty active UUID reaches ready activation through the available profile", async () => {
	await runModemStatusPoll();
	expect(commands).toContainEqual([
		"nmcli",
		"--terse",
		"--escape",
		"no",
		"--get-values",
		"GENERAL.CON-UUID",
		"device",
		"show",
		"cdc-wdm0",
	]);
	expect(commands).toContainEqual([
		"nmcli",
		"--mode",
		"multiline",
		"--terse",
		"--escape",
		"no",
		"--get-values",
		"CONNECTIONS.AVAILABLE-CONNECTIONS",
		"device",
		"show",
		"cdc-wdm0",
	]);
	expect(activations()).toEqual([["nmcli", "-w", "45", "conn", "up", UUID]]);
});

test("an unavailable device stays pending until a disconnected poll", async () => {
	nmState = "20 (unavailable)";
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
	nmState = "30 (disconnected)";
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
});

test("NM success consumes intent before MM state eligibility", async () => {
	nmState = "100 (connected)";
	mmState = "searching";
	await runModemStatusPoll();
	nmState = "30 (disconnected)";
	mmState = "registered";
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
});

test("twenty registered and connecting polls never rearm a dispatched intent", async () => {
	await runModemStatusPoll();
	for (let poll = 0; poll < 20; poll++) {
		mmState = poll % 2 === 0 ? "connecting" : "registered";
		await runModemStatusPoll();
	}
	expect(activations()).toHaveLength(1);
});

test("searching then registered after 301 seconds does not rearm", async () => {
	await runModemStatusPoll();
	mmState = "searching";
	await runModemStatusPoll();
	now = 301_000;
	mmState = "registered";
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
});

test("remove and re-add with a new MM index preserves the physical cooldown", async () => {
	await runModemStatusPoll();
	roster = [];
	await runModemStatusPoll();
	now = 299_999;
	roster = [9];
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
	now = 300_000;
	await runModemStatusPoll();
	expect(activations()).toHaveLength(2);
});

for (const guard of [
	"autoconnect",
	"inhibit",
	"scanning",
	"identity",
	"lease",
] as const) {
	test(`a ${guard} refusal preserves pending intent without dispatch`, async () => {
		await discoverModems();
		const row = getModem(2);
		if (!row) throw new Error("Modem not registered");
		const lease = guard === "lease" ? holdLease() : undefined;
		if (guard === "autoconnect") autoconnect = "no";
		if (guard === "inhibit") row.inhibit = true;
		if (guard === "scanning") row.is_scanning = true;
		if (guard === "identity") {
			setModemIdPathReader(async () => new Map());
			await refreshModemIdPaths();
		}
		await runModemStatusPoll();
		expect(activations()).toEqual([]);
		lease?.release();
		autoconnect = "yes";
		const current = getModem(2);
		if (current) {
			delete current.inhibit;
			delete current.is_scanning;
		}
		setModemIdPathReader(async () => new Map([["wwan0", KEY]]));
		await refreshModemIdPaths();
		await runModemStatusPoll();
		expect(activations()).toHaveLength(1);
	});
}

test("a failed activation is consumed and never retried", async () => {
	activationFails = true;
	await runModemStatusPoll();
	now = 600_000;
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
});

test("a SIM readable after registration resolves the existing UUID without creation", async () => {
	simReadable = false;
	realRegistration = true;
	await discoverModems();
	expect(getModem(2)?.config).toBeUndefined();
	simReadable = true;
	await runModemStatusPoll();
	await runModemStatusPoll();
	expect(getModem(2)?.config?.conn).toBe(UUID);
	expect(activations()).toEqual([["nmcli", "-w", "45", "conn", "up", UUID]]);
	expect(profileWrites()).toEqual([]);
});

test("monitor event refreshes and resync discovery never dispatch", async () => {
	const monitor = new EventEmitter();
	await initModemUpdateLoop({
		monitor: Object.assign(monitor, { start() {}, stop() {} }),
		autoDiscover: false,
		autoUnlock: false,
		startPoll: false,
	});
	await discoverModems();
	monitor.emit("monitor-event", {
		type: "device-state",
		device: "wwan0",
		state: "disconnected",
	});
	await whenModemUpdatesSettled();
	await discoverModems();
	expect(activations()).toEqual([]);
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
});

test("a monitor-driven registration cannot arm activation intent", async () => {
	const monitor = new EventEmitter();
	await initModemUpdateLoop({
		monitor: Object.assign(monitor, { start() {}, stop() {} }),
		autoDiscover: false,
		autoUnlock: false,
		startPoll: false,
	});
	monitor.emit("monitor-event", { type: "modem-added", id: "2" });
	await whenModemUpdatesSettled();
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
	roster = [];
	await runModemStatusPoll();
	roster = [2];
	await runModemStatusPoll();
	expect(activations()).toHaveLength(1);
});

test("MM connected and NM connected consumes intent before a later disconnect", async () => {
	mmState = "connected";
	nmState = "100 (connected)";
	await runModemStatusPoll();
	mmState = "registered";
	nmState = "30 (disconnected)";
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
});

test("overlapping polls after a failed activation cannot dispatch again", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	activationFails = true;
	onConnect = async () => {
		started.resolve();
		await release.promise;
	};
	const first = runModemStatusPoll();
	await started.promise;
	await Promise.all([runModemStatusPoll(), runModemStatusPoll()]);
	release.resolve();
	await first;
	expect(activations()).toHaveLength(1);
});

test("late config writes stay pending under lease refusal and journal failure", async () => {
	simReadable = false;
	existingProfile = false;
	realRegistration = true;
	await discoverModems();
	simReadable = true;
	const lease = holdLease();
	await runModemStatusPoll();
	expect(profileWrites()).toEqual([]);
	expect(getModem(2)?.config).toBeUndefined();
	lease.release();
	setMutationJournalDeps({
		dir,
		fs: {
			...defaultMutationJournalFs,
			writeTemp: async () => {
				throw new Error("journal fault");
			},
		},
	});
	await runModemStatusPoll();
	expect(profileWrites()).toEqual([]);
	expect(getModem(2)?.config).toBeUndefined();
	expect(isRecoveryPending()).toBe(true);
	setMutationJournalDeps({ dir, fs: defaultMutationJournalFs });
	await settlePendingMutationRemovals();
	await refreshMutationBlocks();
	expect(completeRecoveryBarrier()).toBe(true);
	await runModemStatusPoll();
	expect(profileWrites()).toHaveLength(1);
	expect(getModem(2)?.config?.conn).toBe(UUID);
	expect(activations()).toHaveLength(1);
});

for (const state of [
	"",
	"30garbage",
	"30 (disconnected)\n100",
	"activating",
	"40 (prepare)",
	"120 (failed)",
]) {
	test(`unparsed or non-disconnected NM state ${JSON.stringify(state)} stays pending`, async () => {
		nmState = state;
		await runModemStatusPoll();
		expect(activations()).toEqual([]);
		nmState = "30 (disconnected)";
		await runModemStatusPoll();
		expect(activations()).toHaveLength(1);
	});
}

test("lease recheck refuses a changed config UUID", async () => {
	let reads = 0;
	onStateRead = async () => {
		if (++reads !== 2) return;
		const row = getModem(2);
		if (row?.config) row.config.conn = "091ca73b-9f75-42bd-a737-2c447ca44533";
	};
	await runModemStatusPoll();
	expect(activations()).toEqual([]);
});

test("late config attempts once per readable SIM edge and read failure cannot rearm it", async () => {
	simReadable = false;
	existingProfile = false;
	realRegistration = true;
	profileAddFails = true;
	await discoverModems();
	simReadable = true;
	await runModemStatusPoll();
	await runModemStatusPoll();
	expect(profileWrites()).toHaveLength(1);
	simReadFails = true;
	await runModemStatusPoll();
	simReadFails = false;
	await runModemStatusPoll();
	expect(profileWrites()).toHaveLength(1);
	simReadable = false;
	await runModemStatusPoll();
	simReadable = true;
	profileAddFails = false;
	await runModemStatusPoll();
	expect(profileWrites()).toHaveLength(2);
	expect(activations()).toHaveLength(1);
});

test("a failed late profile lookup preserves pending work until a readable poll", async () => {
	realRegistration = true;
	simReadable = false;
	await discoverModems();
	simReadable = true;
	profileReadFails = true;
	await runModemStatusPoll();
	expect(getModem(2)?.config).toBeUndefined();
	expect(profileWrites()).toEqual([]);
	expect(activations()).toEqual([]);
	profileReadFails = false;
	await runModemStatusPoll();
	expect(getModem(2)?.config?.conn).toBe(UUID);
	expect(activations()).toHaveLength(1);
});

test("an overlapping status refresh preserves late-resolved SIM configuration", async () => {
	simReadable = false;
	realRegistration = true;
	let resolvedUuid: string | undefined;
	setModemReadyActivationDepsForTest({
		now: () => now,
		resolveConfig: async (...args) => {
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let intercepted = false;
			onModemRead = async () => {
				if (intercepted) return;
				intercepted = true;
				started.resolve();
				await release.promise;
			};
			const second = runModemStatusPoll();
			await started.promise;
			try {
				const result = await resolveLateModemConfig(...args);
				resolvedUuid = getModem(2)?.config?.conn;
				return result;
			} finally {
				release.resolve();
				await second;
				onModemRead = undefined;
			}
		},
	});
	await discoverModems();
	simReadable = true;
	await runModemStatusPoll();
	const afterOverlap = getModem(2)?.config?.conn;
	for (let poll = 0; poll < 3; poll++) await runModemStatusPoll();
	expect(resolvedUuid).toBe(UUID);
	expect(afterOverlap).toBe(UUID);
	expect(getModem(2)?.config).toEqual(modem().config);
	expect(getModem(2)?.iccid).toBe(SIM_ID);
	expect(profileWrites()).toEqual([]);
	expect(activations()).toEqual([["nmcli", "-w", "45", "conn", "up", UUID]]);
});

for (const failure of ["unreadable", "incomplete"] as const) {
	test(`${failure} existing profile details keep late configuration pending without a clone`, async () => {
		simReadable = false;
		realRegistration = true;
		await discoverModems();
		simReadable = true;
		profileFieldsFailure = failure;
		await runModemStatusPoll();
		await runModemStatusPoll();
		expect(profileWrites()).toEqual([]);
		expect(getModem(2)?.config).toBeUndefined();
		expect(activations()).toEqual([]);
		profileFieldsFailure = "none";
		await runModemStatusPoll();
		expect(getModem(2)?.config?.conn).toBe(UUID);
		expect(getModem(2)?.config?.roaming).toBe(false);
		expect(profileWrites()).toEqual([]);
		expect(activations()).toEqual([["nmcli", "-w", "45", "conn", "up", UUID]]);
	});
}

test("consumption precedes connection await when the physical key changes in flight", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let connects = 0;
	onConnect = async () => {
		if (++connects !== 1) return;
		started.resolve();
		await release.promise;
	};
	const first = runModemStatusPoll();
	await started.promise;
	try {
		setModemIdPathReader(
			async () => new Map([["wwan0", `${KEY}-replacement`]]),
		);
		await refreshModemIdPaths();
		await runModemStatusPoll();
	} finally {
		release.resolve();
		await first;
	}
	expect(activations()).toEqual([["nmcli", "-w", "45", "conn", "up", UUID]]);
});
