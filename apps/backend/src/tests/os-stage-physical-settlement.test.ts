import { expect, test } from "bun:test";
import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { settleOwnedUnlaunched } from "../modules/system/update-orchestrator/os-stage-job-owner.ts";
import { unlaunchedHarness } from "./helpers/os-stage-unlaunched-harness.ts";

test.each([
	"inspect",
	"kernel",
	"observe",
	"cliGone",
	"outcomesAbsent",
	"drain",
	"sweep",
	"pinClean",
	"jobIdle",
	"run",
] as const)(
	"a thrown %s proof is unsafe and retains its cause",
	async (seam) => {
		await using h = await unlaunchedHarness("terminal");
		const cause = new Error(`${seam} timed out`);
		const fault = async () => {
			throw cause;
		};
		const result = h.settle({ [seam]: fault });
		await expect(result).rejects.toMatchObject({
			reason: "rauc_recovery_unproven",
			mode: "unsafe",
			cause,
		});
		expect(await Bun.file(join(h.directory, "job.json")).exists()).toBe(true);
		expect(h.effects).not.toContain("witness");
	},
);

test("private disk I/O refusal is normalized inside the owned settlement boundary", async () => {
	await using h = await unlaunchedHarness();
	await rm(join(h.directory, "token"));
	await symlink(join(h.directory, "ready"), join(h.directory, "token"));
	await expect(
		settleOwnedUnlaunched({
			record: h.job,
			current: h.job,
			control: h.deps.control,
			effects: h.deps,
		}),
	).rejects.toMatchObject({
		reason: "rauc_recovery_unproven",
		mode: "unsafe",
		cause: { code: "ELOOP" },
	});
	expect(h.effects).toEqual([]);
});

test("a typed operator error from physical proof never becomes a safe failure", async () => {
	await using h = await unlaunchedHarness();
	const cause = new OsStageError("os_transport_failed");
	await expect(
		h.settle({
			kernel: async () => {
				throw cause;
			},
		}),
	).rejects.toMatchObject({ reason: "rauc_recovery_unproven", cause });
});

test("unsafe normalization retains the witness failure's diagnostic text", async () => {
	await using h = await unlaunchedHarness("absent");
	const cause = new Error("durability refused");
	const result = h.settle({
		witness: () => {
			throw cause;
		},
	});
	await expect(result).rejects.toMatchObject({
		reason: "rauc_recovery_unproven",
		cause,
	});
	await expect(result).rejects.toThrow(cause.message);
});
