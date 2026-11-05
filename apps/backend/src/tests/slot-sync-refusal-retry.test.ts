import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlotSyncProbeState } from "../modules/system/update-orchestrator/lock.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorStateForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { evidence, fixture } from "./helpers/slot-sync-runtime-harness.ts";

let root: string | undefined;
afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

test("refusal permits package and OS checks while the mirror waits for its retry deadline", async () => {
	let now = 2_000;
	let packages = 0;
	let os = 0;
	const h = fixture({
		now: () => now,
		isStreamLive: () => false,
		onlyMeteredCandidateExists: async () => false,
		loadCapabilities: async () => ({
			mode: "capable",
			features: ["apt-all-packages", "slot-sync", "rauc-verity-streaming"],
		}),
		loadSettings: async () => ({
			packagesAuto: true,
			systemAuto: true,
			schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
			channel: "stable",
			allowPackagesOverCellular: true,
			allowSystemOverCellular: true,
		}),
		runPackageCheck: async () => {
			packages++;
			return null;
		},
		checkOsManifest: async () => {
			os++;
			return {
				available: false,
				rateLimited: false,
				failed: false,
				reason: "",
			};
		},
		inspectSlotSync: async () => ({ kind: "refused", exitCode: 75 }),
		resetSlotSyncFailure: async () => {},
	});
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "syncing",
	});

	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("idle");
	await runOrchestratorTick();
	expect({ packages, os, commands: h.commands }).toEqual({
		packages: 1,
		os: 0,
		commands: [],
	});
	await runOrchestratorTick();
	expect({ packages, os, commands: h.commands }).toEqual({
		packages: 1,
		os: 1,
		commands: [],
	});
	now = 901_999;
	await runOrchestratorTick();
	expect(h.commands).toEqual([]);
	now = 902_000;
	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("syncing");
	expect(h.commands).toHaveLength(1);
});

test("refusal deadline survives restart, doubles on the next refusal and resets after a proven mirror", async () => {
	root = await mkdtemp(join(tmpdir(), "ceraui-sync-refusal-"));
	const file = join(root, "agent.json");
	setOrchestratorStateFilePathForTest(file);
	let now = 2_000;
	let atReset: Awaited<ReturnType<typeof loadOrchestratorState>> = null;
	const h = fixture({
		now: () => now,
		persist: saveOrchestratorState,
		inspectSlotSync: async () => ({ kind: "refused", exitCode: 75 }),
		resetSlotSyncFailure: async () => {
			atReset = await loadOrchestratorState();
		},
	});
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "syncing",
	});
	await runOrchestratorTick();
	expect(atReset).toMatchObject({
		phase: "idle",
		failureReason: null,
		slotSync: { nextAttemptAt: 902_000, consecutiveRefusals: 1 },
	});
	resetOrchestratorRuntimeForTest();
	now = 901_999;
	const restarted = fixture({
		...h.deps,
		resetSlotSyncFailure: async () => {},
	});
	await startUpdateOrchestrator(restarted.deps);
	expect(getOrchestratorState()).toMatchObject({
		phase: "idle",
		slotSync: { nextAttemptAt: 902_000, consecutiveRefusals: 1 },
	});
	expect(h.commands).toEqual([]);
	now = 902_000;
	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("syncing");
	await runOrchestratorTick();
	expect(await loadOrchestratorState()).toMatchObject({
		phase: "idle",
		slotSync: { nextAttemptAt: 2_702_000, consecutiveRefusals: 2 },
	});
	now = 2_702_000;
	await runOrchestratorTick();
	fixture({
		...restarted.deps,
		inspectSlotSync: async () => ({ kind: "inactive-clean" }),
		readSlotSyncEvidence: async () => ({
			...evidence,
			receiptStateSha256: evidence.statusSha256,
		}),
	});
	await runOrchestratorTick();
	await runOrchestratorTick();
	expect(await loadOrchestratorState()).toMatchObject({
		phase: "idle",
		slotSync: { nextAttemptAt: null, consecutiveRefusals: 0 },
	});
});

test("consecutive safety refusals double from fifteen minutes to a six hour cap", async () => {
	let now = 2_000;
	const h = fixture({
		now: () => now,
		inspectSlotSync: async () => ({ kind: "refused", exitCode: 75 }),
		resetSlotSyncFailure: async () => {},
	});
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "syncing",
	});
	const delays = [
		900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 21_600_000,
		21_600_000,
	];
	for (const [index, delay] of delays.entries()) {
		await runOrchestratorTick();
		expect(getOrchestratorState()).toMatchObject({
			phase: "idle",
			slotSync: { nextAttemptAt: now + delay, consecutiveRefusals: index + 1 },
		});
		now += delay;
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("syncing");
	}
	expect(h.commands).toHaveLength(7);
});

test("an OS-triggered sync candidate also honors a refusal deadline", async () => {
	const h = fixture();
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "sync-eligible",
		slotSync: { nextAttemptAt: 902_000, consecutiveRefusals: 1 },
	});
	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("idle");
	expect(h.commands).toEqual([]);
});

for (const probe of [
	{ kind: "running" },
	{ kind: "failed", exitCode: 1 },
	{ kind: "inactive-clean" },
] satisfies SlotSyncProbeState[]) {
	test(`startup reads a persisted historical refusal with a ${probe.kind} unit`, async () => {
		root = await mkdtemp(join(tmpdir(), "ceraui-historical-refusal-"));
		const file = join(root, "agent.json");
		setOrchestratorStateFilePathForTest(file);
		const before = {
			...initialOrchestratorState(1_000),
			phase: "failed" as const,
			failureReason: "slot-sync refused (exit 75)",
		};
		saveOrchestratorState(before);
		const h = fixture({
			persist: saveOrchestratorState,
			inspectSlotSync: async () => probe,
		});
		await startUpdateOrchestrator(h.deps);
		const loaded = await loadOrchestratorState();
		if (probe.kind === "inactive-clean") {
			expect(loaded).toMatchObject({
				phase: "idle",
				failureReason: null,
				slotSync: { nextAttemptAt: 2_000, consecutiveRefusals: 0 },
			});
			expect(loaded?.recoveredNotice).toBeUndefined();
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("syncing");
			expect(h.commands).toHaveLength(1);
		} else {
			expect(loaded).toEqual(before);
			expect(h.commands).toEqual([]);
		}
	});
}
