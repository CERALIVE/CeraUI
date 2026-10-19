import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import {
	fakeDeps,
	quarantineDirs,
	testQuarantine,
} from "./helpers/orchestrator-runtime-harness.ts";

const proof = {
	unitAbsent: true,
	packagesIdle: true,
	locksIdle: true,
	auditClean: true,
	updatesEmpty: true,
	bootId: "new-boot",
	slot: "rootfs.0",
};
const interrupted = {
	...initialOrchestratorState(100),
	phase: "failed" as const,
	failureReason: "commit_unit_absent_on_resume",
	packageAttempt: { bootId: "old-boot", slot: "rootfs.0" },
};
afterEach(() => {
	resetOrchestratorRuntimeForTest();
	for (const dir of quarantineDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
	for (const notice of getPersistentNotifications(true).show)
		if (notice.name.startsWith("update:packages-recovered:"))
			notificationRemove(notice.name);
});

async function arrange(evidence = proof) {
	const quarantine = testQuarantine();
	await quarantine.savePending([{ name: "cerastream", version: "2026.9.6" }]);
	const deps = fakeDeps({
		quarantine,
		...{ readPackageRecoveryEvidence: async () => evidence },
	});
	deps.persist(interrupted);
	setOrchestratorRuntimeDepsForTest(deps);
	setOrchestratorStateForTest(interrupted);
	return quarantine;
}

test("consistent interrupted package commit returns idle, drops the old plan and announces recovery, not installation", async () => {
	// Given a previous-boot interruption with every current consistency proof.
	const quarantine = await arrange();
	// When the periodic tick rechecks it.
	await runOrchestratorTick();
	// Then only fresh discovery is due; the old outcome remains unresolved.
	expect(getOrchestratorState()).toMatchObject({
		phase: "idle",
		failureReason: null,
		packageCheck: { nextAttemptAt: 1_000_000, lastSuccessAt: null },
	});
	expect(await quarantine.readPending()).toEqual([]);
	expect((await quarantine.read()).packages).toEqual([]);
	expect(
		getPersistentNotifications(true).show.some((n) =>
			n.name.startsWith("update:packages-recovered:"),
		),
	).toBe(true);
	expect(
		getPersistentNotifications(true).show.some((n) =>
			n.name.startsWith("update:installed:"),
		),
	).toBe(false);
});

for (const missing of [
	"unitAbsent",
	"packagesIdle",
	"locksIdle",
	"auditClean",
	"updatesEmpty",
] as const) {
	test(`package recovery stays failed without ${missing}`, async () => {
		// Given exactly one missing proof.
		const quarantine = await arrange({ ...proof, [missing]: false });
		// When recovery observes the system.
		await runOrchestratorTick();
		// Then it preserves failure and the original plan.
		expect(getOrchestratorState()).toEqual(interrupted);
		expect(await quarantine.readPending()).toHaveLength(1);
	});
}

test("same boot and same slot cannot clear an absent commit", async () => {
	// Given no reboot or fallback proof.
	await arrange({ ...proof, bootId: "old-boot" });
	// When the tick observes clean dpkg.
	await runOrchestratorTick();
	// Then absence still proves no outcome.
	expect(getOrchestratorState()).toEqual(interrupted);
});

test("a changed running slot permits consistent recovery even on the same boot identity", async () => {
	// Given positive changed-slot evidence.
	await arrange({ ...proof, bootId: "old-boot", slot: "rootfs.1" });
	// When the tick observes it.
	await runOrchestratorTick();
	// Then the old slot's plan is not replayed.
	expect(getOrchestratorState().phase).toBe("idle");
});

test("failed evidence reads are retried, never absence permission", async () => {
	// Given an unreadable probe followed by repaired evidence.
	const quarantine = await arrange();
	let unreadable = true;
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			quarantine,
			readPersistedState: async () => interrupted,
			...{
				readPackageRecoveryEvidence: async () => {
					if (unreadable) throw new Error("EIO");
					return proof;
				},
			},
		}),
	);
	// When two ticks straddle repair.
	await runOrchestratorTick();
	expect(getOrchestratorState()).toEqual(interrupted);
	unreadable = false;
	await runOrchestratorTick();
	// Then only the repaired fresh read clears failure.
	expect(getOrchestratorState().phase).toBe("idle");
});

test("old failed files without commit provenance stay loadable and fail closed", async () => {
	// Given the shipped shape, with no historical boot or slot evidence.
	await arrange();
	const { packageAttempt: _missing, ...legacy } = interrupted;
	setOrchestratorStateForTest(legacy);
	// When recovery runs.
	await runOrchestratorTick();
	// Then it does not manufacture a reboot.
	expect(getOrchestratorState()).toEqual(legacy);
});

for (const missing of ["bootId", "slot"] as const) {
	test(`package recovery refuses unreadable current ${missing}`, async () => {
		// Given an otherwise clean system with missing identity.
		await arrange({ ...proof, [missing]: "" });
		// When the tick observes it.
		await runOrchestratorTick();
		// Then it cannot borrow the other identity field's permission.
		expect(getOrchestratorState()).toEqual(interrupted);
	});
}

test("a newer authoritative state cannot borrow the old recovery proof", async () => {
	// Given a healthy proof but authoritative disk drift.
	const quarantine = await arrange();
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			quarantine,
			readPackageRecoveryEvidence: async () => proof,
			readPersistedState: async () => ({ ...interrupted, enteredAt: 200 }),
		}),
	);
	// When a tick attempts recovery.
	await runOrchestratorTick();
	// Then failure and the original plan remain untouched.
	expect(getOrchestratorState()).toEqual(interrupted);
	expect(await quarantine.readPending()).toHaveLength(1);
});

test("an install launch records the boot and slot it began on", async () => {
	// Given a pending install on a readable boot and running slot.
	const began = { bootId: "boot-a", slot: "rootfs.1" };
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			quarantine: testQuarantine(),
			readPackageAttempt: async () => began,
		}),
	);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "awaiting-idle",
	});
	// When the tick launches the install.
	await runOrchestratorTick();
	// Then a later restart can compare against where the commit began.
	expect(getOrchestratorState()).toMatchObject({
		phase: "downloading",
		packageAttempt: began,
	});
});

test("a lost update-lock lease withholds clearance and pending-plan deletion", async () => {
	// Given otherwise positive proof under a lease that is no longer held.
	const quarantine = await arrange();
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			quarantine,
			readPersistedState: async () => interrupted,
			readPackageRecoveryEvidence: async () => proof,
			acquireUpdateRecoveryLock: async () => ({
				held: () => false,
				async [Symbol.asyncDispose]() {},
			}),
		}),
	);
	// When the tick reaches its final lease fence.
	await runOrchestratorTick();
	// Then positive filesystem observations cannot replace exclusion.
	expect(getOrchestratorState()).toEqual(interrupted);
	expect(await quarantine.readPending()).toHaveLength(1);
});
