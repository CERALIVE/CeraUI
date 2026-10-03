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
import { setup } from "../modules/setup.ts";
import {
	recoverSoftwareUpdateIfRunning,
	resetSoftwareUpdateState,
} from "../modules/system/software-updates.ts";
import * as notifications from "../modules/system/update-orchestrator/notifications.ts";
import { setOrchestratorStateFilePathForTest } from "../modules/system/update-orchestrator/persistence.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
} from "../modules/system/update-orchestrator/runtime.ts";
import { boot, dirs } from "./helpers/orchestrator-download-boot.ts";
import {
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

describe("trace 1 — a skipped probe is not an absent unit", () => {
	test("updates disabled: the real recovery never probes, the download is kept and D8 still reaches the commit-stage probe", async () => {
		const savedEnabled = setup.apt_update_enabled;
		resetSoftwareUpdateState();
		setup.apt_update_enabled = false;
		let inspections = 0;
		let commitProbes = 0;
		const recoveryDeps = {
			recover: async () => {
				inspections++;
				// The surviving detached transaction: still running dpkg.
				return {
					completion: new Promise<number>(() => {}),
					wasAlreadyFinished: false,
				};
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		};
		try {
			const b = await boot(persistedDownloading, {
				recoverSoftwareUpdateIfRunning: () =>
					recoverSoftwareUpdateIfRunning(recoveryDeps),
				getPackageInstallWireState: () => ({ kind: "idle" }),
				isCommitStageRunning: async () => {
					commitProbes++;
					return true;
				},
			});

			expect(inspections).toBe(0);
			expect(getOrchestratorState().phase).toBe("downloading");
			expect(b.persisted).not.toContain("awaiting-idle");

			const admission = await admitAndPrepareStreamStart();
			expect(admission.allowed).toBe(false);
			expect(commitProbes).toBe(1);

			await runOrchestratorTick();
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("downloading");
			expect(b.installs.count).toBe(0);
			expect(await b.quarantine.readPending()).toEqual(DRILL_PENDING);
		} finally {
			setup.apt_update_enabled = savedEnabled;
			resetSoftwareUpdateState();
		}
	});

	test("the deferral stays pending: once updates are enabled the next tick probes and a proven absence recovers", async () => {
		const savedEnabled = setup.apt_update_enabled;
		resetSoftwareUpdateState();
		setup.apt_update_enabled = false;
		let inspections = 0;
		const recoveryDeps = {
			recover: async () => {
				inspections++;
				return null;
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		};
		try {
			await boot(persistedDownloading, {
				recoverSoftwareUpdateIfRunning: () =>
					recoverSoftwareUpdateIfRunning(recoveryDeps),
				getPackageInstallWireState: () => ({ kind: "idle" }),
			});
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("downloading");
			expect(inspections).toBe(0);

			setup.apt_update_enabled = true;
			await runOrchestratorTick();
			expect(inspections).toBe(1);
			expect(getOrchestratorState().phase).toBe("idle");
		} finally {
			setup.apt_update_enabled = savedEnabled;
			resetSoftwareUpdateState();
		}
	});
});

describe("trace 2 — an inconclusive probe defers adjudication to later ticks", () => {
	test("probe throws, then proves absence: recovered exactly once, then normal discovery installs again", async () => {
		const notices = spyOn(notifications, "notifyUpdate");
		const probe = scriptedProbe(["throws", "throws", "absent"]);
		let wire: UpdateState = { kind: "idle" };
		let checks = 0;
		try {
			const b = await boot(persistedDownloading, {
				...probe.deps,
				getPackageInstallWireState: () => wire,
				runPackageCheck: async () => {
					checks++;
					wire = DRILL_WIRE_AFTER_BOOT;
					return null;
				},
			});
			expect(getOrchestratorState().phase).toBe("downloading");

			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("downloading");
			await runOrchestratorTick();
			expect(probe.calls.count).toBe(3);
			expect(getOrchestratorState().phase).toBe("idle");
			expect(b.persisted.filter((phase) => phase === "idle")).toHaveLength(1);

			await runOrchestratorTick(); // discovery: available
			await runOrchestratorTick(); // packagesAuto: awaiting-idle
			await runOrchestratorTick(); // idle gate passes: install
			expect(checks).toBe(1);
			expect(b.installs.count).toBe(1);
			expect(getOrchestratorState().phase).toBe("downloading");
			expect(probe.calls.count).toBe(3);
			expect(await b.quarantine.readPending()).toEqual([
				{ name: "linux-cpupower", version: "6.12.111-1" },
			]);
			expect(
				notices.mock.calls.filter(([notice]) => notice.kind === "refused"),
			).toEqual([]);
		} finally {
			notices.mockRestore();
		}
	});

	test("probe throws, then reattaches a live unit: the normal poll path takes over and the marker is cleared", async () => {
		const probe = scriptedProbe(["throws", "attached"]);
		let wire: UpdateState = { kind: "idle" };
		const b = await boot(persistedDownloading, {
			...probe.deps,
			getPackageInstallWireState: () => wire,
		});
		wire = {
			kind: "downloading",
			progress: { total: 6, downloading: 3, unpacking: 0, setting_up: 0 },
		};
		await runOrchestratorTick();
		expect(probe.calls.count).toBe(2);
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(getOrchestratorState().progress?.percent).toBeGreaterThan(0);
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(probe.calls.count).toBe(2);
		expect(b.installs.count).toBe(0);
	});

	test("an ordinary download that was never deferred is not adjudicated for absence on its ticks", async () => {
		const probe = scriptedProbe(["attached", "absent"]);
		let wire: UpdateState = {
			kind: "downloading",
			progress: { total: 6, downloading: 1, unpacking: 0, setting_up: 0 },
		};
		await boot(persistedDownloading, {
			...probe.deps,
			getPackageInstallWireState: () => wire,
		});
		wire = DRILL_WIRE_AFTER_BOOT;
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(probe.calls.count).toBe(1);
		expect(getOrchestratorState().phase).toBe("downloading");
	});

	test("a deferral never applies to a NEW download started after the deferred one was aborted", async () => {
		const probe = scriptedProbe(["not-probed", "absent"]);
		let wire: UpdateState = { kind: "idle" };
		let stops = 0;
		const b = await boot(persistedDownloading, {
			...probe.deps,
			getPackageInstallWireState: () => wire,
			stopPackageInstallUnit: async () => {
				stops++;
			},
		});
		expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
		expect(stops).toBe(1);
		expect(getOrchestratorState().phase).toBe("available");

		wire = DRILL_WIRE_AFTER_BOOT;
		expect(await installUpdatesNow()).toEqual({ started: true });
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(b.installs.count).toBe(1);

		// The new unit is not created yet (launch acceptance only).
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(probe.calls.count).toBe(1);
		expect(getOrchestratorState().phase).toBe("downloading");
	});
});
