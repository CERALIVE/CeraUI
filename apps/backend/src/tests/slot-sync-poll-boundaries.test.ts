import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifySlotSyncProbe,
	type SlotSyncProbeState,
} from "../modules/system/update-orchestrator/lock.ts";
import {
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	SLOT_SYNC_QUEUED_START_GRACE_MS,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import type { SlotSyncEvidence } from "../modules/system/update-orchestrator/slot-sync-gate.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { raucSlots } from "./helpers/slot-sync-rauc.ts";

// Interleavings around `pollSlotSync`'s awaits: a process death between two
// steps, or a read that still returns the previous run's state.

const statusSha256 = "a".repeat(64);
const matching: SlotSyncEvidence = {
	healthyState: {
		boot_id: "boot-new",
		slot: "A",
		build_id: "build-new",
		dpkg_status_sha256: statusSha256,
		recorded_at: "2026-09-24T00:00:00Z",
	},
	bootId: "boot-new",
	statusSha256,
	buildId: "build-new",
	receiptStateSha256: statusSha256,
	receiptTarget: "other",
	receiptTargetSlot: "rootfs.1",
};

const show = (props: Record<string, string>) => ({
	exitCode: 0,
	stdout: Object.entries(props)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n"),
});
const unitFailed = show({
	LoadState: "loaded",
	ActiveState: "failed",
	SubState: "failed",
	ExecMainCode: "1",
	ExecMainStatus: "1",
});
const inactiveClean = show({
	LoadState: "loaded",
	ActiveState: "inactive",
	SubState: "dead",
	ExecMainCode: "0",
	ExecMainStatus: "0",
});
const succeededExit0 = show({
	LoadState: "loaded",
	ActiveState: "inactive",
	SubState: "dead",
	ExecMainCode: "1",
	ExecMainStatus: "0",
});
const stillRunning = show({
	LoadState: "loaded",
	ActiveState: "activating",
	SubState: "start",
	ExecMainCode: "0",
	ExecMainStatus: "0",
});

let root: string | undefined;
afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

function deps(overrides: Partial<typeof defaultOrchestratorRuntimeDeps>) {
	const cleanup: string[] = [];
	const value = {
		...defaultOrchestratorRuntimeDeps,
		now: () => 9_000,
		loadCapabilities: async () => ({
			mode: "capable" as const,
			features: ["apt-all-packages", "slot-sync"] as (
				| "apt-all-packages"
				| "slot-sync"
			)[],
		}),
		isStreamLive: () => false,
		readSlotSyncEvidence: async () => matching,
		readRootSlots: async () => raucSlots("A"),
		startSlotSync: async () => {},
		resetSlotSyncFailure: async () => {},
		cleanSlotSyncArchives: async () => {
			cleanup.push("apt");
			return true;
		},
		removeRaucDownloads: async () => {
			cleanup.push("downloads");
		},
		dropSupersededQuarantine: async () => {
			cleanup.push("quarantine");
		},
		refreshSlots: async () => {
			cleanup.push("slots");
		},
		persist: () => {},
		...overrides,
	};
	return { value, cleanup };
}

function syncing(): void {
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "syncing",
	});
}

describe("B1: the failure verdict is durable before the systemd record is cleared", () => {
	test("a backend that dies inside reset-failed restarts failed, never synced from the surviving receipt", async () => {
		root = await mkdtemp(join(tmpdir(), "ceraui-slot-sync-b1-"));
		const file = join(root, "agent.json");
		setOrchestratorStateFilePathForTest(file);
		syncing();
		saveOrchestratorState(getOrchestratorState());
		let persistedAtReset: string | undefined;
		const first = deps({
			persist: saveOrchestratorState,
			inspectSlotSync: async () => classifySlotSyncProbe(unitFailed),
			resetSlotSyncFailure: async () => {
				// The process dies here: whatever is on disk is all that survives.
				persistedAtReset = readFileSync(file, "utf8");
				throw new Error("killed inside reset-failed");
			},
		});
		setOrchestratorRuntimeDepsForTest(first.value);
		await runOrchestratorTick();
		expect(persistedAtReset).toBeDefined();
		expect(JSON.parse(persistedAtReset ?? "{}").phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe(
			"slot-sync failed (exit 1)",
		);

		// Restart from exactly the crash-time bytes. The cleared record now
		// reads as a clean inactive unit and the receipt was published before
		// the failed mark-good; neither may turn the failure into success.
		writeFileSync(file, persistedAtReset ?? "");
		resetOrchestratorRuntimeForTest();
		setOrchestratorStateFilePathForTest(file);
		const phases: string[] = [];
		const second = deps({
			persist: (next) => {
				phases.push(next.phase);
				saveOrchestratorState(next);
			},
			inspectSlotSync: async () => classifySlotSyncProbe(inactiveClean),
		});
		await startUpdateOrchestrator(second.value);
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(phases).not.toContain("synced");
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe(
			"slot-sync failed (exit 1)",
		);
		expect(second.cleanup).toEqual([]);
	});

	test("a rejecting reset-failed cannot change the verdict", async () => {
		for (const [text, reason] of [
			[unitFailed, "slot-sync failed (exit 1)"],
			[
				show({
					LoadState: "loaded",
					ActiveState: "failed",
					SubState: "failed",
					ExecMainCode: "1",
					ExecMainStatus: "75",
				}),
				"slot-sync refused (exit 75)",
			],
		] as const) {
			resetOrchestratorRuntimeForTest();
			let resets = 0;
			setOrchestratorRuntimeDepsForTest(
				deps({
					inspectSlotSync: async () => classifySlotSyncProbe(text),
					resetSlotSyncFailure: async () => {
						resets++;
						throw new Error("systemctl reset-failed timed out");
					},
				}).value,
			);
			syncing();
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("failed");
			expect(getOrchestratorState().failureReason).toBe(reason);
			expect(resets).toBe(1);
		}
	});
});

describe("B2: a matching receipt settles only after a fresh finished-and-clean probe", () => {
	type Show = ReturnType<typeof show>;
	const previousRunFinished: ReadonlyArray<
		readonly ["succeeded" | "inactive-clean", Show]
	> = [
		["succeeded", succeededExit0],
		["inactive-clean", inactiveClean],
	];

	for (const [label, finished] of previousRunFinished) {
		test(`a receipt published by a still-running run cannot settle from the previous run's ${label} probe`, async () => {
			let current: Show = finished;
			let reads = 0;
			let release: ((value: SlotSyncEvidence) => void) | undefined;
			const deferred = new Promise<SlotSyncEvidence>((resolve) => {
				release = resolve;
			});
			const probes: SlotSyncProbeState["kind"][] = [];
			const h = deps({
				inspectSlotSync: async () => {
					const probe = classifySlotSyncProbe(current);
					probes.push(probe.kind);
					return probe;
				},
				readSlotSyncEvidence: () => {
					reads++;
					return reads === 1 ? deferred : Promise.resolve(matching);
				},
			});
			setOrchestratorRuntimeDepsForTest(h.value);
			syncing();
			const tick = runOrchestratorTick();
			while (reads === 0) await Bun.sleep(0);
			// The new run starts and publishes its receipt before mark-good.
			current = stillRunning;
			release?.(matching);
			await tick;
			expect(getOrchestratorState().phase).toBe("syncing");
			expect(h.cleanup).toEqual([]);
			expect(probes).toEqual([label, "running"]);

			current = finished;
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("synced");
			expect(h.cleanup).toEqual(["apt", "downloads", "quarantine", "slots"]);
		});
	}

	test("a run that fails between the receipt and the re-probe keeps its failure verdict", async () => {
		const refused = show({
			LoadState: "loaded",
			ActiveState: "failed",
			SubState: "failed",
			ExecMainCode: "1",
			ExecMainStatus: "75",
		});
		const cases: ReadonlyArray<readonly [Show, Show, string]> = [
			[succeededExit0, unitFailed, "slot-sync failed (exit 1)"],
			[inactiveClean, unitFailed, "slot-sync failed (exit 1)"],
			[inactiveClean, refused, "slot-sync refused (exit 75)"],
			[
				succeededExit0,
				show({ LoadState: "not-found" }),
				"slot-sync-unit-absent",
			],
		];
		for (const [first, second, reason] of cases) {
			resetOrchestratorRuntimeForTest();
			const sequence = [first, second];
			let resets = 0;
			const h = deps({
				inspectSlotSync: async () =>
					classifySlotSyncProbe(sequence.shift() ?? second),
				resetSlotSyncFailure: async () => {
					resets++;
				},
			});
			setOrchestratorRuntimeDepsForTest(h.value);
			syncing();
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("failed");
			expect(getOrchestratorState().failureReason).toBe(reason);
			expect(h.cleanup).toEqual([]);
			expect(resets).toBe(reason === "slot-sync-unit-absent" ? 0 : 1);
		}
	});

	test("a receipt that cannot be read leaves a succeeded probe waiting and fails an inactive-clean one", async () => {
		// Past the queued-start grace, the inactive-clean failure is concluded
		// only from a second, fresh probe (N1).
		for (const [finished, phase, expectedProbes] of [
			[succeededExit0, "syncing", 1],
			[inactiveClean, "failed", 2],
		] as const) {
			resetOrchestratorRuntimeForTest();
			let probes = 0;
			const h = deps({
				now: () => SLOT_SYNC_QUEUED_START_GRACE_MS + 9_000,
				inspectSlotSync: async () => {
					probes++;
					return classifySlotSyncProbe(finished);
				},
				readSlotSyncEvidence: async () => {
					throw new Error("receipt unreadable");
				},
			});
			setOrchestratorRuntimeDepsForTest(h.value);
			syncing();
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe(phase);
			expect(probes).toBe(expectedProbes);
			expect(h.cleanup).toEqual([]);
		}
	});
});

// Raw `systemctl show` text, one `Key=value` per line, duplicates kept.
const lines = (...entries: ReadonlyArray<readonly [string, string]>) => ({
	exitCode: 0,
	stdout: entries.map(([key, value]) => `${key}=${value}`).join("\n"),
});

async function settleThroughRuntime(result: {
	exitCode: number;
	stdout: string;
}) {
	resetOrchestratorRuntimeForTest();
	const h = deps({
		inspectSlotSync: async () => classifySlotSyncProbe(result),
	});
	setOrchestratorRuntimeDepsForTest(h.value);
	syncing();
	await runOrchestratorTick();
	return { state: getOrchestratorState(), cleanup: h.cleanup };
}

describe("B3: each requested property must appear exactly once before the receipt is consulted", () => {
	const loaded = ["LoadState", "loaded"] as const;
	const inactive = ["ActiveState", "inactive"] as const;
	const dead = ["SubState", "dead"] as const;
	const exited = ["ExecMainCode", "1"] as const;
	const status0 = ["ExecMainStatus", "0"] as const;
	const duplicated: ReadonlyArray<readonly [string, ReturnType<typeof lines>]> =
		[
			[
				"ExecMainStatus 1 then 0",
				lines(loaded, inactive, dead, exited, ["ExecMainStatus", "1"], status0),
			],
			[
				"ActiveState active then inactive",
				lines(
					loaded,
					["ActiveState", "active"],
					inactive,
					dead,
					exited,
					status0,
				),
			],
			[
				"ActiveState twice, equal",
				lines(loaded, inactive, inactive, dead, exited, status0),
			],
			[
				"LoadState not-found then loaded",
				lines(
					["LoadState", "not-found"],
					loaded,
					inactive,
					dead,
					exited,
					status0,
				),
			],
			[
				"LoadState twice, equal",
				lines(loaded, loaded, inactive, dead, exited, status0),
			],
			[
				"inactive-clean with ExecMainStatus twice",
				lines(loaded, inactive, dead, ["ExecMainCode", "0"], status0, status0),
			],
			[
				"inactive-clean with ExecMainCode twice",
				lines(
					loaded,
					inactive,
					dead,
					["ExecMainCode", "0"],
					["ExecMainCode", "0"],
					status0,
				),
			],
			["SubState twice", lines(loaded, inactive, dead, dead, exited, status0)],
		];

	for (const [label, result] of duplicated) {
		test(`${label}: never classified as a receipt-consulting shape and never settles`, async () => {
			const verdict = classifySlotSyncProbe(result);
			expect(verdict.kind).not.toBe("succeeded");
			expect(verdict.kind).not.toBe("inactive-clean");
			const { state, cleanup } = await settleThroughRuntime(result);
			expect(state.phase).not.toBe("synced");
			expect(cleanup).toEqual([]);
		});
	}

	test("a single clean instance of each property still settles through the runtime", async () => {
		for (const result of [
			lines(loaded, inactive, dead, exited, status0),
			lines(loaded, inactive, dead, ["ExecMainCode", "0"], status0),
		]) {
			const { state } = await settleThroughRuntime(result);
			expect(state.phase).toBe("synced");
		}
	});
});

describe("B4: a validated terminal exit 75 is a typed refusal on either lifecycle", () => {
	const inactiveExit = (status: string) =>
		lines(
			["LoadState", "loaded"],
			["ActiveState", "inactive"],
			["SubState", "dead"],
			["ExecMainCode", "1"],
			["ExecMainStatus", status],
		);

	test("inactive/dead with ExecMainCode=1 ExecMainStatus=75 is refused, with or without a matching receipt", async () => {
		expect(classifySlotSyncProbe(inactiveExit("75"))).toEqual({
			kind: "refused",
			exitCode: 75,
		});
		for (const receiptStateSha256 of [statusSha256, "b".repeat(64), null]) {
			resetOrchestratorRuntimeForTest();
			const h = deps({
				inspectSlotSync: async () => classifySlotSyncProbe(inactiveExit("75")),
				readSlotSyncEvidence: async () => ({ ...matching, receiptStateSha256 }),
			});
			setOrchestratorRuntimeDepsForTest(h.value);
			syncing();
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("failed");
			expect(getOrchestratorState().failureReason).toBe(
				"slot-sync refused (exit 75)",
			);
			expect(h.cleanup).toEqual([]);
		}
	});

	test("other nonzero statuses stay failed and status 0 stays succeeded", () => {
		for (const status of ["1", "74", "76"])
			expect(classifySlotSyncProbe(inactiveExit(status))).toEqual({
				kind: "failed",
				exitCode: Number(status),
			});
		expect(classifySlotSyncProbe(inactiveExit("0"))).toEqual({
			kind: "succeeded",
		});
	});
});
