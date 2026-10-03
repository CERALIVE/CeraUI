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
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { UpdateState } from "@ceraui/rpc/schemas";
import {
	loadOrchestratorState,
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
} from "../modules/system/update-orchestrator/runtime.ts";
import { boot, dirs } from "./helpers/orchestrator-download-boot.ts";
import {
	DRILL_ENTERED_AT,
	DRILL_PENDING,
	DRILL_WIRE_AFTER_BOOT,
	persistedDownloading,
} from "./helpers/orchestrator-download-inputs.ts";
import {
	gatedProbe,
	scriptedProbe,
} from "./helpers/orchestrator-download-probes.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("round 18 — a stale deferred verdict never touches a newer attempt", () => {
	test("probe slow while D8 aborts and a replacement install starts: the replacement and its plan survive", async () => {
		const probe = gatedProbe(["not-probed", "absent"], 2);
		let wire: UpdateState = { kind: "idle" };
		let stops = 0;
		const b = await boot(persistedDownloading, {
			...probe.deps,
			getPackageInstallWireState: () => wire,
			stopPackageInstallUnit: async () => {
				stops++;
			},
		});
		expect(getOrchestratorState().phase).toBe("downloading");

		const tick = runOrchestratorTick();
		await probe.entered;
		expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
		wire = DRILL_WIRE_AFTER_BOOT;
		expect(await installUpdatesNow()).toEqual({ started: true });
		const replacement = getOrchestratorState();
		expect(replacement.phase).toBe("downloading");
		probe.release();
		await tick;

		expect(stops).toBe(1);
		expect(getOrchestratorState()).toEqual(replacement);
		expect(b.installs.count).toBe(1);
		expect(await b.quarantine.readPending()).toEqual([
			{ name: "linux-cpupower", version: "6.12.111-1" },
		]);
		await runOrchestratorTick();
		expect(probe.calls.count).toBe(2);
		expect(getOrchestratorState().phase).toBe("downloading");
	});

	test("an abort and a replacement in the same millisecond are still a different download", async () => {
		const probe = scriptedProbe(["not-probed", "absent"]);
		let wire: UpdateState = { kind: "idle" };
		const b = await boot(persistedDownloading, {
			...probe.deps,
			now: () => DRILL_ENTERED_AT,
			getPackageInstallWireState: () => wire,
			stopPackageInstallUnit: async () => {},
		});
		expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
		wire = DRILL_WIRE_AFTER_BOOT;
		expect(await installUpdatesNow()).toEqual({ started: true });
		expect(getOrchestratorState().enteredAt).toBe(DRILL_ENTERED_AT);

		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(probe.calls.count).toBe(1);
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(b.installs.count).toBe(1);
	});

	test("a stream start during the BOOT probe sees the download, aborts it, and the late absence is ignored", async () => {
		const probe = gatedProbe(["absent"], 1);
		let stops = 0;
		const booting = boot(persistedDownloading, {
			...probe.deps,
			getPackageInstallWireState: () => ({ kind: "idle" }),
			stopPackageInstallUnit: async () => {
				stops++;
			},
		});
		await probe.entered;
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
		probe.release();
		const b = await booting;

		expect(stops).toBe(1);
		expect(getOrchestratorState().phase).toBe("available");
		expect((await loadOrchestratorState())?.phase).toBe("available");
		expect(b.persisted).not.toContain("idle");
	});

	test("a persist failure on the recovery leaves the obligation on disk and nothing wedged", async () => {
		const probe = scriptedProbe(["throws", "absent"]);
		let failNextIdleWrite = true;
		await boot(persistedDownloading, {
			...probe.deps,
			getPackageInstallWireState: () => ({ kind: "idle" }),
			persist: (next) => {
				if (next.phase === "idle" && failNextIdleWrite) {
					failNextIdleWrite = false;
					throw new Error("EIO: agent.json");
				}
				saveOrchestratorState(next);
			},
		});
		await expect(runOrchestratorTick()).rejects.toThrow("EIO");
		expect((await loadOrchestratorState())?.phase).toBe("downloading");

		await runOrchestratorTick();
		expect(getOrchestratorState().phase).not.toBe("downloading");

		const onDisk = await loadOrchestratorState();
		resetOrchestratorRuntimeForTest();
		const again = scriptedProbe(["absent"]);
		await boot(onDisk ?? persistedDownloading, {
			...again.deps,
			getPackageInstallWireState: () => ({ kind: "idle" }),
		});
		expect(getOrchestratorState().phase).not.toBe("downloading");
	});

	test("an install started from a non-available wire leaves the plan on disk as it was (a6b8210c behaviour)", async () => {
		const probe = scriptedProbe(["absent"]);
		let wire: UpdateState = { kind: "idle" };
		const b = await boot(persistedDownloading, {
			...probe.deps,
			getPackageInstallWireState: () => wire,
			runPackageCheck: async () => {
				wire = DRILL_WIRE_AFTER_BOOT;
				return null;
			},
		});
		expect(await b.quarantine.readPending()).toEqual(DRILL_PENDING);
		await runOrchestratorTick(); // discovery: available
		await runOrchestratorTick(); // awaiting-idle
		wire = { kind: "idle" }; // a concurrent refresh reset the wire
		await runOrchestratorTick(); // install starts
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(await b.quarantine.readPending()).toEqual(DRILL_PENDING);
	});
});
