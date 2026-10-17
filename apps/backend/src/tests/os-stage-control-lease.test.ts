import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withOsStageControlLease } from "../modules/system/update-orchestrator/os-stage-control-lease.ts";
import { acquireOsOrphanLock } from "../modules/system/update-orchestrator/os-stage-orphan-lock.ts";

test("a second controller cannot enter while the first owns the real helper lease", async () => {
	const root = await mkdtemp(join(tmpdir(), "ceraui-control-lease-"));
	const acquire = () =>
		acquireOsOrphanLock({
			lock: join(root, "control.lock"),
			helper: join(
				import.meta.dir,
				"../../../../deployment/ceralive-os-stage-guard",
			),
		});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let secondEntered = false;
	const first = withOsStageControlLease(async (lease) => {
		entered.resolve();
		await release.promise;
		expect(lease.held()).toBe(true);
	}, acquire);
	try {
		await entered.promise;
		await expect(
			withOsStageControlLease(async () => {
				secondEntered = true;
			}, acquire),
		).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
		expect(secondEntered).toBe(false);
	} finally {
		release.resolve();
		await first;
		await rm(root, { recursive: true });
	}
});

test("an escaping controller failure releases its observer-only helper lease", async () => {
	const root = await mkdtemp(join(tmpdir(), "ceraui-control-lease-"));
	const acquire = () =>
		acquireOsOrphanLock({
			lock: join(root, "control.lock"),
			helper: join(
				import.meta.dir,
				"../../../../deployment/ceralive-os-stage-guard",
			),
		});
	try {
		await expect(
			withOsStageControlLease(async () => {
				throw new Error("controller failed");
			}, acquire),
		).rejects.toThrow("controller failed");
		expect(
			await withOsStageControlLease(async (lease) => lease.held(), acquire),
		).toBe(true);
	} finally {
		await rm(root, { recursive: true });
	}
});
