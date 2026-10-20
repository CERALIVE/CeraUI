import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { acquireOsOrphanLock } from "../modules/system/update-orchestrator/os-stage-orphan-lock.ts";
import {
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
} from "../modules/system/update-orchestrator/runtime.ts";
import { setup } from "./helpers/os-agent-runtime-harness.ts";

afterEach(() => resetOrchestratorRuntimeForTest());

test("stage publication and activation exclude a competing real CONTROL writer", async () => {
	// Given a real kernel CONTROL lease shared by stage publication and arming.
	const dir = mkdtempSync("/var/tmp/ceraui-writer-control-");
	const acquire = () =>
		acquireOsOrphanLock({
			lock: join(dir, "control.lock"),
			helper: join(
				import.meta.dir,
				"../../../../deployment/ceralive-os-stage-guard",
			),
		});
	const protectedEffects: string[] = [];
	setup({
		acquireOsStageControl: acquire,
		stageOs: async (_manifest, _progress, control) => {
			expect(control?.controlLease?.held()).toBe(true);
			await expect(acquire()).rejects.toHaveProperty(
				"reason",
				"rauc_recovery_unproven",
			);
			protectedEffects.push("publication");
		},
		armOs: async (_now, control) => {
			expect(control?.held()).toBe(true);
			await expect(acquire()).rejects.toHaveProperty(
				"reason",
				"rauc_recovery_unproven",
			);
			protectedEffects.push("activation");
		},
	});
	// When a successful install is published and the next tick arms it.
	await installUpdatesNow();
	await runOrchestratorTick();
	// Then neither cooperative writer can replace evidence inside retirement's lease.
	expect(protectedEffects).toEqual(["publication", "activation"]);
});
