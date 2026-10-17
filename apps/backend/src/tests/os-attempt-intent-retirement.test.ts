import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { clearRecentLogLines, getRecentLogLines } from "../helpers/logger.ts";
import { syncOrchestratorDirectory } from "../modules/system/update-orchestrator/orchestrator-directory-sync.ts";
import { OsAttemptIntentStore } from "../modules/system/update-orchestrator/os-attempt-intent-store.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { loadOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	runOrchestratorTick,
} from "../modules/system/update-orchestrator/runtime.ts";
import { attemptIntent } from "./helpers/os-attempt-intent-fixture.ts";
import { lifecycleFixture } from "./helpers/os-attempt-lifecycle-fixture.ts";
import { record } from "./helpers/os-stage-startup-harness.ts";

const fixtures: ReturnType<typeof lifecycleFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
	clearRecentLogLines();
});

for (const outcome of [
	"success",
	"automatic",
	"operator",
	"unsafe",
	"untyped",
] as const) {
	test(`retirement failure preserves ${outcome} outcome and closes admission without throwing from tick`, async () => {
		// Given real launch/publication followed by an unavailable retirement store.
		const f = lifecycleFixture();
		fixtures.push(f);
		let fault = true;
		class Store extends OsAttemptIntentStore {
			override retire(
				expected: Parameters<OsAttemptIntentStore["retire"]>[0],
			): void {
				if (fault)
					throw new OsStageError("rauc_recovery_unproven", {
						cause: new Error("retire IO"),
					});
				super.retire(expected);
			}
		}
		const store = new Store(f.intentStore.storage);
		const reason =
			outcome === "automatic"
				? "os_transport_failed"
				: outcome === "operator"
					? "rauc_install_failed"
					: "rauc_recovery_unproven";
		await f.offer({
			osAttemptIntentStore: store,
			stageOs: async (candidate, progress, control) => {
				if (outcome === "success")
					return f.deps.stageOs(candidate, progress, control);
				throw outcome === "untyped"
					? new Error("untyped stage refusal")
					: new OsStageError(reason);
			},
		});
		// When the producer settles but retirement fails.
		const result = await installUpdatesNow();
		const settled = getOrchestratorState();
		// Then the original stage policy survives; cleanup alone closes admission.
		expect(result.started).toBe(outcome === "success");
		expect(
			getRecentLogLines().some((line) =>
				line.includes('"event":"intent-retirement-pending"'),
			),
		).toBe(true);
		expect(settled.failureReason).toBe(
			outcome === "success"
				? null
				: outcome === "untyped"
					? "untyped stage refusal"
					: reason,
		);
		expect(await loadOrchestratorState(f.file)).toEqual(settled);
		expect(store.read()?.phase).toBe("launching");
		expect(await checkUpdatesNow()).toEqual({ started: false, reason: "busy" });
		await runOrchestratorTick();
		expect(getOrchestratorState()).toEqual(settled);
		fault = false;
		await runOrchestratorTick();
		expect(store.read()).toBeNull();
		await f.restart();
		expect(getOrchestratorState()).toEqual(
			outcome === "success"
				? { ...settled, phase: "os-activation-armed" }
				: settled,
		);
	});
}

test("failed retirement parent fsync remains pending until durable cleanup retries after unlink", async () => {
	// Given normal staging, but parent fsync fails after the intent unlink.
	const f = lifecycleFixture();
	fixtures.push(f);
	let fault = true;
	const store = new OsAttemptIntentStore({
		...f.intentStore.storage,
		syncParent: (path) => {
			if (fault && !existsSync(path)) throw new Error("retire parent fsync");
			syncOrchestratorDirectory(path);
		},
	});
	await f.offer({ osAttemptIntentStore: store });
	// When final cleanup loses its durability acknowledgement.
	expect((await installUpdatesNow()).started).toBe(true);
	// Then missing intent alone cannot clear the current process's pending latch.
	expect(store.read()).toBeNull();
	await runOrchestratorTick();
	expect(f.effects.arms).toBe(0);
	fault = false;
	await runOrchestratorTick();
	await runOrchestratorTick();
	expect(f.effects.arms).toBe(1);
	await f.restart();
	expect(f.intentStore.read()).toBeNull();
});

test("unreadable intent in finally retains stage success and producer tokens clear before repair", async () => {
	// Given success publication followed by corrupt retirement authority.
	const f = lifecycleFixture();
	fixtures.push(f);
	let intact = "";
	await f.offer({
		stageOs: async (candidate, progress, control) => {
			await f.deps.stageOs(candidate, progress, control);
			intact = readFileSync(f.intentStore.storage.path, "utf8");
			writeFileSync(f.intentStore.storage.path, "{");
		},
	});
	// When producer completion reaches finally.
	expect((await installUpdatesNow()).started).toBe(true);
	// Then no cleanup exception replaces success or permits a premature activation.
	expect(getOrchestratorState().phase).toBe("os-staged");
	await runOrchestratorTick();
	expect(f.effects.arms).toBe(0);
	writeFileSync(f.intentStore.storage.path, intact);
	await runOrchestratorTick();
	await runOrchestratorTick();
	expect(f.effects.arms).toBe(1);
	await f.restart();
	expect(f.intentStore.read()).toBeNull();
});

test("mismatched intent in finally cannot mask success or bypass ownership refusal", async () => {
	// Given success but a different validated intent appears at final cleanup.
	const f = lifecycleFixture();
	fixtures.push(f);
	let occupied = true;
	await f.offer({
		readOsStageJob: async () => (occupied ? record : null),
		stageOs: async (candidate, progress, control) => {
			await f.deps.stageOs(candidate, progress, control);
			const current = f.intentStore.read();
			if (!current) throw new Error("fixture intent missing");
			f.intentStore.retire(current);
			f.intentStore.write({ ...attemptIntent(), phase: "launching" }, null);
		},
	});
	// When finally refuses that mismatched authority.
	expect((await installUpdatesNow()).started).toBe(true);
	// Then success survives and ownership must become conclusive before cleanup.
	await runOrchestratorTick();
	expect(f.effects.arms).toBe(0);
	expect(f.intentStore.read()?.attemptId).toBe(
		"00000000-0000-4000-8000-000000000001",
	);
	occupied = false;
	await runOrchestratorTick();
	await runOrchestratorTick();
	expect(f.effects.arms).toBe(1);
	await f.restart();
	expect(f.intentStore.read()).toBeNull();
});
