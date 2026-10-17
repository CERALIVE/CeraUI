import { expect, test } from "bun:test";
import { link, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	readOsJobFile,
	readOsStageJob,
	writeOsStageJob,
	writePrivateOsJobFile,
} from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { unlaunchedHarness } from "./helpers/os-stage-unlaunched-harness.ts";

test("a held unlaunched guardian retires only after normal exit and witness persistence", async () => {
	await using h = await unlaunchedHarness();
	await h.settle();
	expect(h.effects).toEqual([
		"drain",
		"sweep",
		"normal-exit",
		"drain",
		"sweep",
		"stop",
		"witness",
	]);
	expect(await readOsStageJob(h.directory, h.uid)).toBeNull();
});

test.each([false, true])(
	"a releasing-record crash with release published=%s resumes through normal exit",
	async (published) => {
		await using h = await unlaunchedHarness();
		await h.crash(published);
		await h.settle();
		expect(h.effects).toContain("normal-exit");
		expect(h.effects.at(-1)).toBe("witness");
		expect(await readOsStageJob(h.directory, h.uid)).toBeNull();
	},
);

test.each(["absent", "terminal"] as const)(
	"an owned %s unlaunched job settles without a release token",
	async (shape) => {
		await using h = await unlaunchedHarness(shape);
		await h.settle();
		expect(h.effects).toEqual(
			shape === "terminal"
				? ["drain", "sweep", "reset-failed", "witness"]
				: ["drain", "sweep", "witness"],
		);
		expect(await readOsStageJob(h.directory, h.uid)).toBeNull();
	},
);

test("absence with a matching ready token needs no artificial acknowledgement", async () => {
	await using h = await unlaunchedHarness("absent");
	await writeFile(join(h.directory, "ready"), `${h.job.attemptId}\n`, {
		mode: 0o600,
	});
	await h.settle();
	expect(h.effects).toEqual(["drain", "sweep", "witness"]);
});

test("an ack-pending helper is never stopped on an elapsed observation deadline", async () => {
	await using h = await unlaunchedHarness();
	await h.crash(true);
	await expect(
		h.settle({
			inspect: async () => ({
				kind: "live",
				pid: "100",
				invocationId: "a".repeat(32),
			}),
		}),
	).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
	expect(h.effects).toEqual(["drain", "sweep"]);
	expect(await readOsStageJob(h.directory, h.uid)).toMatchObject({
		launched: false,
		lifecycle: "releasing",
	});
});

test("a starting deadline grants neither release nor reset", async () => {
	await using h = await unlaunchedHarness("starting");
	await expect(h.settle()).rejects.toHaveProperty(
		"reason",
		"rauc_recovery_unproven",
	);
	expect(h.effects).toEqual([]);
	expect(await readOsJobFile("release", h.directory, h.uid)).toBeNull();
});

test.each([
	{
		name: "changed daemon",
		current: { instance: "other:10", processes: ["other:10"] },
	},
	{ name: "unknown operation", current: { operation: null } },
	{ name: "active operation", current: { operation: "installing" } },
	{
		name: "foreign installer",
		current: { processes: ["659:10", "writer:10"] },
	},
	{ name: "resource", current: { resources: ["mount:foreign"] } },
	{ name: "boot primary", current: { bootPrimary: "rootfs.0" } },
	{ name: "unhealthy boot", current: { bootedHealthy: false } },
	{ name: "changed target", current: { targetDevice: "different" } },
	{ name: "armed activation", current: { activationArmed: true } },
])(
	"%s uncertainty refuses before any release or sweep",
	async ({ current }) => {
		await using h = await unlaunchedHarness();
		await expect(
			h.settle({ observe: async () => ({ ...h.job.baseline, ...current }) }),
		).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
		expect(h.effects).toEqual([]);
		expect(await readOsJobFile("release", h.directory, h.uid)).toBeNull();
	},
);

test.each(["client", "kernel", "outcome", "producer", "job"] as const)(
	"%s uncertainty retains an owned terminal job",
	async (refusal) => {
		await using h = await unlaunchedHarness("terminal");
		await expect(
			h.settle({
				cliGone: async () => refusal !== "client",
				kernel: async () => refusal !== "kernel",
				outcomesAbsent: async () => refusal !== "outcome",
				producerPresent: () => refusal === "producer",
				jobIdle: async () => refusal !== "job",
			}),
		).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
		expect(h.effects).toEqual([]);
	},
);

test.each([
	"wrong token",
	"symlink",
	"hardlink",
	"foreign file",
	"directory replacement",
] as const)("private %s cannot authorize release", async (tamper) => {
	await using h = await unlaunchedHarness();
	if (tamper === "wrong token")
		writePrivateOsJobFile("release", "wrong\n", h.directory);
	if (tamper === "symlink")
		await symlink(join(h.directory, "ready"), join(h.directory, "release"));
	if (tamper === "hardlink")
		await link(join(h.directory, "ready"), join(h.directory, "release"));
	if (tamper === "foreign file")
		await writeFile(join(h.directory, "foreign"), "untouched");
	await expect(
		h.settle(
			tamper === "directory replacement"
				? {
						observe: async () => {
							await rename(h.directory, `${h.directory}-replaced`);
							return h.job.baseline;
						},
					}
				: {},
		),
	).rejects.toThrow();
	expect(h.effects).toEqual([]);
});

test("witness write failure retains releasing provenance after physical cleanup", async () => {
	await using h = await unlaunchedHarness();
	await expect(
		h.settle({
			witness: () => {
				throw new Error("durability refused");
			},
		}),
	).rejects.toThrow("durability refused");
	expect(await readOsStageJob(h.directory, h.uid)).toMatchObject({
		launched: false,
		lifecycle: "releasing",
	});
	expect(h.effects).toContain("stop");
});

test("a launched record never enters the unlaunched settlement path", async () => {
	await using h = await unlaunchedHarness();
	writeOsStageJob({ ...h.job, launched: true }, h.directory);
	await expect(h.settle()).rejects.toHaveProperty(
		"reason",
		"rauc_recovery_unproven",
	);
	expect(h.effects).toEqual([]);
	expect(await readOsStageJob(h.directory, h.uid)).toMatchObject({
		launched: true,
	});
});
