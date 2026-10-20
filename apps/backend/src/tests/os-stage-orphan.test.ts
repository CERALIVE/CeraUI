import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	prepareOsStageJob,
	readOsStageJob,
} from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import type { OsOrphanDeps } from "../modules/system/update-orchestrator/os-stage-orphan.ts";
import { osUpdateAdmissionReady } from "../modules/system/update-orchestrator/os-stage-startup.ts";
import { orphanHarness as harness } from "./helpers/os-stage-orphan-harness.ts";
import {
	absentUnit,
	exitedUnit,
	record,
} from "./helpers/os-stage-orphan-record.ts";
import { orphanBody } from "./helpers/os-stage-orphan-scope.ts";

test.each(["prelaunch", "released", "directory"] as const)(
	"startup safely settles the %s crash window and allows the next preparation",
	orphanBody(async (window) => {
		// Given a private orphan at the actual filesystem boundary, not a mocked owner verdict.
		const h = await harness(window);
		// When startup uses positive RAUC evidence under a real temp-path flock.
		await h.reconcile();
		// Then no install/restart occurs; next preparation no longer wedges on EEXIST.
		expect(h.effects).toEqual(
			window === "released"
				? ["sweep-under-flock", "stop-owned-exited-unit"]
				: ["sweep-under-flock"],
		);
		expect(osUpdateAdmissionReady()).toBe(true);
		await prepareOsStageJob(record, h.directory, h.uid);
		expect(h.lockReadings).toEqual([75]);
		expect((await readOsStageJob(h.directory, h.uid))?.attemptId).toBe(
			record.attemptId,
		);
		expect(await h.contender()).toBe(0);
	}),
);

for (const window of ["prelaunch", "released", "directory"] as const) {
	test.each([false, true])(
		`startup settles absent-unit ${window} with reordered=%s properties`,
		orphanBody(async (reordered) => {
			// Given an absent guardian's full show reply, including unrequested keys.
			const h = await harness(window);
			const rows = absentUnit().split("\n");
			h.setUnit((reordered ? rows.reverse() : rows).join("\n"));
			// When reconciliation proves writer retirement under the flock.
			await h.reconcile();
			// Then admission opens and a fresh preparation is possible.
			expect(h.effects).toEqual(["sweep-under-flock"]);
			expect(osUpdateAdmissionReady()).toBe(true);
			await prepareOsStageJob(record, h.directory, h.uid);
		}),
	);
}

test.each([
	"unreadable",
	"writer",
	"activated",
	"foreign",
	"malformed",
	"duplicate",
] as const)(
	"startup permanently refuses orphan retirement with %s proof",
	orphanBody(async (condition) => {
		const h = await harness("released");
		if (condition === "malformed") h.setUnit(`${absentUnit()}\nmalformed`);
		if (condition === "duplicate")
			h.setUnit(`${absentUnit()}\nLoadState=not-found`);
		if (condition === "foreign")
			h.setUnit(
				exitedUnit().replace("/run/systemd/transient/", "/etc/systemd/system/"),
			);
		const overrides: Partial<OsOrphanDeps> = {
			observe: async () =>
				condition === "unreadable"
					? null
					: condition === "activated"
						? { ...record.baseline, bootPrimary: "rootfs.0" }
						: record.baseline,
			cliGone: async () => condition !== "writer",
		};
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(h.reconcile(overrides)).rejects.toHaveProperty(
				"reason",
				"rauc_recovery_unproven",
			);
			expect(osUpdateAdmissionReady()).toBe(false);
		}
		expect(h.effects).toEqual([]);
		expect(await readOsStageJob(h.directory, h.uid)).not.toBeNull();
	}),
);

test(
	"orphan settlement cannot retire a live same-token guardian",
	orphanBody(async () => {
		const h = await harness("released");
		h.setUnit(exitedUnit().replace("MainPID=0", "MainPID=100"));
		await expect(h.orphan()).rejects.toHaveProperty(
			"reason",
			"rauc_recovery_unproven",
		);
		expect(h.effects).toEqual([]);
	}),
);

test(
	"a foreign file in a partial preparation directory is never swept or deleted",
	orphanBody(async () => {
		const h = await harness("directory");
		await Bun.write(join(h.directory, "foreign-data"), "untouched");
		await expect(h.reconcile()).rejects.toHaveProperty(
			"reason",
			"rauc_recovery_unproven",
		);
		expect(h.effects).toEqual([]);
		expect(await Bun.file(join(h.directory, "foreign-data")).text()).toBe(
			"untouched",
		);
	}),
);

test(
	"an existing real flock owner prevents all orphan effects",
	orphanBody(async () => {
		const h = await harness("prelaunch");
		await using owner = await h.acquireLock();
		await expect(h.reconcile()).rejects.toHaveProperty(
			"reason",
			"rauc_recovery_unproven",
		);
		expect(owner.held()).toBe(true);
		expect(h.effects).toEqual([]);
		expect(await h.contender()).toBe(75);
	}),
);

test(
	"a slot change during orphan pin sweep keeps the directory and admission closed",
	orphanBody(async () => {
		const h = await harness("prelaunch");
		let swept = false;
		await expect(
			h.reconcile({
				sweep: async () => {
					swept = true;
				},
				observe: async () =>
					swept
						? { ...record.baseline, bootPrimary: "rootfs.0" }
						: record.baseline,
			}),
		).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
		expect(osUpdateAdmissionReady()).toBe(false);
		expect(await readOsStageJob(h.directory, h.uid)).not.toBeNull();
	}),
);
