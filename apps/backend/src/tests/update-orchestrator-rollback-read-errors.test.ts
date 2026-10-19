import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStagedReceipt } from "../modules/system/update-orchestrator/os-agent.ts";
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
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
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

test.each(["quarantine", "receipt"] as const)(
	"startup proceeds but historical clearance stays closed with invalid %s",
	async (record) => {
		// Given a historical rollback and one damaged real evidence file.
		const dir = await mkdtemp(join(tmpdir(), "rollback-read-error-"));
		root = dir;
		setOrchestratorStateFilePathForTest(join(dir, "agent.json"));
		const quarantine = new UpdateQuarantine(
			join(dir, "quarantine.json"),
			async () => {},
		);
		const version = `2026.10.${record === "quarantine" ? 91 : 92}`;
		const b = board(version, { bootedVersion: V2, bootId: FALLBACK_BOOT });
		await quarantine.recordOsRollback(version, V2);
		const damaged = join(
			dir,
			record === "quarantine" ? "quarantine.json" : "os-staged.json",
		);
		const bytes =
			record === "quarantine"
				? "{"
				: JSON.stringify({ schema: 1, version: "garbage" });
		await Bun.write(damaged, bytes);
		const old = {
			...initialOrchestratorState(0),
			phase: "quarantined" as const,
			failureReason: "os_version_mismatch",
		};
		saveOrchestratorState(old);
		const deps = fakeDeps({
			...b.deps,
			quarantine,
			persist: saveOrchestratorState,
			readPersistedState: loadOrchestratorState,
			...(record === "receipt"
				? { readOsReceipt: () => readStagedReceipt(dir) }
				: {}),
		});
		// When backend update startup adjudicates the retained state.
		await startUpdateOrchestrator(deps);
		await runOrchestratorTick();
		// Then startup is ready, but Check and historical clearance fail closed without evidence repair.
		expect(await checkUpdatesNow()).toEqual({ started: false, reason: "busy" });
		expect(getOrchestratorState()).toEqual(old);
		expect(notices("os-rollback", version)).toBe(0);
		expect(await Bun.file(damaged).text()).toBe(bytes);
	},
);
