import { expect, test } from "bun:test";
import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { isOwnedOsStageGuard } from "../modules/system/update-orchestrator/os-stage-job.ts";
import {
	OS_STAGE_GUARD_UNIT,
	type OsStageJobRecord,
	readOsJobFile,
	readOsStageJob,
	writePrivateOsJobFile,
} from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { guardTest, guardUnit } from "./helpers/os-guard-harness.ts";

const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const baseline = {
	instance: "659:10",
	active: true,
	operation: "idle",
	processes: ["659:10"],
	resources: [],
	bootId: "boot-B",
	bootPrimary: "rootfs.1",
	bootedSlot: "rootfs.1",
	bootedDevice: "179:5",
	bootedHealthy: true,
	targetSlot: "rootfs.0",
	targetDevice: "179:4",
	targetInactive: true,
	activationArmed: false,
};
const record: OsStageJobRecord = {
	schema: 1,
	attemptId: token,
	candidateKey: "candidate-sha",
	bundleUrl:
		"https://images.ceralive.tv/releases/rock-5b-plus/2026.10.51/bundle.raucb",
	baseline,
	processes: baseline.processes,
	resources: [],
	launched: false,
	cliSettled: true,
	requireNewInstance: false,
};
guardTest(
	"each new pair records its current daemon before launch without releasing flock",
	record,
	async (h) => {
		await h.owner.acquire();
		h.owner.remember({ ...baseline, resources: ["mount:old"] }, true, true);
		const next = {
			...baseline,
			instance: "371279:99",
			processes: ["371279:99"],
		};
		h.owner.beginAttempt(next, "eth0/4");
		expect(await readOsStageJob(h.directory, process.getuid?.())).toMatchObject(
			{
				baseline: next,
				pair: "eth0/4",
				processes: next.processes,
				resources: [],
				launched: true,
				cliSettled: false,
			},
		);
		expect(await h.contender()).toBe(75);
		h.owner.remember(next, true, true);
		await h.owner.release(next, true);
	},
);

guardTest(
	"settlement callback runs under flock before the safe release acknowledgement",
	record,
	async (h) => {
		await h.owner.acquire();
		let invoked = false;
		await h.owner.release(baseline, true, () => {
			invoked = true;
			expect(h.owner.record().attemptId).toBe(token);
		});
		expect(invoked).toBe(true);
		expect(await h.contender()).toBe(0);
	},
);

guardTest(
	"a refused settlement callback never acknowledges release",
	record,
	async (h) => {
		await h.owner.acquire();
		await expect(
			h.owner.release(baseline, true, () => {
				throw new Error("fenced settlement");
			}),
		).rejects.toThrow("fenced settlement");
		expect(
			await readOsJobFile("release", h.directory, process.getuid?.()),
		).toBeNull();
		expect(await h.contender()).toBe(75);
		await h.owner.release(baseline, true);
	},
);

function unit(active = true, status = 0): string {
	return guardUnit(token, active, status);
}
guardTest(
	"real flock excludes a second writer through CLI failure, recovery and between-attempt handoff",
	record,
	async (h) => {
		// Given a systemd fake launches only a real temp-path flock helper.
		await h.owner.acquire();
		// When attempt 1 fails, recovers and prepares attempt 2 under the same owner.
		const held = [await h.contender()];
		h.owner.remember({
			...baseline,
			operation: "installing",
			resources: ["mount:51"],
		});
		held.push(await h.contender());
		h.owner.remember(baseline, true, true);
		held.push(await h.contender());
		h.owner.remember(baseline, true, false);
		held.push(await h.contender());
		h.owner.remember(baseline, true, true);
		await h.owner.release(baseline, true);
		// Then only proved-safe settlement releases the continuous job lock.
		expect(held).toEqual([75, 75, 75, 75]);
		expect(await h.contender()).toBe(0);
	},
);

guardTest(
	"observer loss and wrong-token acknowledgement retain the independent lock owner",
	record,
	async (h) => {
		// Given an independent owner without an observer pipe.
		await h.owner.acquire();
		// When observation ceases and an incorrect token appears for over one helper poll.
		writePrivateOsJobFile("release", "different-attempt\n", h.directory);
		await h.waitForWrongToken();
		// Then ownership survives; a foreign marker is private-provenance drift, so
		// release refuses rather than overwrite it, and the lock stays held.
		expect(await h.contender()).toBe(75);
		expect(await h.owner.held()).toBe(true);
		h.owner.remember(baseline, true, true);
		await expect(h.owner.release(baseline, true)).rejects.toHaveProperty(
			"reason",
			"rauc_recovery_unproven",
		);
		expect(
			await readOsJobFile("release", h.directory, process.getuid?.()),
		).toBe("different-attempt\n");
		expect(await h.contender()).toBe(75);
		expect(
			h.commands.some(
				(argv) => argv[1] === "stop" || argv[1] === "reset-failed",
			),
		).toBe(false);
		expect(
			h.commands.some(
				(argv) => argv.includes("--pipe") || argv.includes("--scope"),
			),
		).toBe(false);
	},
);

guardTest(
	"admission authority refuses private token drift while physical guardian ownership remains held",
	record,
	async (h) => {
		// Given a live independently held guardian and its captured private directory.
		await h.owner.acquire();
		writePrivateOsJobFile("release", "different-attempt\n", h.directory);
		const assertAuthority = h.owner.assertAuthority;
		if (!assertAuthority)
			throw new Error("production owner authority assertion missing");
		// When admission reasserts persisted authority rather than just the kernel lock.
		await expect(assertAuthority()).rejects.toMatchObject({
			reason: "rauc_recovery_unproven",
			diagnostics: { refusal: "private-provenance-mismatch" },
		});
		// Then lock ownership is not falsely erased or released by the authority refusal.
		expect(await h.owner.held()).toBe(true);
		expect(await h.contender()).toBe(75);
	},
);

guardTest(
	"unproven quiescence and pin teardown never acknowledge release",
	record,
	async (h) => {
		// Given an unsettled CLI, when release is attempted.
		await h.owner.acquire();
		h.owner.remember(baseline, true, false);
		await expect(h.owner.release(baseline, true)).rejects.toHaveProperty(
			"reason",
			"rauc_recovery_unproven",
		);
		// Then no release token exists and another writer cannot enter.
		expect(
			await readOsJobFile("release", h.directory, process.getuid?.()),
		).toBeNull();
		expect(await h.contender()).toBe(75);
		h.owner.remember(baseline, true, true);
		await expect(h.owner.release(baseline, false)).rejects.toHaveProperty(
			"reason",
			"rauc_recovery_unproven",
		);
		await h.owner.release(baseline, true);
	},
);

guardTest(
	"private file reader refuses symlinked attempt acknowledgement",
	record,
	async (h) => {
		// Given a live directory, when a symlink replaces its release file.
		await h.owner.acquire();
		await symlink(join(h.directory, "token"), join(h.directory, "release"));
		// Then even a matching token through the symlink is not an acknowledgement.
		await expect(
			readOsJobFile("release", h.directory, process.getuid?.()),
		).rejects.toThrow();
		expect(await h.contender()).toBe(75);
		await rm(join(h.directory, "release"));
		await h.owner.release(baseline, true);
	},
);

test.each([
	[
		"wrong token",
		(text: string) =>
			text.replaceAll(token, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
	],
	[
		"foreign fragment",
		(text: string) =>
			text.replace("/run/systemd/transient/", "/etc/systemd/system/"),
	],
	[
		"drop-in",
		(text: string) =>
			text.replace("DropInPaths=", "DropInPaths=/etc/evil.conf"),
	],
	[
		"extra shell command",
		(text: string) => text.replace(`${token} ;`, `${token} /bin/sh -c true ;`),
	],
	[
		"duplicate property",
		(text: string) => `${text}\nId=${OS_STAGE_GUARD_UNIT}`,
	],
])("foreign %s is not adoptable", (_name, mutate) => {
	// Given a same-named foreign unit, when checking exact identity.
	expect(isOwnedOsStageGuard(unit(), token)).toBe(true);
	// Then no mutated unit is adopted.
	expect(isOwnedOsStageGuard(mutate(unit()), token)).toBe(false);
});
