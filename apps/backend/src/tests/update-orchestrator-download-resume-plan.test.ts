/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Boot resume of a persisted `downloading` phase, replayed from the opi r5x
 * mains-cut drill (X1, 2026-09-30, `46.5-power/`): the cut hit dpkg while the
 * persisted phase still said `downloading`, the board rebooted with no install
 * unit, discovery reported the half-installed package as available again, and
 * the orchestrator sat in `downloading` refusing every check/install.
 *
 * Round 17 narrowed the recovery: only a probe that PROVED the unit gone drops
 * the attempt (to `idle`, check due, plan left on disk); a skipped or failed probe
 * keeps `downloading` and is re-asked on later ticks.
 */

/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/
/**
 * Boot resume of a persisted `downloading` phase, replayed from the opi r5x
 * mains-cut drill (X1, 2026-09-30, `46.5-power/`): the cut hit dpkg while the
 * persisted phase still said `downloading`, the board rebooted with no install
 * unit, discovery reported the half-installed package as available again, and
 * the orchestrator sat in `downloading` refusing every check/install.
 *
 * Round 17 narrowed the recovery: only a probe that PROVED the unit gone drops
 * the attempt (to `idle`, check due, plan left on disk); a skipped or failed probe
 * keeps `downloading` and is re-asked on later ticks.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import type { UpdateState } from "@ceraui/rpc/schemas";
import * as notifications from "../modules/system/update-orchestrator/notifications.ts";
import { setOrchestratorStateFilePathForTest } from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	boot,
	bootAwaitingIdleWithCpupowerPlan,
	dirs,
} from "./helpers/orchestrator-download-boot.ts";
import {
	CPUPOWER_PLAN,
	DOWNLOADING_WIRE,
	DRILL_ENTERED_AT,
	DRILL_PENDING,
	DRILL_WIRE_AFTER_BOOT,
	INSTALLING_WIRE,
	persistedDownloading,
} from "./helpers/orchestrator-download-inputs.ts";
import { scriptedProbe } from "./helpers/orchestrator-download-probes.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("round 19 — a restart in awaiting-idle keeps plan A for the install it launches", () => {
	test("a manual install from an idle wire that then fails quarantines plan A", async () => {
		const r = await bootAwaitingIdleWithCpupowerPlan();
		expect(getOrchestratorState().phase).toBe("awaiting-idle");

		expect(await installUpdatesNow()).toEqual({ started: true });
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(await r.quarantine.readPending()).toEqual(CPUPOWER_PLAN);

		r.setWire(INSTALLING_WIRE);
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("committing");
		r.setWire({ kind: "failed", reason: "apt-exit-nonzero" });
		await runOrchestratorTick();

		expect(getOrchestratorState().phase).toBe("quarantined");
		expect((await r.quarantine.read()).packages).toEqual(CPUPOWER_PLAN);
	});

	test("a manual install from an idle wire that succeeds names plan A in the installed notice", async () => {
		const notices = spyOn(notifications, "notifyUpdate");
		try {
			const r = await bootAwaitingIdleWithCpupowerPlan();
			expect(await installUpdatesNow()).toEqual({ started: true });
			r.setWire(INSTALLING_WIRE);
			await runOrchestratorTick();
			r.setWire({ kind: "success" });
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("restarting-services");
			await runOrchestratorTick();

			const installed = notices.mock.calls
				.map(([notice]) => notice)
				.filter((notice) => notice.kind === "installed");
			expect(installed).toHaveLength(1);
			expect(installed[0]).toMatchObject({ packages: ["linux-cpupower"] });
		} finally {
			notices.mockRestore();
		}
	});
});

describe("round 19 — after a proven-absent drop the next install overwrites the stale plan", () => {
	test("plan A dropped, discovery finds plan B, the install records B and a commit failure quarantines B only", async () => {
		const probe = scriptedProbe(["absent"]);
		let wire: UpdateState = { kind: "idle" };
		const b = await boot(persistedDownloading, {
			...probe.deps,
			getPackageInstallWireState: () => wire,
			runPackageCheck: async () => {
				wire = DRILL_WIRE_AFTER_BOOT;
				return null;
			},
			startPackageInstall: () => {
				wire = DOWNLOADING_WIRE;
				return { started: true };
			},
		});
		expect(getOrchestratorState().phase).toBe("idle");
		expect(getOrchestratorState().packageCheck.nextAttemptAt).toBe(
			DRILL_ENTERED_AT + 45_000,
		);
		expect(await b.quarantine.readPending()).toEqual(DRILL_PENDING);

		await runOrchestratorTick(); // discovery: available (plan B)
		await runOrchestratorTick(); // awaiting-idle
		await runOrchestratorTick(); // install starts from the available wire
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(await b.quarantine.readPending()).toEqual(CPUPOWER_PLAN);

		wire = INSTALLING_WIRE;
		await runOrchestratorTick();
		wire = { kind: "failed", reason: "apt-exit-nonzero" };
		await runOrchestratorTick();

		expect(getOrchestratorState().phase).toBe("quarantined");
		expect((await b.quarantine.read()).packages).toEqual(CPUPOWER_PLAN);
	});
});
