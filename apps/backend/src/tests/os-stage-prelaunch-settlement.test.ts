import { expect, test } from "bun:test";
import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { createOsStageJobOwner } from "../modules/system/update-orchestrator/os-stage-job.ts";
import {
	readOsJobFile,
	readOsStageJob,
} from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import {
	type OsStageRunDeps,
	runOsStageJob,
} from "../modules/system/update-orchestrator/os-stage-run.ts";
import { rankTransports } from "../modules/system/update-transport/core.ts";
import { createUpdatePinController } from "../modules/system/update-transport/pin.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";
import { manifest } from "./helpers/os-stage-unlaunched-fixture.ts";
import { unlaunchedHarness } from "./helpers/os-stage-unlaunched-harness.ts";

type Fault = "clients" | "private" | "outcome" | "pin" | "none";
type Failure = "cancel" | "operator" | "selector";

async function scenario(fault: Fault, failure: Failure) {
	const h = await unlaunchedHarness();
	await rm(h.directory, { recursive: true });
	const controller = new AbortController();
	const cause = new OsStageError("rauc_install_failed", {
		cause: new Error("revalidation refused"),
	});
	const fail = async () => {
		if (fault === "private") {
			await rm(join(h.directory, "token"));
			await symlink(join(h.directory, "ready"), join(h.directory, "token"));
		}
		switch (failure) {
			case "cancel":
				controller.abort();
				return;
			case "operator":
				throw cause;
			case "selector":
				throw new Error("selector failed");
		}
	};
	const deps: OsStageRunDeps<string> = {
		acquireControl: acquireTestOsStageControl,
		observe: h.deps.observe,
		owner: (record) =>
			createOsStageJobOwner(record, {
				directory: h.directory,
				uid: h.uid,
				now: h.deps.now,
				sleep: h.deps.sleep,
				inspect: () => h.deps.inspect(record.attemptId),
				kernel: h.deps.kernel,
				jobIdle: h.deps.jobIdle,
				unlaunched: {
					...h.deps,
					cliGone: async () => fault !== "clients",
					outcomesAbsent: async () => fault !== "outcome",
					pinClean: async () => fault !== "pin",
				},
				run: async (argv) => {
					if (argv[0] === "systemd-run") {
						await writeFile(
							join(h.directory, "ready"),
							`${record.attemptId}\n`,
							{ mode: 0o600 },
						);
						return { exitCode: 0, stdout: "", stderr: "" };
					}
					if (argv[1] !== "show") return h.deps.run(argv);
					return { exitCode: 0, stdout: "LoadState=not-found\n", stderr: "" };
				},
			}),
		pin: createUpdatePinController({
			readCapabilities: async () => ({
				schema: 1,
				features: ["apt-all-packages", "transport-uidrange"],
				apt_uid: 42042,
				ota_uid: 42043,
			}),
			run: async (_bin, args) =>
				args.join(" ").endsWith("route show default")
					? "default dev eth0\n"
					: "",
		}),
		selection: async () => {
			if (failure === "selector") await fail();
			return rankTransports([
				{
					candidate: { ifname: "eth0", kind: "ethernet", metered: false },
					family: 4,
					hosts: [{ host: "fixture", state: "clear", latencyMs: 1 }],
				},
			]);
		},
		revalidate: fail,
		blocked: async () => false,
		restart: async () => {
			throw new Error("restart forbidden");
		},
		now: h.deps.now,
		sleep: h.deps.sleep,
		prepareReceipt: async () => {
			throw new Error("receipt forbidden");
		},
		progress: () => undefined,
		readProgress: async () => null,
		attempt: () => {
			throw new Error("dispatch forbidden");
		},
	};
	await deps.pin.sweep();
	return {
		h,
		cause,
		run: () =>
			runOsStageJob(
				manifest,
				{ attemptId: h.job.attemptId, signal: controller.signal },
				deps,
			),
	};
}

for (const failure of ["cancel", "operator", "selector"] as const) {
	test.each(["clients", "private", "outcome", "pin"] as const)(
		`${failure} retains the guardian when the %s proof fails`,
		async (fault) => {
			const { h, run } = await scenario(fault, failure);
			await using _cleanup = h;
			await expect(run()).rejects.toMatchObject({
				reason: "rauc_recovery_unproven",
				mode: "unsafe",
			});
			expect(await readOsJobFile("release", h.directory, h.uid)).toBeNull();
			expect(
				await Bun.file(join(h.directory, "job.json")).json(),
			).toMatchObject({
				launched: false,
			});
			expect(h.effects).not.toContain("stop");
			expect(h.effects).not.toContain("witness");
		},
	);
	test(`${failure} settles normally before returning the original disposition`, async () => {
		const { h, cause, run } = await scenario("none", failure);
		await using _cleanup = h;
		const result = run();
		if (failure === "operator") await expect(result).rejects.toBe(cause);
		else
			await expect(result).rejects.toHaveProperty(
				"reason",
				failure === "cancel"
					? "os_stage_cancelled_for_stream"
					: "rauc_install_failed",
			);
		expect(h.effects).toContain("normal-exit");
		expect(h.effects).toContain("witness");
		expect(await readOsStageJob(h.directory, h.uid)).toBeNull();
	});
}
