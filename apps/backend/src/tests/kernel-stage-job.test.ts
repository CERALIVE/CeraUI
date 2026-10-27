import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWithTimeout } from "../helpers/spawn-policy.ts";
import {
	kernelStageCommand,
	kernelStageGuardArgv,
	kernelStageUnit,
	launchKernelStage,
	parseKernelStageObservation,
} from "../modules/system/update-orchestrator/kernel-stage-job.ts";
import { kernelRecord, kernelState } from "./helpers/kernel-update-fixture.ts";

const attempt = {
	id: kernelState.attempt,
	...kernelRecord,
	deb: "/var/tmp/kernel/kernel.deb",
};
const unit = kernelStageUnit(attempt);
function status(exit = 0): string {
	return `LoadState=loaded\nId=${unit}\nFragmentPath=/run/systemd/transient/${unit}\nDescription=CeraLive kernel stage\nTransient=yes\nType=exec\nRemainAfterExit=yes\nUser=\nDropInPaths=\nRestart=no\nActiveState=active\nMainPID=0\nControlPID=0\nExecMainCode=1\nExecMainStatus=${exit}\nExecStart={ path=/usr/bin/flock ; argv[]=${kernelStageGuardArgv(attempt).join(" ")} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=100 ; code=exited ; status=${exit} }\n`;
}
test("kernel stage has the OS guard shape with only the stager and exact bound arguments changed", async () => {
	// Given downloaded, origin-bound bytes; When the real launcher submits them.
	const seen: string[][] = [];
	await launchKernelStage(attempt, async (argv) => {
		seen.push(argv);
		return { exitCode: 0, stdout: "", stderr: "" };
	});
	// Then PID 1 owns the only software-update flock through the entire stager.
	expect(seen).toEqual([
		[
			"systemd-run",
			`--unit=ceralive-kernel-stage-${kernelState.attempt}.service`,
			"--description=CeraLive kernel stage",
			"--service-type=exec",
			"--property=RemainAfterExit=yes",
			"--property=StandardOutput=null",
			"--property=StandardError=journal",
			"--property=RuntimeMaxSec=1800",
			"/usr/bin/flock",
			"-n",
			"-E",
			"75",
			"-x",
			"/run/lock/ceralive-update.lock",
			"/usr/lib/ceralive/ceralive-kernel-stage",
			"--attempt",
			kernelState.attempt,
			"--deb",
			"/var/tmp/kernel/kernel.deb",
			"--package",
			kernelRecord.package,
			"--version",
			kernelRecord.version,
			"--sha256",
			kernelRecord.deb_sha256,
		],
	]);
	expect(parseKernelStageObservation(status(), attempt)).toEqual({
		kind: "terminal",
		exitCode: 0,
	});
});
test.each([
	(text: string) => text.replace("-n -E 75 -x", "-x"),
	(text: string) =>
		text.replace("/run/lock/ceralive-update.lock", "/run/lock/foreign"),
	(text: string) => text.replace("Transient=yes", "Transient=no"),
	(text: string) => text.replace("DropInPaths=", "DropInPaths=/foreign.conf"),
	(text: string) => `${text}MainPID=999\n`,
	(text: string) => text.replace("ActiveState=active", "ActiveState=unknown"),
])(
	"startup never adopts foreign or malformed kernel stage ownership",
	(mutate) => {
		expect(() =>
			parseKernelStageObservation(mutate(status()), attempt),
		).toThrow("kernel_stage_ownership_unknown");
	},
);
test("zero submission output is not a completed stager and exit 75 remains a failure", async () => {
	expect(kernelStageCommand(attempt)).not.toContain("--pipe");
	expect(
		parseKernelStageObservation(
			status().replace("MainPID=0", "MainPID=100"),
			attempt,
		),
	).toEqual({ kind: "running" });
	expect(parseKernelStageObservation(status(75), attempt)).toEqual({
		kind: "terminal",
		exitCode: 75,
	});
	await expect(
		launchKernelStage(attempt, async () => ({
			exitCode: 75,
			stdout: "success",
			stderr: "",
		})),
	).rejects.toThrow("kernel_staging_failed");
});
test("a real flock held by either other-slot writer excludes the kernel launch", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kernel-shared-lock-"));
	const lock = join(directory, "update.lock");
	const holder = Bun.spawn(
		[
			"/usr/bin/flock",
			"-x",
			lock,
			"/bin/sh",
			"-ec",
			"printf 'ready\\n'; read release",
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	const reader = holder.stdout.getReader();
	try {
		// Subscribe before probing: the holder prints only after taking the real lock.
		const readiness = await reader.read();
		expect(new TextDecoder().decode(readiness.value)).toBe("ready\n");
		await expect(
			launchKernelStage(attempt, async (argv) => {
				const guard = argv.slice(argv.indexOf("/usr/bin/flock"));
				const at = guard.indexOf("/run/lock/ceralive-update.lock");
				guard[at] = lock;
				return spawnWithTimeout([...guard.slice(0, at + 1), "/bin/true"], {
					timeoutMs: 2_000,
				});
			}),
		).rejects.toThrow("kernel_staging_failed");
		holder.stdin.write("release\n");
		await holder.stdin.end();
		expect(await holder.exited).toBe(0);
		expect(
			(
				await spawnWithTimeout(
					["/usr/bin/flock", "-n", "-E", "75", "-x", lock, "/bin/true"],
					{ timeoutMs: 2_000 },
				)
			).exitCode,
		).toBe(0);
	} finally {
		reader.releaseLock();
		holder.kill();
		await holder.exited;
		await rm(directory, { recursive: true, force: true });
	}
});
