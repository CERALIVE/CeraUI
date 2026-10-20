import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivationArmed } from "../modules/system/update-orchestrator/os-activation-marker.ts";
import { failedAdmissionPredicate } from "../modules/system/update-orchestrator/os-stage-admission-diagnostics.ts";
import { observeRaucStage } from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { rockHelperFixture } from "./helpers/os-stage-rock-helper-fixture.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest } from "./helpers/os-stage-run-inputs.ts";

useSessionOwnerForFile();

test("dangling activation entry prevents an admissible snapshot and stage dispatch", async () => {
	// Given a stable malformed marker entry, not a pathname race.
	const dir = mkdtempSync(join(tmpdir(), "ceraui-marker-entry-"));
	const marker = join(dir, "activation-armed");
	symlinkSync(join(dir, "missing-target"), marker);
	const fixture = rockHelperFixture([]);
	const deps = {
		...fixture.deps,
		activationArmed: () => readActivationArmed(marker),
		read: (path: string) =>
			path.endsWith("/activation-armed")
				? Bun.file(marker).text()
				: fixture.deps.read(path),
	};
	try {
		// When production observation and admission consume the marker.
		const snapshot = await observeRaucStage(
			{ processes: new Set(), resources: new Set() },
			deps,
		);
		expect(snapshot && failedAdmissionPredicate(snapshot)).toBe(
			"activation-armed",
		);
		const h = await harness();
		await expect(
			runOsStageJob(manifest, h.control, {
				...h.deps,
				observe: (tracked, _deps, report) =>
					observeRaucStage(tracked, deps, report),
			}),
		).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
		// Then neither the original evidence nor the install boundary is consumed.
		expect(h.attempts()).toBe(0);
		expect(await readActivationArmed(marker)).toBe(true);
	} finally {
		rmSync(dir, { recursive: true });
	}
});
