import { beforeEach, describe, expect, test } from "bun:test";
import {
	createRecoveryProbes,
	type RecoveryProbeIo,
} from "../modules/system/update-orchestrator/recovery-probes.ts";
import { recoverCrossSlot } from "../modules/system/update-orchestrator/recovery.ts";
import { createRecoveryFixture } from "./update-cross-slot-fixture.ts";

describe("the shipped local probe boundary", () => {
	const properties =
		"LoadState=masked\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\nJob=0\n";
	let unitOutput = properties;
	let unitCode = 0;
	let detachedOutput = "LoadState=not-found\nActiveState=inactive\n";
	let detachedCode = 0;
	let audit = "";
	let updates: readonly string[] = [];
	let processes: readonly string[] = [];
	let operation = 's "idle"';
	const io: RecoveryProbeIo = {
		run: async (argv) => {
			if (argv[0] === "systemctl") {
				if (argv[2] === "ceralive.service")
					return { code: unitCode, stdout: unitOutput };
				if (argv[2] === "ceralive-software-update.service")
					return { code: detachedCode, stdout: detachedOutput };
				return {
					code: 0,
					stdout: "LoadState=not-found\nActiveState=inactive\n",
				};
			}
			if (argv[0] === "dpkg") return { code: 0, stdout: audit };
			if (argv[0] === "busctl") return { code: 0, stdout: operation };
			if (argv[0] === "dpkg-query")
				return { code: 0, stdout: "install ok installed\t1.0.0\n" };
			return { code: 0, stdout: "" };
		},
		read: async () => processes[0] ?? "",
		list: async (path) =>
			path === "/proc" ? (processes.length ? ["123"] : []) : updates,
	};
	beforeEach(() => {
		unitOutput = properties;
		unitCode = 0;
		detachedOutput = "LoadState=not-found\nActiveState=inactive\n";
		detachedCode = 0;
		audit = "";
		updates = [];
		processes = [];
		operation = 's "idle"';
	});
	test("requires an effective mask and a dead service, not merely inactive", async () => {
		const probes = createRecoveryProbes(io, () => true);
		expect(await probes.backendStopped()).toBe(true);
		unitOutput = properties.replace("LoadState=masked", "LoadState=loaded");
		expect(await probes.backendStopped()).toBe(false);
		unitOutput = properties.replace("inactive", "active");
		expect(await probes.backendStopped()).toBe(false);
	});
	test("refuses recovery when the /run mask loses to the loaded /etc unit", async () => {
		const fixture = await createRecoveryFixture();
		try {
			unitOutput = properties.replace("LoadState=masked", "LoadState=loaded");
			const deps = {
				...fixture.deps,
				probes: {
					...fixture.deps.probes,
					backendStopped: createRecoveryProbes(io, () => true).backendStopped,
				},
			};
			await expect(recoverCrossSlot(fixture.identity, deps)).rejects.toThrow(
				"backend_must_be_inactive_and_runtime_masked",
			);
		} finally {
			await fixture.close();
		}
	});
	test("admits recovery past backend shutdown when systemd reports masked", async () => {
		const fixture = await createRecoveryFixture();
		try {
			const deps = {
				...fixture.deps,
				probes: {
					...fixture.deps.probes,
					backendStopped: createRecoveryProbes(io, () => true).backendStopped,
				},
			};
			expect((await recoverCrossSlot(fixture.identity, deps)).kind).toBe(
				"cleared",
			);
		} finally {
			await fixture.close();
		}
	});
	test("unit live or unreadable refuses; explicit not-found admits", async () => {
		const probes = createRecoveryProbes(io, () => true);
		expect(await probes.unitAbsent()).toBe(true);
		detachedOutput = properties.replace("masked", "loaded");
		expect(await probes.unitAbsent()).toBe(false);
		detachedOutput = "LoadState=not-found\nActiveState=inactive\n";
		detachedCode = 4;
		await expect(probes.unitAbsent()).rejects.toThrow("unit_unreadable");
	});
	test("dpkg audit and updates entries each refuse, RAUC or apt activity refuses", async () => {
		const probes = createRecoveryProbes(io, () => true);
		expect(await probes.dpkgClean()).toBe(true);
		audit = "not configured";
		expect(await probes.dpkgClean()).toBe(false);
		audit = "";
		updates = ["0001"];
		expect(await probes.dpkgClean()).toBe(false);
		expect(await probes.operationsIdle()).toBe(true);
		processes = ["apt-get"];
		expect(await probes.operationsIdle()).toBe(false);
		processes = [];
		operation = 's "installing"';
		expect(await probes.operationsIdle()).toBe(false);
	});
	test("the current slot candidate must differ from installed, not from old-slot history", async () => {
		const probes = createRecoveryProbes(io, () => true);
		expect(
			await probes.candidateUnapplied("ceralive-apt-credentials", "1.0.1"),
		).toBe(true);
		expect(
			await probes.candidateUnapplied("ceralive-apt-credentials", "1.0.0"),
		).toBe(false);
	});
});
