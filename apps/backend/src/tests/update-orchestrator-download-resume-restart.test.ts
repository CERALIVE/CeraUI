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
import {
	loadOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
} from "../modules/system/update-orchestrator/runtime.ts";
import { boot, dirs } from "./helpers/orchestrator-download-boot.ts";
import {
	DRILL_ENTERED_AT,
	DRILL_WIRE_AFTER_BOOT,
	NOTHING_ACTIONABLE,
	persistedDownloading,
} from "./helpers/orchestrator-download-inputs.ts";
import { scriptedProbe } from "./helpers/orchestrator-download-probes.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("trace 3 — a proven absence rediscovers instead of replaying the interrupted plan", () => {
	test("nothing left to install: back to idle with no failure, no install, no installed notice, no quarantine", async () => {
		const notices = spyOn(notifications, "notifyUpdate");
		const probe = scriptedProbe(["absent"]);
		let wire: UpdateState = { kind: "idle" };
		let checks = 0;
		try {
			const b = await boot(persistedDownloading, {
				...probe.deps,
				getPackageInstallWireState: () => wire,
				runPackageCheck: async () => {
					checks++;
					wire = NOTHING_ACTIONABLE;
					return null;
				},
				startPackageInstall: () => {
					// What the real launcher reports for an empty plan.
					wire = {
						kind: "failed",
						reason: "No actionable application packages are available.",
					};
					return { started: true };
				},
			});
			expect(getOrchestratorState().phase).toBe("idle");
			expect(getOrchestratorState().packageCheck.nextAttemptAt).toBe(
				DRILL_ENTERED_AT + 45_000,
			);

			for (let i = 0; i < 4; i++) await runOrchestratorTick();

			expect(checks).toBe(1);
			expect(getOrchestratorState().phase).toBe("idle");
			expect(getOrchestratorState().failureReason).toBeNull();
			expect(b.persisted).not.toContain("failed");
			expect(b.persisted).not.toContain("awaiting-idle");
			expect(b.persisted).not.toContain("restarting-services");
			const quarantined = await b.quarantine.read();
			expect(quarantined.packages).toEqual([]);
			expect(quarantined.failedCommits).toEqual([]);
			expect(
				notices.mock.calls.filter(
					([notice]) =>
						notice.kind === "installed" || notice.kind === "refused",
				),
			).toEqual([]);
		} finally {
			notices.mockRestore();
		}
	});

	test("packages still actionable: the normal available -> awaiting-idle path installs them", async () => {
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
		expect(getOrchestratorState().phase).toBe("idle");
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("available");
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(b.installs.count).toBe(1);
	});
});

describe("trace 4 — a restart at each step adjudicates idempotently", () => {
	test("restart while deferred: the second boot probes again and keeps the download", async () => {
		const first = scriptedProbe(["not-probed"]);
		await boot(persistedDownloading, {
			...first.deps,
			getPackageInstallWireState: () => ({ kind: "idle" }),
		});
		expect(getOrchestratorState().phase).toBe("downloading");
		const onDisk = await loadOrchestratorState();
		resetOrchestratorRuntimeForTest();

		const second = scriptedProbe(["not-probed"]);
		await boot(onDisk ?? persistedDownloading, {
			...second.deps,
			getPackageInstallWireState: () => ({ kind: "idle" }),
		});
		expect(second.calls.count).toBe(1);
		expect(getOrchestratorState().phase).toBe("downloading");
	});

	test("restart after the recovery: the persisted idle is not re-adjudicated and the due check still runs", async () => {
		const first = scriptedProbe(["absent"]);
		await boot(persistedDownloading, {
			...first.deps,
			getPackageInstallWireState: () => ({ kind: "idle" }),
		});
		expect(getOrchestratorState().phase).toBe("idle");
		const onDisk = await loadOrchestratorState();
		expect(onDisk?.phase).toBe("idle");
		resetOrchestratorRuntimeForTest();

		const second = scriptedProbe(["absent"]);
		let checks = 0;
		await boot(onDisk ?? persistedDownloading, {
			...second.deps,
			getPackageInstallWireState: () => ({ kind: "idle" }),
			runPackageCheck: async () => {
				checks++;
				return null;
			},
		});
		expect(second.calls.count).toBe(0);
		expect(getOrchestratorState().phase).toBe("idle");
		await runOrchestratorTick();
		expect(checks).toBe(1);
	});

	test("a crash before the recovered state is persisted re-adjudicates to the same answer", async () => {
		const first = scriptedProbe(["absent"]);
		await boot(persistedDownloading, {
			...first.deps,
			getPackageInstallWireState: () => ({ kind: "idle" }),
			persist: () => {},
		});
		const onDisk = await loadOrchestratorState();
		expect(onDisk?.phase).toBe("downloading");
		resetOrchestratorRuntimeForTest();

		const second = scriptedProbe(["absent"]);
		const b = await boot(onDisk ?? persistedDownloading, {
			...second.deps,
			getPackageInstallWireState: () => ({ kind: "idle" }),
		});
		expect((await loadOrchestratorState())?.phase).toBe("idle");
		expect(getOrchestratorState().phase).toBe("idle");
		expect(b.persisted).not.toContain("failed");
	});
});
