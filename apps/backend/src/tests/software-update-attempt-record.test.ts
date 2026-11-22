import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildAptAllInstallArgs } from "../modules/system/apt-all-packages.ts";
import {
	prepareSoftwareUpdateOutput,
	readSoftwareUpdateAttempt,
	type SoftwareUpdateAttempt,
	softwareUpdateAttemptPath,
	softwareUpdateOutputPaths,
	UnsafeSoftwareUpdateOutputPathError,
	updateSoftwareUpdateAttempt,
	writeSoftwareUpdateAttempt,
} from "../modules/system/software-update-output.ts";
import {
	buildDetachedAptAllCommand,
	buildDetachedAptUpgradeCommand,
} from "../modules/system/software-update-service.ts";
import {
	DetachedAptServiceIdentityError,
	expectedAptAllScript,
	validateDetachedAptServiceIdentity,
} from "../modules/system/software-update-service-contract.ts";
import { parseDetachedAptServiceProbe } from "../modules/system/software-update-service-state.ts";
import { buildAptUpgradeArgs } from "../modules/system/software-updates.ts";

const paths = softwareUpdateOutputPaths();
const legacyArgs = buildAptUpgradeArgs(
	["ceralive-device", "cerastream"],
	"any",
);
const pinnedArgs = buildAptAllInstallArgs(
	[{ name: "cerastream", version: "2" }],
	"any",
);
const tail =
	" ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=42 ; code=(null) ; status=0/0 }";
const releasedPinned = `/usr/bin/apt-get -d -y upgrade --with-new-pkgs && /usr/bin/apt-get ${pinnedArgs.join(" ")}`;
const aptExec = `{ path=/usr/bin/apt-get ; argv[]=/usr/bin/apt-get ${legacyArgs.join(" ")} ; }`;
const shExec = (script: string, shell = "/bin/bash") =>
	`{ path=${shell} ; argv[]=${shell} -ec ${script}${tail}`;
const flockExec = (script: string, shell = "/bin/sh") =>
	`{ path=/usr/bin/flock ; argv[]=/usr/bin/flock -x /run/lock/ceralive-update.lock ${shell} -ec ${script}${tail}`;
const status = "/run/ceralive/software-update.status";
const fd3 = "-o APT::Status-Fd=3";
// Every status-channel form this change ever wrote; none was released.
const neverReleased = {
	"the plain status file": `exec 3>>${status} && exec /usr/bin/apt-get ${fd3} ${legacyArgs.join(" ")}`,
	"the status pipe and drain": `exec 3> >(set +e; echo -1000 2>/dev/null >/proc/self/oom_score_adj; cat 2>/dev/null >>${status}; exec cat >/dev/null) || exec 3>/dev/null; exec /usr/bin/apt-get ${fd3} ${legacyArgs.join(" ")}`,
	"the appended status file": `{ exec 3>>${status}; } 2>/dev/null || exec 3>/dev/null; exec /usr/bin/apt-get ${fd3} ${legacyArgs.join(" ")}`,
	"the reserved status file": `{ exec 3<>${status}; } 2>/dev/null || exec 3>/dev/null; exec /usr/bin/apt-get ${fd3} ${legacyArgs.join(" ")}`,
	"the status pipe and its marking reader": `exec 3> >(set +e; echo -1000 >/proc/self/oom_score_adj 2>/dev/null; cat >>${status} 2>/dev/null || exec cat >/dev/null; : >>${status}.done 2>/dev/null) || exec 3>/dev/null; exec /usr/bin/apt-get ${fd3} ${legacyArgs.join(" ")}`,
};

function show(execStart: string, running = true): string {
	return [
		"Id=ceralive-software-update.service",
		"FragmentPath=/run/systemd/transient/ceralive-software-update.service",
		"Description=CeraLive software update",
		"LoadState=loaded",
		`ActiveState=${running ? "active" : "failed"}`,
		`SubState=${running ? "running" : "failed"}`,
		"Transient=yes",
		"Type=exec",
		"RemainAfterExit=yes",
		"User=",
		`ExecStart=${execStart}`,
		"ExecStartPre=",
		"ExecStartPost=",
		"StandardOutput=append",
		"StandardError=append",
		`ExecMainCode=${running ? 0 : 1}`,
		`ExecMainStatus=${running ? 0 : 100}`,
	].join("\n");
}

describe("the detached unit gives APT no telemetry descriptor", () => {
	test("both forms are the released commands: no status option, no descriptor 3", () => {
		const direct = buildDetachedAptUpgradeCommand(legacyArgs, paths);
		expect(direct.slice(direct.indexOf("--"))).toEqual([
			"--",
			"/usr/bin/apt-get",
			...legacyArgs,
		]);
		const pinned = buildDetachedAptAllCommand(pinnedArgs, "any", paths);
		expect(pinned.slice(-3)).toEqual(["/bin/sh", "-ec", releasedPinned]);
		expect(expectedAptAllScript(pinnedArgs, [])).toBe(releasedPinned);
		for (const command of [direct, pinned])
			expect(command.join(" ")).not.toMatch(
				/Status-Fd|exec 3|software-update\.status/,
			);
	});

	test("the prepared output is stdout and stderr only, private and empty", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "ceraui-output-"));
		const local = {
			stdout: path.join(directory, "software-update.stdout"),
			stderr: path.join(directory, "software-update.stderr"),
		};
		try {
			await prepareSoftwareUpdateOutput(local, process.getuid?.() ?? 0);
			for (const file of [local.stdout, local.stderr]) {
				const stat = await lstat(file);
				expect(stat.isFile()).toBe(true);
				expect(stat.mode & 0o777).toBe(0o600);
				expect(stat.size).toBe(0);
			}
			expect(
				await Bun.file(path.join(directory, "software-update.status")).exists(),
			).toBe(false);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("the attempt record", () => {
	const accepted: SoftwareUpdateAttempt = {
		schema: 2,
		attempt: "11111111-1111-4111-8111-111111111111",
		phase: "accepted",
		uptimeMs: 1_000,
		leftover: {
			attempt: "33333333-3333-4333-8333-333333333333",
			invocation: "a".repeat(32),
			exitCode: 0,
		},
	};
	const scratch = async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "ceraui-attempt-"));
		return {
			directory,
			local: {
				stdout: path.join(directory, "software-update.stdout"),
				stderr: path.join(directory, "software-update.stderr"),
			},
			uid: process.getuid?.() ?? 0,
		};
	};

	test("round-trips, and a record of another shape is never written", async () => {
		const { directory, local, uid } = await scratch();
		try {
			expect(readSoftwareUpdateAttempt(local, uid)).toBeNull();
			writeSoftwareUpdateAttempt(local, accepted, uid);
			expect(readSoftwareUpdateAttempt(local, uid)).toEqual(accepted);
			expect(() =>
				writeSoftwareUpdateAttempt(local, { ...accepted, exitCode: 256 }, uid),
			).toThrow();
			expect(readSoftwareUpdateAttempt(local, uid)).toEqual(accepted);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("is trusted only as a private, well-formed record", async () => {
		const { directory, local, uid } = await scratch();
		try {
			writeSoftwareUpdateAttempt(local, accepted, uid);
			await chmod(softwareUpdateAttemptPath(local), 0o644);
			expect(() => readSoftwareUpdateAttempt(local, uid)).toThrow(
				UnsafeSoftwareUpdateOutputPathError,
			);
			await rm(softwareUpdateAttemptPath(local));
			await writeFile(
				softwareUpdateAttemptPath(local),
				JSON.stringify({ ...accepted, schema: 1 }),
				{ mode: 0o600 },
			);
			expect(() => readSoftwareUpdateAttempt(local, uid)).toThrow(
				UnsafeSoftwareUpdateOutputPathError,
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("every write compares with the record it replaces in the same step", async () => {
		const { directory, local, uid } = await scratch();
		try {
			let seen: unknown = "unset";
			expect(
				updateSoftwareUpdateAttempt(
					local,
					(current) => {
						seen = current;
						return accepted;
					},
					uid,
				),
			).toEqual(accepted);
			expect(seen).toBeNull();
			// A writer that no longer owns the record writes nothing.
			const stale = updateSoftwareUpdateAttempt(
				local,
				(current) =>
					current?.attempt === "22222222-2222-4222-8222-222222222222"
						? { ...current, exitCode: 0 }
						: null,
				uid,
			);
			expect(stale).toBeNull();
			expect(readSoftwareUpdateAttempt(local, uid)).toEqual(accepted);
			// A record that cannot be read gives no authority: nothing is written.
			await chmod(softwareUpdateAttemptPath(local), 0o644);
			seen = "unset";
			expect(() =>
				updateSoftwareUpdateAttempt(
					local,
					(current) => {
						seen = current;
						return { ...accepted, exitCode: 0 };
					},
					uid,
				),
			).toThrow(UnsafeSoftwareUpdateOutputPathError);
			expect(seen).toBe("unset");
			// Only a new admission may replace it, and sees none.
			expect(
				updateSoftwareUpdateAttempt(
					local,
					(current) => {
						seen = current;
						return accepted;
					},
					uid,
					{ replaceUnreadable: true },
				),
			).toEqual(accepted);
			expect(seen).toBeNull();
			expect(readSoftwareUpdateAttempt(local, uid)).toEqual(accepted);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("adoption", () => {
	test.each([
		["a released package-scoped unit", aptExec],
		["a released pinned unit", flockExec(releasedPinned)],
	])("adopts %s, with its systemd invocation", (_name, execStart) => {
		expect(() =>
			validateDetachedAptServiceIdentity(show(execStart)),
		).not.toThrow();
		const probe = (running: boolean) =>
			parseDetachedAptServiceProbe(
				{
					stdout: `${show(execStart, running)}\nInvocationID=${"b".repeat(32)}`,
					stderr: "",
					exitCode: 0,
				},
				["systemctl", "show"],
			);
		expect(probe(true)).toEqual({
			kind: "running",
			invocation: "b".repeat(32),
		});
		expect(probe(false)).toEqual({
			kind: "finished",
			exitCode: 100,
			cleanup: "reset-failed",
			invocation: "b".repeat(32),
		});
	});

	test.each([
		...Object.entries(neverReleased).map(
			([name, script]) => [name, shExec(script)] as const,
		),
		[
			"a pinned status form",
			flockExec(
				releasedPinned.replaceAll(
					"/usr/bin/apt-get",
					`/usr/bin/apt-get ${fd3}`,
				),
				"/bin/bash",
			),
		],
		[
			"an extra command",
			flockExec(`${releasedPinned} && /usr/bin/apt-get -y remove cerastream`),
		],
	])("refuses %s", (_name, execStart) => {
		expect(() => validateDetachedAptServiceIdentity(show(execStart))).toThrow(
			DetachedAptServiceIdentityError,
		);
	});
});
