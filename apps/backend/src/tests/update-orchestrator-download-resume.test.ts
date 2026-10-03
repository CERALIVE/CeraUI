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
import { scriptedProbe } from "./helpers/orchestrator-download-probes.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("resume of a persisted download whose unit is gone (opi r5x X1 replay)", () => {
	test("a proven absence returns to idle with the check due, leaving the old plan for the next install to overwrite; discovery then finds the half-installed package", async () => {
		const notices = spyOn(notifications, "notifyUpdate");
		const probe = scriptedProbe(["absent"]);
		let wire: UpdateState = { kind: "idle" };
		try {
			const b = await boot(persistedDownloading, {
				...probe.deps,
				getPackageInstallWireState: () => wire,
				runPackageCheck: async () => {
					wire = DRILL_WIRE_AFTER_BOOT;
					return null;
				},
			});

			const resumed = getOrchestratorState();
			expect(resumed.phase).toBe("idle");
			expect(resumed.failureReason).toBeNull();
			expect(resumed.progress).toBeNull();
			expect(resumed.packageCheck.nextAttemptAt).toBe(
				DRILL_ENTERED_AT + 45_000,
			);
			expect(b.persisted).toEqual(["idle"]);
			// Not deleted on adjudication (a racy delete could hit a newer plan);
			// a later start from an `available` wire rewrites it. A start after
			// the wire stopped reading `available` keeps it (see below).
			expect(await b.quarantine.readPending()).toEqual(DRILL_PENDING);
			const quarantined = await b.quarantine.read();
			expect(quarantined.packages).toEqual([]);
			expect(quarantined.failedCommits).toEqual([]);
			expect(
				notices.mock.calls.filter(([notice]) => notice.kind === "refused"),
			).toEqual([]);

			await runOrchestratorTick();

			expect(getOrchestratorState().phase).toBe("available");
			expect(b.installs.count).toBe(0);
		} finally {
			notices.mockRestore();
		}
	});

	test("a second restart before the retry starts keeps awaiting-idle and re-adjudicates nothing", async () => {
		let probes = 0;
		await boot(
			{ ...persistedDownloading, phase: "awaiting-idle", progress: null },
			{
				recoverSoftwareUpdateIfRunning: async () => {
					probes++;
					return false;
				},
				getPackageInstallWireState: () => DRILL_WIRE_AFTER_BOOT,
			},
		);
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
		expect(probes).toBe(0);
	});
});

describe("resume of a persisted download with install-unit evidence keeps the existing paths", () => {
	test("a reattached live unit stays downloading and the tick keeps polling its progress", async () => {
		const b = await boot(persistedDownloading, {
			recoverSoftwareUpdateIfRunning: async () => true,
			getPackageInstallWireState: () => ({
				kind: "downloading",
				progress: { total: 6, downloading: 3, unpacking: 0, setting_up: 0 },
			}),
		});
		expect(getOrchestratorState().phase).toBe("downloading");
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(getOrchestratorState().progress?.percent).toBeGreaterThan(0);
		expect(b.installs.count).toBe(0);
	});

	test("a finished unit that succeeded is left for the tick, which commits it", async () => {
		const b = await boot(persistedDownloading, {
			recoverSoftwareUpdateIfRunning: async () => true,
			getPackageInstallWireState: () => ({ kind: "success" }),
		});
		expect(getOrchestratorState().phase).toBe("downloading");
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("restarting-services");
		expect(b.installs.count).toBe(0);
	});

	test("a finished unit that failed is left for the tick, which records a download failure and no quarantine", async () => {
		const b = await boot(persistedDownloading, {
			recoverSoftwareUpdateIfRunning: async () => true,
			getPackageInstallWireState: () => ({
				kind: "failed",
				reason: "apt-exit-nonzero",
			}),
		});
		expect(getOrchestratorState().phase).toBe("downloading");
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe("apt-exit-nonzero");
		expect((await b.quarantine.read()).packages).toEqual([]);
		expect(b.installs.count).toBe(0);
	});
});
