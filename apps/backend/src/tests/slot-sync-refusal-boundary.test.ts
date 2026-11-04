import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadOrchestratorState,
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
	toPersisted,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { fixture } from "./helpers/slot-sync-runtime-harness.ts";

let root: string | undefined;
afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

for (const consecutiveRefusals of [
	Number.MAX_SAFE_INTEGER - 1,
	Number.MAX_SAFE_INTEGER,
]) {
	test(`refusals from counter ${consecutiveRefusals} stay restart-readable with a six-hour delay`, async () => {
		root = await mkdtemp(join(tmpdir(), "ceraui-sync-counter-"));
		const file = join(root, "agent.json");
		setOrchestratorStateFilePathForTest(file);
		let now = 2_000;
		const h = fixture({
			now: () => now,
			persist: saveOrchestratorState,
			inspectSlotSync: async () => ({ kind: "refused", exitCode: 75 }),
			resetSlotSyncFailure: async () => {},
		});
		saveOrchestratorState({
			...initialOrchestratorState(0),
			phase: "syncing",
			slotSync: { nextAttemptAt: null, consecutiveRefusals },
		});
		const loaded = await loadOrchestratorState();
		if (!loaded) throw new Error("missing persisted refusal fixture");
		expect(loaded.slotSync?.consecutiveRefusals).toBe(consecutiveRefusals);
		setOrchestratorStateForTest(loaded);

		for (let attempt = 0; attempt < 2; attempt++) {
			await runOrchestratorTick();
			expect(await loadOrchestratorState()).toMatchObject({
				phase: "idle",
				failureReason: null,
				slotSync: {
					nextAttemptAt: now + 21_600_000,
					consecutiveRefusals: Number.MAX_SAFE_INTEGER,
				},
			});
			now += 21_600_000;
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("syncing");
		}
		expect(h.commands).toHaveLength(2);
	});
}

for (const consecutiveRefusals of [
	-1,
	Number.MAX_SAFE_INTEGER + 1,
	"corrupt",
]) {
	test(`persisted refusal counter ${consecutiveRefusals} remains rejected without changing its bytes`, async () => {
		root = await mkdtemp(join(tmpdir(), "ceraui-sync-invalid-counter-"));
		const file = join(root, "agent.json");
		const bytes = JSON.stringify({
			...toPersisted(initialOrchestratorState(0)),
			slotSync: { nextAttemptAt: null, consecutiveRefusals },
		});
		await writeFile(file, bytes);
		await expect(loadOrchestratorState(file)).rejects.toMatchObject({
			name: "OrchestratorRecoveryLoadError",
			terminalState: {
				phase: "failed",
				failureReason: "os_stage_recovery_invalid",
			},
		});
		expect(await readFile(file, "utf8")).toBe(bytes);
	});
}

test("a backwards clock cannot start a mirror before its saved refusal deadline", async () => {
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
	await runOrchestratorTick();
	for (now of [1_000, 901_999]) {
		await runOrchestratorTick();
		expect(getOrchestratorState()).toMatchObject({
			phase: "idle",
			slotSync: { nextAttemptAt: 902_000, consecutiveRefusals: 1 },
		});
		expect(h.commands).toEqual([]);
	}
	now = 902_000;
	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("syncing");
	expect(h.commands).toHaveLength(1);
});

test("a far-future persisted deadline is honored through the exact boundary", async () => {
	root = await mkdtemp(join(tmpdir(), "ceraui-sync-future-deadline-"));
	const file = join(root, "agent.json");
	setOrchestratorStateFilePathForTest(file);
	let now = 2_000;
	const h = fixture({ now: () => now, persist: saveOrchestratorState });
	const state = {
		...initialOrchestratorState(0),
		slotSync: {
			nextAttemptAt: Number.MAX_SAFE_INTEGER,
			consecutiveRefusals: 0,
		},
	};
	saveOrchestratorState(state);
	const loaded = await loadOrchestratorState();
	expect(loaded).toEqual(state);
	if (!loaded) throw new Error("missing persisted future deadline");
	setOrchestratorStateForTest(loaded);
	for (now of [2_000, Number.MAX_SAFE_INTEGER - 1]) {
		await runOrchestratorTick();
		expect(getOrchestratorState()).toEqual(state);
		expect(h.commands).toEqual([]);
	}
	now = Number.MAX_SAFE_INTEGER;
	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("syncing");
	expect(h.commands).toHaveLength(1);
});
