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
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateState } from "@ceraui/rpc/schemas";
import * as notifications from "../modules/system/update-orchestrator/notifications.ts";
import {
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	type OrchestratorRuntimeDeps,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	initialOrchestratorState,
	type OrchestratorPhase,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";

// From 46.5-power/10-product-log.txt: the persisted agent.json after the cut.
const DRILL_ENTERED_AT = 1790810755027;
// Verbatim pending-packages.json from 46.5-power/07-postcut-state.txt.
const DRILL_PENDING = [
	{ name: "rsync", version: "3.5.0+ds1-0+deb13u1" },
	{ name: "libcpupower1", version: "6.12.111-1" },
	{ name: "libcups2t64", version: "2.4.10-3+deb13u2" },
	{ name: "libxml2", version: "2.12.7+dfsg+really2.9.14-2.1+deb13u3" },
	{ name: "libxslt1.1", version: "1.1.35-1.2+deb13u3" },
	{ name: "linux-cpupower", version: "6.12.111-1" },
];
// From 46.5-power/11-rpc-after-boot.txt: the wire after the reboot.
const DRILL_WIRE_AFTER_BOOT: UpdateState = {
	kind: "available",
	identity: { version: "10abce4f001d", packages: ["linux-cpupower"] },
	package_count: 1,
	actionable_count: 1,
	packages: [
		{
			name: "linux-cpupower",
			version: "6.12.111-1",
			layer: "app",
			actionable: true,
		},
	],
};

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ceraui-download-resume-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

interface Boot {
	readonly quarantine: UpdateQuarantine;
	readonly persisted: OrchestratorPhase[];
	readonly installs: { count: number };
}

async function boot(
	persisted: OrchestratorState,
	overrides: Partial<OrchestratorRuntimeDeps>,
): Promise<Boot> {
	const dir = tempDir();
	setOrchestratorStateFilePathForTest(join(dir, "agent.json"));
	saveOrchestratorState(persisted);
	const quarantine = new UpdateQuarantine(
		join(dir, "quarantine.json"),
		async () => {},
	);
	await quarantine.savePending(DRILL_PENDING);
	const phases: OrchestratorPhase[] = [];
	const installs = { count: 0 };
	await startUpdateOrchestrator({
		...defaultOrchestratorRuntimeDeps,
		now: () => DRILL_ENTERED_AT + 45_000,
		random: () => 0.5,
		loadSettings: async () => ({
			packagesAuto: true,
			systemAuto: true,
			schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
			channel: "stable",
			allowPackagesOverCellular: true,
			allowSystemOverCellular: false,
		}),
		loadCapabilities: async () => ({ mode: "legacy", features: [] }),
		isIdle: async () => true,
		isStreamLive: () => false,
		onlyMeteredCandidateExists: async () => false,
		isCommitStageRunning: async () => false,
		startPackageInstall: () => {
			installs.count++;
			return { started: true };
		},
		inspectSlotSync: async () => ({ kind: "absent" }),
		quarantine,
		persist: (state) => {
			phases.push(state.phase);
			saveOrchestratorState(state);
		},
		...overrides,
	});
	return { quarantine, persisted: phases, installs };
}

const persistedDownloading: OrchestratorState = {
	...initialOrchestratorState(1),
	phase: "downloading",
	enteredAt: DRILL_ENTERED_AT,
	progress: { percent: 0, etaSeconds: 0 },
};

describe("resume of a persisted download whose unit is gone (opi r5x X1 replay)", () => {
	test("returns to awaiting-idle with the pending record intact, then the next tick installs again", async () => {
		const notices = spyOn(notifications, "notifyUpdate");
		try {
			const b = await boot(persistedDownloading, {
				recoverSoftwareUpdateIfRunning: async () => false,
				getPackageInstallWireState: () => DRILL_WIRE_AFTER_BOOT,
			});

			const resumed = getOrchestratorState();
			expect(resumed.phase).toBe("awaiting-idle");
			expect(resumed.failureReason).toBeNull();
			expect(resumed.progress).toBeNull();
			expect(b.persisted).toEqual(["awaiting-idle"]);
			expect(await b.quarantine.readPending()).toEqual(DRILL_PENDING);
			const quarantined = await b.quarantine.read();
			expect(quarantined.packages).toEqual([]);
			expect(quarantined.failedCommits).toEqual([]);
			expect(
				notices.mock.calls.filter(([notice]) => notice.kind === "refused"),
			).toEqual([]);

			await runOrchestratorTick();

			expect(b.installs.count).toBe(1);
			expect(getOrchestratorState().phase).toBe("downloading");
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
