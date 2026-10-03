import { afterEach, expect, test } from "bun:test";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import {
	osUpdateAdmissionReady,
	reconcileOsStageStartup,
} from "../modules/system/update-orchestrator/os-stage-startup.ts";
import { cleanupRecovery } from "./helpers/os-recovery-harness.ts";
import { harness, record } from "./helpers/os-stage-startup-harness.ts";

afterEach(cleanupRecovery);

test("startup retains the live pin through the captured recovery and never replays install", async () => {
	// Given a live owned guardian survives backend death with its old pin still present.
	const h = harness();
	// When startup replays the captured 315-second daemon/resource retirement.
	const result = await reconcileOsStageStartup(h.deps);
	// Then readiness follows proof, drain, sweep and release; the outcome remains unknown, never staged.
	expect(h.now()).toBe(315000);
	expect(h.calls).toEqual([
		"restart-submission",
		"settled",
		"drain",
		"sweep",
		"release",
	]);
	expect(result).toEqual({
		kind: "reconciled",
		attemptId: record.attemptId,
		reason: "os_stage_outcome_unknown_after_restart",
	});
	expect(osUpdateAdmissionReady()).toBe(true);
});

test("a foreign same-named unit without a private record is never swept, adopted or stopped", async () => {
	// Given a loaded foreign unit and no matching root-owned token record.
	const h = harness();
	// When startup inspects it.
	await expect(
		reconcileOsStageStartup({ ...h.deps, readJob: async () => null }),
	).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
	// Then control readiness can continue, but update admission remains closed with no effects.
	expect(h.calls).toEqual([]);
	expect(osUpdateAdmissionReady()).toBe(false);
});

test("inconclusive recovery expires unsafe without sweeping or releasing", async () => {
	// Given even a new daemon retains the old attempt's mount.
	const h = harness();
	// When the six-minute recovery window expires.
	await expect(
		reconcileOsStageStartup({
			...h.deps,
			cliGone: async () => true,
			observe: async () => ({
				...record.baseline,
				instance: "new:100",
				processes: ["new:100"],
				resources: ["mount:51"],
			}),
		}),
	).rejects.toMatchObject({ reason: "rauc_recovery_unproven", mode: "unsafe" });
	// Then the pin and lock remain owned rather than enabling another writer.
	expect(h.calls).toEqual(["restart-submission"]);
	expect(osUpdateAdmissionReady()).toBe(false);
	expect(h.now()).toBe(360000);
});

test("unprovable guardian identity causes no daemon termination", async () => {
	// Given a private record whose unit cannot be proved ours.
	const h = harness();
	// When the owner inspection refuses adoption.
	await expect(
		reconcileOsStageStartup({
			...h.deps,
			owner: (value) => ({
				...h.deps.owner(value),
				held: async () => {
					throw new OsStageError("rauc_recovery_unproven");
				},
			}),
		}),
	).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
	// Then no foreign service or live pin is touched.
	expect(h.calls).toEqual([]);
});

test("positive absence of both job and guardian permits ordinary startup sweep", async () => {
	// Given there is no prior OS job, when startup reads positive unit absence.
	const h = harness();
	expect(
		await reconcileOsStageStartup({
			...h.deps,
			readJob: async () => null,
			run: async () => ({
				exitCode: 0,
				stdout: "LoadState=not-found\n",
				stderr: "",
			}),
		}),
	).toEqual({ kind: "none" });
	// Then only the ordinary sweep runs and admission opens.
	expect(h.calls).toEqual(["sweep"]);
	expect(osUpdateAdmissionReady()).toBe(true);
});

test("a new owned residue after sweep withholds lock release", async () => {
	const h = harness();
	await expect(
		reconcileOsStageStartup({
			...h.deps,
			observe: async () => ({
				...record.baseline,
				instance: "new:100",
				processes: ["new:100"],
				resources: h.calls.includes("sweep") ? ["mount:51"] : [],
			}),
			cliGone: async () => true,
		}),
	).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
	expect(h.calls).not.toContain("release");
	expect(osUpdateAdmissionReady()).toBe(false);
});

test("a pre-launch record without readable private directory proof remains closed", async () => {
	const h = harness();
	await expect(
		reconcileOsStageStartup({
			...h.deps,
			readJob: async () => ({ ...record, launched: false }),
			owner: (value) => ({ ...h.deps.owner(value), held: async () => false }),
		}),
	).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
	expect(h.calls).toEqual([]);
});
