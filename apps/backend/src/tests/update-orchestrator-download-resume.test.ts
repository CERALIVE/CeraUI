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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateState } from "@ceraui/rpc/schemas";
import { setup } from "../modules/setup.ts";
import {
	recoverSoftwareUpdateIfRunning,
	resetSoftwareUpdateState,
} from "../modules/system/software-updates.ts";
import * as notifications from "../modules/system/update-orchestrator/notifications.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	admitAndPrepareStreamStart,
	defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	installUpdatesNow,
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

type ProbeOutcome = "attached" | "absent" | "not-probed" | "throws";

/**
 * Stands in for the boot recovery call plus the verdict its probe left behind.
 * `not-probed` is what the real call answers when it never looked (updates
 * disabled, mocks, already observing a transaction): `false`, like `absent`.
 */
function scriptedProbe(outcomes: readonly ProbeOutcome[]) {
	const calls = { count: 0 };
	let last: "attached" | "absent" | "not-probed" = "not-probed";
	return {
		calls,
		deps: {
			recoverSoftwareUpdateIfRunning: async () => {
				const outcome =
					outcomes[Math.min(calls.count, outcomes.length - 1)] ?? "not-probed";
				calls.count++;
				last = "not-probed";
				if (outcome === "throws") throw new Error("systemctl show: unreadable");
				last = outcome;
				return outcome === "attached";
			},
			lastInstallUnitVerdict: () => last,
		} as Partial<OrchestratorRuntimeDeps>,
	};
}

const NOTHING_ACTIONABLE: UpdateState = {
	kind: "available",
	identity: {
		version: "0b1c2d3e4f50",
		packages: ["gstreamer1.0-rockchip-ceralive"],
	},
	package_count: 1,
	actionable_count: 0,
	packages: [
		{
			name: "gstreamer1.0-rockchip-ceralive",
			version: "1.14.4+ceralive.8",
			layer: "platform",
			actionable: false,
		},
	],
};

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
			// the next install start comes through discovery and overwrites it.
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

// ─── round 18: the deferred adjudication is fenced by a state generation ────

/** Like scriptedProbe, but call number `gatedCall` (1-based) waits for `release()`. */
function gatedProbe(outcomes: readonly ProbeOutcome[], gatedCall: number) {
	const scripted = scriptedProbe(outcomes);
	const recover = scripted.deps.recoverSoftwareUpdateIfRunning;
	let release: () => void = () => {};
	let markEntered: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		markEntered = resolve;
	});
	return {
		calls: scripted.calls,
		release: () => release(),
		entered,
		deps: {
			...scripted.deps,
			recoverSoftwareUpdateIfRunning: async () => {
				if (scripted.calls.count + 1 === gatedCall) {
					markEntered();
					await gate;
				}
				return (await recover?.()) ?? false;
			},
		} as Partial<OrchestratorRuntimeDeps>,
	};
}

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

// ─── round 19: a non-available wire at install start keeps the record ──────

const CPUPOWER_PLAN = [{ name: "linux-cpupower", version: "6.12.111-1" }];
const DOWNLOADING_WIRE: UpdateState = {
	kind: "downloading",
	progress: { total: 1, downloading: 1, unpacking: 0, setting_up: 0 },
	identity: DRILL_WIRE_AFTER_BOOT.identity,
};
const INSTALLING_WIRE: UpdateState = {
	kind: "installing",
	progress: { total: 1, downloading: 0, unpacking: 1, setting_up: 0 },
	identity: DRILL_WIRE_AFTER_BOOT.identity,
};

/**
 * Restart while `awaiting-idle` with plan A on disk: the wire is process-local,
 * so it reads `idle` until rediscovery; the launcher then rediscovers A itself.
 */
async function bootAwaitingIdleWithCpupowerPlan() {
	let wire: UpdateState = { kind: "idle" };
	const b = await boot(
		{ ...persistedDownloading, phase: "awaiting-idle", progress: null },
		{
			recoverSoftwareUpdateIfRunning: async () => false,
			getPackageInstallWireState: () => wire,
			startPackageInstall: () => {
				wire = DOWNLOADING_WIRE;
				return { started: true };
			},
			restartStale: async () => true,
		},
	);
	await b.quarantine.savePending(CPUPOWER_PLAN);
	return {
		quarantine: b.quarantine,
		setWire: (next: UpdateState) => {
			wire = next;
		},
	};
}

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
