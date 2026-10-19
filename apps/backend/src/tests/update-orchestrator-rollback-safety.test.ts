import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadOrchestratorState,
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import { fakeDeps } from "./helpers/orchestrator-runtime-harness.ts";
import {
	board,
	FALLBACK_BOOT,
	notices,
	V2,
} from "./helpers/os-verify-healthcheck-harness.ts";

let root: string | undefined;
afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

async function fixture(version: string) {
	root = await mkdtemp(join(tmpdir(), "rollback-safety-"));
	setOrchestratorStateFilePathForTest(join(root, "agent.json"));
	const quarantine = new UpdateQuarantine(
		join(root, "quarantine.json"),
		async () => {},
	);
	const b = board(version, { bootedVersion: V2, bootId: FALLBACK_BOOT });
	const deps = fakeDeps({
		...b.deps,
		persist: saveOrchestratorState,
		readPersistedState: loadOrchestratorState,
		quarantine,
		isUpdateAdmissionReady: async () => true,
	});
	return { quarantine, deps };
}

const historical: OrchestratorState = {
	...initialOrchestratorState(0),
	phase: "quarantined",
	failureReason: "os_version_mismatch",
};

test("rollback keeps verification and withholds notice when protection cannot be written", async () => {
	// Given a fallback whose quarantine write fails.
	const f = await fixture("2026.10.81");
	const failure = new Error("quarantine write failed");
	spyOn(f.quarantine, "recordOsRollback").mockRejectedValueOnce(failure);
	setOrchestratorRuntimeDepsForTest(f.deps);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-verifying",
	});
	// When verification attempts to settle the fallback.
	await expect(runOrchestratorTick()).rejects.toBe(failure);
	// Then no idle or notice can precede protection.
	expect(getOrchestratorState().phase).toBe("os-verifying");
	expect(notices("os-rollback", "2026.10.81")).toBe(0);
});

test.each(["live", "historical"] as const)(
	"%s rollback remains replay-owned when agent persistence fails",
	async (path) => {
		// Given durable source state, with a one-shot failure writing idle.
		const f = await fixture(`2026.10.${path === "live" ? 82 : 83}`);
		const old: OrchestratorState =
			path === "historical"
				? historical
				: { ...initialOrchestratorState(0), phase: "os-verifying" };
		if (path === "historical")
			await f.quarantine.recordOsRollback("2026.10.83", V2);
		saveOrchestratorState(old);
		let failIdle = true;
		const failure = new Error("agent.json write failed");
		setOrchestratorRuntimeDepsForTest({
			...f.deps,
			persist: (next) => {
				if (next.phase === "idle" && failIdle) {
					failIdle = false;
					throw failure;
				}
				saveOrchestratorState(next);
			},
		});
		setOrchestratorStateForTest(old);
		// When the rollback's terminal write fails.
		await expect(runOrchestratorTick()).rejects.toBe(failure);
		// Then Check cannot steal the replay, and its next tick persists idle.
		await expect(checkUpdatesNow()).rejects.toThrow();
		expect((await loadOrchestratorState())?.phase).toBe(old.phase);
		await runOrchestratorTick();
		expect((await loadOrchestratorState())?.phase).toBe("idle");
	},
);

test("historical rollback publishes its notice before persisting idle", async () => {
	// Given positive matching protection and a historical workflow quarantine.
	const f = await fixture("2026.10.84");
	await f.quarantine.recordOsRollback("2026.10.84", V2);
	let noticeAtIdle = 0;
	setOrchestratorRuntimeDepsForTest({
		...f.deps,
		persist: (next) => {
			if (next.phase === "idle")
				noticeAtIdle = notices("os-rollback", "2026.10.84");
			saveOrchestratorState(next);
		},
	});
	setOrchestratorStateForTest(historical);
	// When the scheduler clears historical quarantine.
	await runOrchestratorTick();
	// Then notice publication precedes the durable idle transition.
	expect(noticeAtIdle).toBe(1);
	expect(getOrchestratorState().phase).toBe("idle");
});

test("historical rollback cannot clear a replacement generation during the protection read", async () => {
	// Given a protection read held at a deterministic await boundary.
	const f = await fixture("2026.10.85");
	await f.quarantine.recordOsRollback("2026.10.85", V2);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const read = f.quarantine.isOsVersionQuarantined.bind(f.quarantine);
	spyOn(f.quarantine, "isOsVersionQuarantined").mockImplementation(
		async (version) => {
			const result = await read(version);
			entered.resolve();
			await release.promise;
			return result;
		},
	);
	setOrchestratorRuntimeDepsForTest(f.deps);
	setOrchestratorStateForTest(historical);
	const tick = runOrchestratorTick();
	await entered.promise;
	const replacement = { ...historical, enteredAt: 7 };
	// When another owner replaces state before the read returns.
	setOrchestratorStateForTest(replacement);
	release.resolve();
	await tick;
	// Then neither state nor notice from the stale generation is published.
	expect(getOrchestratorState()).toEqual(replacement);
	expect(notices("os-rollback", "2026.10.85")).toBe(0);
});
