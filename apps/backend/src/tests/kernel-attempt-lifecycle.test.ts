import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelUpdateError } from "../modules/system/update-orchestrator/kernel-state.ts";
import {
	loadOrchestratorState,
	OrchestratorRecoveryLoadError,
	toPersisted,
} from "../modules/system/update-orchestrator/persistence.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { attemptB, attemptFixture } from "./helpers/kernel-attempt-fixture.ts";
import {
	kernelOverlay,
	kernelRecord,
	kernelState,
} from "./helpers/kernel-update-fixture.ts";

test("downloading B never borrows A's completed outcome or reason", async () => {
	const entered = Promise.withResolvers<void>();
	const downloaded = Promise.withResolvers<string>();
	const f = attemptFixture(
		{},
		{
			download: async () => {
				entered.resolve();
				return downloaded.promise;
			},
		},
	);
	await f.lane.reconcile();
	const installing = f.lane.install(true);
	await entered.promise;
	const summary = await f.lane.summary();
	downloaded.resolve("/var/tmp/fixture/kernel.deb");
	await installing;
	expect(summary).toMatchObject({
		state: null,
		version: attemptB.version,
		reason: null,
	});
});

test("cancelled B remains an offer, never A's success after reconciliation", async () => {
	const entered = Promise.withResolvers<void>();
	const downloaded = Promise.withResolvers<string>();
	const f = attemptFixture(
		{},
		{
			download: async () => {
				entered.resolve();
				return downloaded.promise;
			},
		},
	);
	await f.lane.reconcile();
	const installing = f.lane.install(true);
	await entered.promise;
	f.lane.cancelDownload();
	downloaded.resolve("/var/tmp/fixture/kernel.deb");
	expect(await installing).toBe(false);
	await f.lane.reconcile();
	expect(f.port.state().phase).toBe("idle");
	expect(await f.lane.summary()).toMatchObject({
		state: null,
		version: attemptB.version,
		reason: null,
		candidate: { version: attemptB.version },
	});
});

test.each([
	"staging",
	"staged",
	"armed",
	"activating",
	"activated",
	"succeeded",
	"rolled_back",
	"failed",
] as const)(
	"matching %s producer outcome stays bound to B's version and reason",
	async (outcome) => {
		const reason =
			outcome === "rolled_back"
				? "kernel_boot_failed"
				: outcome === "failed"
					? "kernel_staging_failed"
					: null;
		const record = {
			...kernelState,
			attempt: attemptB.id,
			version: attemptB.version,
			state: outcome,
			reason,
		};
		const f = attemptFixture(
			{ kernelAttempt: { ...attemptB, deb: "/var/tmp/fixture/kernel.deb" } },
			{
				readState: async () => record,
				readOverlay: async () => ({
					...kernelOverlay,
					attempt: attemptB.id,
					kernel: { ...kernelOverlay.kernel, version: attemptB.version },
					status: outcome === "succeeded" ? "confirmed" : "pending",
				}),
				readBooted: async () =>
					outcome === "succeeded"
						? { ...kernelRecord, version: attemptB.version }
						: kernelRecord,
			},
			outcome === "succeeded" ? "B" : "A",
		);
		await f.lane.reconcile();
		expect(await f.lane.summary()).toMatchObject({
			state: outcome,
			version: attemptB.version,
			reason,
			booted: {
				version:
					outcome === "succeeded" ? attemptB.version : kernelRecord.version,
			},
		});
	},
);

test.each([false, true])(
	"no attempt preserves device-record fallback, present=%s",
	async (present) => {
		const f = attemptFixture(
			{},
			{
				readState: async () =>
					present
						? { ...kernelState, state: "succeeded", acknowledged: true }
						: null,
			},
		);
		await f.lane.reconcile();
		expect(await f.lane.summary()).toMatchObject({
			state: present ? "succeeded" : null,
			version: present ? kernelRecord.version : null,
			reason: null,
		});
	},
);

test("two attempts with the same version are distinguished by attempt ID", async () => {
	const f = attemptFixture(
		{},
		{
			discover: async () => kernelRecord,
			download: async () => {
				throw new KernelUpdateError("kernel_download_failed");
			},
		},
	);
	await f.lane.reconcile();
	expect(await f.lane.install(true)).toBe(false);
	expect(f.port.state().kernelAttempt?.id).not.toBe(kernelState.attempt);
	await f.lane.reconcile();
	expect(await f.lane.summary()).toMatchObject({
		state: "failed",
		version: kernelRecord.version,
		reason: "kernel_download_failed",
	});
});

test("an ancient unmatched attempt never borrows a different device success", async () => {
	const f = attemptFixture(
		{ enteredAt: 0, kernelAttempt: attemptB },
		{
			readState: async () => ({
				...kernelState,
				version: "7.2.0-ceralive4",
				state: "succeeded",
				acknowledged: true,
			}),
			readBooted: async () => ({ ...kernelRecord, version: "7.2.0-ceralive4" }),
		},
	);
	await f.lane.reconcile();
	expect(await f.lane.summary()).toMatchObject({
		state: null,
		version: attemptB.version,
		reason: null,
		booted: { version: "7.2.0-ceralive4" },
	});
});

test("legacy interrupted downloads retain their own failure after returning idle", async () => {
	const f = attemptFixture({
		phase: "kernel-downloading",
		kernelAttempt: attemptB,
	});
	await f.lane.reconcile();
	await f.lane.reconcile();
	expect(f.port.state().phase).toBe("idle");
	expect(await f.lane.summary()).toMatchObject({
		state: "failed",
		version: attemptB.version,
		reason: "kernel_interrupted",
	});
});

test("a persisted attempt without a version is rejected, never repaired from A", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kernel-invalid-attempt-"));
	try {
		const file = join(directory, "agent.json");
		await writeFile(
			file,
			JSON.stringify({
				...toPersisted(initialOrchestratorState(0)),
				kernelAttempt: { ...attemptB, version: undefined },
			}),
		);
		await expect(loadOrchestratorState(file)).rejects.toBeInstanceOf(
			OrchestratorRecoveryLoadError,
		);
	} finally {
		await rm(directory, { recursive: true });
	}
});
