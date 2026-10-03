import { afterEach, describe, expect, test } from "bun:test";
import { classifySlotSyncProbe } from "../modules/system/update-orchestrator/lock.ts";
import {
	defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	parseBothSlotStatus,
	type RootSlotStatus,
} from "../modules/system/update-orchestrator/slot-status.ts";
import type { SlotSyncEvidence } from "../modules/system/update-orchestrator/slot-sync-gate.ts";
import {
	classifyReceiptTarget,
	parseRaucSlotBootnames,
} from "../modules/system/update-orchestrator/slot-sync-state.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";

// N2 (round 13): two clean unit reads plus a surviving receipt cannot prove
// that the previous boot's mirror reached `rauc status mark-good other`. The
// unit writes the receipt, then marks the target good, then exits; a power
// loss between the first two steps leaves a matching receipt and a target
// slot that RAUC reports `bad`, and after the reboot the unit reads
// loaded/inactive/dead 0/0 (not run this boot).

// Byte-for-byte RAUC 1.15 capture from a Rock 5B+: rootfs.1 (B) booted,
// rootfs.0 (A) inactive and good.
const raucJson = await Bun.file(
	`${import.meta.dir}/fixtures/rauc/status-detailed-rock-5b-plus-rauc-1.15.txt`,
).text();
const withTargetStatus = (bootStatus: string): string => {
	const document = JSON.parse(raucJson) as {
		slots: Array<Record<string, { boot_status: string | null }>>;
	};
	for (const item of document.slots) {
		const target = item["rootfs.0"];
		if (target) target.boot_status = bootStatus;
	}
	return JSON.stringify(document);
};
const targetGood = parseBothSlotStatus(raucJson, null);
const targetBad = parseBothSlotStatus(withTargetStatus("bad"), null);

const statusSha256 = "a".repeat(64);
const bootId = "045961b0-a77f-48c1-b649-c7b5d180f1a7";
const mirroredIntoA: SlotSyncEvidence = {
	healthyState: {
		boot_id: bootId,
		slot: "B",
		build_id: "build",
		dpkg_status_sha256: statusSha256,
		recorded_at: "2026-09-30T11:33:49Z",
	},
	bootId,
	statusSha256,
	buildId: "build",
	receiptStateSha256: statusSha256,
	receiptTarget: "other",
	receiptTargetSlot: "rootfs.0",
};

// The unit after a reboot: installed, never run this boot.
const notRunThisBoot = {
	exitCode: 0,
	stdout: [
		"LoadState=loaded",
		"ActiveState=inactive",
		"SubState=dead",
		"ExecMainCode=0",
		"ExecMainStatus=0",
	].join("\n"),
};

afterEach(() => resetOrchestratorRuntimeForTest());

// Ten days after the mirror started: far past any queued-start grace.
const REBOOT_NOW = 10 * 24 * 60 * 60_000;

function harness(options: {
	readonly slots: () => Promise<readonly RootSlotStatus[]>;
	readonly evidence?: SlotSyncEvidence;
}) {
	const cleanup: string[] = [];
	const persisted: { phase: string; failureReason: string | null }[] = [];
	let slotReads = 0;
	setOrchestratorRuntimeDepsForTest({
		...defaultOrchestratorRuntimeDeps,
		now: () => REBOOT_NOW,
		inspectSlotSync: async () => classifySlotSyncProbe(notRunThisBoot),
		readSlotSyncEvidence: async () => options.evidence ?? mirroredIntoA,
		readRootSlots: async () => {
			slotReads++;
			return options.slots();
		},
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
			persisted.push({
				phase: next.phase,
				failureReason: next.failureReason,
			});
		},
	});
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "syncing",
	});
	return { cleanup, persisted, slotReads: () => slotReads };
}

describe("N2: success needs the CURRENT boot's facts and a good mirror target", () => {
	test("a surviving receipt with the target slot bad is an interrupted mark-good, persisted first", async () => {
		const h = harness({ slots: async () => targetBad });
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe("slot-sync-incomplete");
		expect(h.persisted[0]).toEqual({
			phase: "failed",
			failureReason: "slot-sync-incomplete",
		});
		expect(h.persisted.map((entry) => entry.phase)).not.toContain("synced");
		expect(h.cleanup).toEqual([]);
	});

	test("the target's RAUC state decides before success, not the refresh that runs after it", async () => {
		// The old flow read refreshSlots only AFTER persisting synced; the
		// verdict must come from a read taken before it.
		const h = harness({ slots: async () => targetBad });
		await runOrchestratorTick();
		expect(h.slotReads()).toBe(1);
		expect(h.cleanup).not.toContain("slots");
	});

	test("a previous boot's healthy record cannot name the other slot", () => {
		const bootnames = parseRaucSlotBootnames(
			"[slot.rootfs.0]\nbootname=A\n[slot.rootfs.1]\nbootname=B\n",
		);
		// The record says A was booted, but it is from the previous boot; the
		// board now runs B, so rootfs.1 is the booted slot, not the other one.
		const stale = {
			boot_id: "previous-boot",
			slot: "A",
			build_id: "build",
			dpkg_status_sha256: statusSha256,
			recorded_at: "2026-09-29T00:00:00Z",
		};
		const receipt = { target_slot: "rootfs.1" };
		expect(
			classifyReceiptTarget({
				receipt,
				healthyState: stale,
				bootId: "current-boot",
				bootnames,
			}),
		).not.toBe("other");
		expect(
			classifyReceiptTarget({
				receipt,
				healthyState: { ...stale, boot_id: "current-boot" },
				bootId: "current-boot",
				bootnames,
			}),
		).toBe("other");
	});

	test("the real shape: inactive slot good, receipt naming it, clean fresh probe settles synced", async () => {
		for (const receiptTargetSlot of ["rootfs.0", "A"]) {
			resetOrchestratorRuntimeForTest();
			const h = harness({
				slots: async () => targetGood,
				evidence: { ...mirroredIntoA, receiptTargetSlot },
			});
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("synced");
			expect(h.cleanup).toEqual(["apt", "downloads", "quarantine", "slots"]);
		}
	});

	test("RAUC that cannot be read gives no verdict: stays syncing, then settles once readable", async () => {
		let readable = false;
		const h = harness({
			slots: async () => {
				if (!readable) throw new Error("rauc status failed");
				return targetGood;
			},
		});
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("syncing");
		expect(getOrchestratorState().failureReason).toBeNull();
		expect(h.cleanup).toEqual([]);
		readable = true;
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("synced");
	});

	test("an undecidable slot shape gives no verdict", async () => {
		const booted = targetGood.find((slot) => slot.state === "booted");
		const shapes: ReadonlyArray<readonly RootSlotStatus[]> = [
			[],
			booted ? [booted] : [],
			targetGood.map((slot) => ({ ...slot, state: "booted" })),
			targetGood.map((slot) =>
				slot.state === "inactive" ? { ...slot, bootStatus: null } : slot,
			),
		];
		for (const shape of shapes) {
			resetOrchestratorRuntimeForTest();
			const h = harness({ slots: async () => shape });
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("syncing");
			expect(h.cleanup).toEqual([]);
		}
	});

	test("a receipt naming the BOOTED slot never settles synced", async () => {
		for (const receiptTargetSlot of ["rootfs.1", "B", null]) {
			resetOrchestratorRuntimeForTest();
			const h = harness({
				slots: async () => targetGood,
				evidence: { ...mirroredIntoA, receiptTargetSlot },
			});
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).not.toBe("synced");
			expect(h.cleanup).toEqual([]);
		}
	});
});

// Enumerating pollSlotSync's awaits against a reboot: the new boot's
// healthcheck rewrites healthy-state.json only after the backend is up, so the
// first polls of a resumed `syncing` phase read the PREVIOUS boot's record.
describe("a resumed mirror is judged by this boot's RAUC facts, not by a previous boot's record", () => {
	const previousBoot = {
		...mirroredIntoA,
		healthyState: mirroredIntoA.healthyState
			? { ...mirroredIntoA.healthyState, boot_id: "previous-boot" }
			: null,
		receiptTarget: "unknown" as const,
	};

	test("a mirror that finished before the reboot settles synced once RAUC shows the target good", async () => {
		const h = harness({
			slots: async () => targetGood,
			evidence: previousBoot,
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("synced");
		expect(h.cleanup).toEqual(["apt", "downloads", "quarantine", "slots"]);
	});

	test("a mirror whose mark-good was lost is slot-sync-incomplete, not unit-absent", async () => {
		harness({ slots: async () => targetBad, evidence: previousBoot });
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe("slot-sync-incomplete");
	});

	test("a receipt RAUC shows naming the now-booted slot fails once, without looping", async () => {
		const h = harness({
			slots: async () => targetGood,
			evidence: { ...previousBoot, receiptTargetSlot: "rootfs.1" },
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe("slot-sync-unit-absent");
		expect(h.cleanup).toEqual([]);
	});

	test("a bad target read while the unit runs again is not called incomplete", async () => {
		let probes = 0;
		const h = harness({ slots: async () => targetBad });
		setOrchestratorRuntimeDepsForTest({
			...defaultOrchestratorRuntimeDeps,
			now: () => REBOOT_NOW,
			inspectSlotSync: async () => {
				probes++;
				// Clean for the first two reads, then a re-run has started and is
				// rewriting (so un-marking) the target.
				return probes <= 2
					? classifySlotSyncProbe(notRunThisBoot)
					: { kind: "running" };
			},
			readSlotSyncEvidence: async () => mirroredIntoA,
			readRootSlots: async () => targetBad,
			persist: () => {},
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("syncing");
		expect(probes).toBe(3);
		expect(h.cleanup).toEqual([]);
	});
});
