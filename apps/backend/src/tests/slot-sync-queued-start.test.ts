import { afterEach, describe, expect, test } from "bun:test";
import {
	classifySlotSyncProbe,
	type SlotSyncProbeState,
} from "../modules/system/update-orchestrator/lock.ts";
import {
	defaultOrchestratorRuntimeDeps,
	SLOT_SYNC_QUEUED_START_GRACE_MS as GRACE_MS,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import type { SlotSyncEvidence } from "../modules/system/update-orchestrator/slot-sync-gate.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { raucSlots } from "./helpers/slot-sync-rauc.ts";

// N1 (round 13): `systemctl start --no-block` can queue the job behind
// ceralive-healthcheck.service, so the unit keeps reading the PREVIOUS run's
// unloaded shape for a while. A poll in that window must not turn a mirror
// that has not started yet into a sticky failure.

const statusSha256 = "a".repeat(64);
const matching: SlotSyncEvidence = {
	healthyState: {
		boot_id: "boot-new",
		slot: "A",
		build_id: "build-new",
		dpkg_status_sha256: statusSha256,
		recorded_at: "2026-09-24T00:00:00Z",
	},
	bootId: "boot-new",
	statusSha256,
	buildId: "build-new",
	receiptStateSha256: statusSha256,
	receiptTargetsOtherSlot: true,
	receiptTargetSlot: "rootfs.1",
};
const nonMatching: ReadonlyArray<readonly [string, SlotSyncEvidence]> = [
	["missing", { ...matching, receiptStateSha256: null }],
	["wrong-sha", { ...matching, receiptStateSha256: "b".repeat(64) }],
	["wrong-target", { ...matching, receiptTargetsOtherSlot: false }],
];

const show = (props: Record<string, string>) => ({
	exitCode: 0,
	stdout: Object.entries(props)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n"),
});
// What a job still queued behind the healthcheck reads: the unit is not
// running yet and systemd has already unloaded the previous run.
const inactiveClean = show({
	LoadState: "loaded",
	ActiveState: "inactive",
	SubState: "dead",
	ExecMainCode: "0",
	ExecMainStatus: "0",
});
const running = show({
	LoadState: "loaded",
	ActiveState: "activating",
	SubState: "start",
	ExecMainCode: "0",
	ExecMainStatus: "0",
});
const notFound = show({ LoadState: "not-found" });
type Show = ReturnType<typeof show>;

afterEach(() => resetOrchestratorRuntimeForTest());

function harness(start: {
	now: number;
	unit: Show;
	evidence: SlotSyncEvidence;
}) {
	const cleanup: string[] = [];
	const phases: string[] = [];
	const probes: SlotSyncProbeState["kind"][] = [];
	let now = start.now;
	let unit = start.unit;
	let evidence = start.evidence;
	let evidenceHook: (() => Promise<SlotSyncEvidence>) | undefined;
	setOrchestratorRuntimeDepsForTest({
		...defaultOrchestratorRuntimeDeps,
		now: () => now,
		loadCapabilities: async () => ({
			mode: "capable" as const,
			features: ["apt-all-packages", "slot-sync"] as (
				| "apt-all-packages"
				| "slot-sync"
			)[],
		}),
		isStreamLive: () => false,
		inspectSlotSync: async () => {
			const probe = classifySlotSyncProbe(unit);
			probes.push(probe.kind);
			return probe;
		},
		readSlotSyncEvidence: () => evidenceHook?.() ?? Promise.resolve(evidence),
		readRootSlots: async () => raucSlots("A"),
		resetSlotSyncFailure: async () => {},
		cleanSlotSyncArchives: async () => {
			cleanup.push("apt");
			return true;
		},
		removeRaucDownloads: async () => {
			cleanup.push("downloads");
		},
		dropSupersededQuarantine: async () => {
			cleanup.push("quarantine");
		},
		refreshSlots: async () => {
			cleanup.push("slots");
		},
		persist: (next) => {
			phases.push(next.phase);
		},
	});
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "syncing",
	});
	return {
		cleanup,
		phases,
		probes,
		set(next: { now?: number; unit?: Show; evidence?: SlotSyncEvidence }) {
			now = next.now ?? now;
			unit = next.unit ?? unit;
			evidence = next.evidence ?? evidence;
		},
		// The first evidence read hangs until the test releases it, after the
		// unit has moved on: the oracle's deferred-read interleaving.
		deferFirstRead(): {
			readonly started: () => boolean;
			readonly release: (value: SlotSyncEvidence) => void;
		} {
			let reads = 0;
			let release: ((value: SlotSyncEvidence) => void) | undefined;
			const pending = new Promise<SlotSyncEvidence>((resolve) => {
				release = resolve;
			});
			evidenceHook = () => {
				reads++;
				return reads === 1 ? pending : Promise.resolve(evidence);
			};
			return {
				started: () => reads > 0,
				release: (value) => release?.(value),
			};
		},
	};
}

async function tickWithDeferredEvidence(
	h: ReturnType<typeof harness>,
	late: SlotSyncEvidence,
): Promise<void> {
	const deferred = h.deferFirstRead();
	const tick = runOrchestratorTick();
	while (!deferred.started()) await Bun.sleep(0);
	// The queued job starts while the stale snapshot is being read.
	h.set({ unit: running });
	deferred.release(late);
	await tick;
}

describe("N1: a queued or not-yet-started unit is never terminalized from non-matching evidence", () => {
	for (const [label, late] of nonMatching) {
		test(`inside the grace: a ${label} receipt read while the unit starts leaves it syncing, and it then settles`, async () => {
			const h = harness({ now: 4_000, unit: inactiveClean, evidence: late });
			await tickWithDeferredEvidence(h, late);
			expect(getOrchestratorState().phase).toBe("syncing");
			expect(getOrchestratorState().failureReason).toBeNull();

			h.set({ now: 60_000, unit: inactiveClean, evidence: matching });
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("synced");
			expect(h.phases).not.toContain("failed");
		});

		test(`after the grace: a ${label} receipt is re-probed and a unit that started meanwhile keeps syncing`, async () => {
			const h = harness({
				now: GRACE_MS + 5_000,
				unit: inactiveClean,
				evidence: late,
			});
			await tickWithDeferredEvidence(h, late);
			expect(getOrchestratorState().phase).toBe("syncing");
			expect(h.probes).toEqual(["inactive-clean", "running"]);

			h.set({ unit: inactiveClean, evidence: matching });
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("synced");
			expect(h.phases).not.toContain("failed");
		});
	}

	test("a job queued behind the healthcheck reads inactive-clean for several ticks, then runs and settles synced", async () => {
		const h = harness({
			now: 3_000,
			unit: inactiveClean,
			evidence: { ...matching, receiptStateSha256: null },
		});
		for (const now of [3_000, 6_000, 30_000, 60_000, GRACE_MS - 1]) {
			h.set({ now });
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("syncing");
		}
		h.set({ now: GRACE_MS + 3_000, unit: running });
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("syncing");
		h.set({ now: GRACE_MS + 6_000, unit: inactiveClean, evidence: matching });
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("synced");
		expect(h.phases).not.toContain("failed");
		expect(h.cleanup).toEqual(["apt", "downloads", "quarantine", "slots"]);
	});

	test("an absent read inside the grace waits; the same read after it fails as before", async () => {
		const h = harness({ now: 4_000, unit: notFound, evidence: matching });
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("syncing");
		h.set({ now: GRACE_MS });
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe("slot-sync-unit-absent");
	});

	test("after the grace an inactive-clean unit with no receipt still fails as unit-absent", async () => {
		const h = harness({
			now: GRACE_MS,
			unit: inactiveClean,
			evidence: { ...matching, receiptStateSha256: null },
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe("slot-sync-unit-absent");
		expect(h.probes).toEqual(["inactive-clean", "inactive-clean"]);
		expect(h.cleanup).toEqual([]);
	});

	test("after the grace a terminal re-probe judges the FRESH receipt, never the older snapshot", async () => {
		const stale = { ...matching, receiptStateSha256: null };
		const h = harness({
			now: GRACE_MS + 1_000,
			unit: inactiveClean,
			evidence: stale,
		});
		const deferred = h.deferFirstRead();
		const tick = runOrchestratorTick();
		while (!deferred.started()) await Bun.sleep(0);
		// The run completed (receipt, mark-good, exit) while the old read hung.
		h.set({ evidence: matching });
		deferred.release(stale);
		await tick;
		expect(getOrchestratorState().phase).toBe("syncing");
		expect(getOrchestratorState().failureReason).toBeNull();
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("synced");
	});

	test("a clock that stepped behind the start gives no bound, so it counts as past the grace", async () => {
		const h = harness({
			now: -1_000,
			unit: inactiveClean,
			evidence: { ...matching, receiptStateSha256: null },
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
		expect(h.cleanup).toEqual([]);
	});
});
