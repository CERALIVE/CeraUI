import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildAptAllInstallArgs } from "../modules/system/apt-all-packages.ts";
import {
	prepareSoftwareUpdateOutput,
	softwareUpdateOutputPaths,
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
const drain =
	"exec 3> >(set +e; echo -1000 2>/dev/null >/proc/self/oom_score_adj; cat 2>/dev/null >>/run/ceralive/software-update.status; exec cat >/dev/null) || exec 3>/dev/null";
const legacyScript = `${drain}; exec /usr/bin/apt-get -o APT::Status-Fd=3 ${legacyArgs.join(" ")}`;
const pinnedScript = `${drain}; /usr/bin/apt-get -o APT::Status-Fd=3 -d -y upgrade --with-new-pkgs && /usr/bin/apt-get -o APT::Status-Fd=3 ${pinnedArgs.join(" ")}`;
const unreleasedScript = `exec 3>>/run/ceralive/software-update.status && exec /usr/bin/apt-get -o APT::Status-Fd=3 ${legacyArgs.join(" ")}`;
const preChannelPinned = `/usr/bin/apt-get -d -y upgrade --with-new-pkgs && /usr/bin/apt-get ${pinnedArgs.join(" ")}`;

const shExec = (script: string, shell = "/bin/bash") =>
	`{ path=${shell} ; argv[]=${shell} -ec ${script}${tail}`;
const flockExec = (script: string, shell = "/bin/bash") =>
	`{ path=/usr/bin/flock ; argv[]=/usr/bin/flock -x /run/lock/ceralive-update.lock ${shell} -ec ${script}${tail}`;
const aptExec = `{ path=/usr/bin/apt-get ; argv[]=/usr/bin/apt-get ${legacyArgs.join(" ")} ; }`;

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

describe("the detached unit writes APT status records to a private third file", () => {
	test("the package-scoped unit gives apt the status file as descriptor 3", () => {
		expect(buildDetachedAptUpgradeCommand(legacyArgs, paths)).toEqual([
			"systemd-run",
			"--unit=ceralive-software-update.service",
			"--description=CeraLive software update",
			"--remain-after-exit",
			"--quiet",
			"--service-type=exec",
			"--expand-environment=no",
			"--property=StandardOutput=append:/run/ceralive/software-update.stdout",
			"--property=StandardError=append:/run/ceralive/software-update.stderr",
			"--",
			"/bin/bash",
			"-ec",
			legacyScript,
		]);
	});

	test("both pinned apt runs report to the same status file", () => {
		expect(buildDetachedAptAllCommand(pinnedArgs, "any", paths).at(-1)).toBe(
			pinnedScript,
		);
		expect(expectedAptAllScript(pinnedArgs, [])).toBe(pinnedScript);
	});

	test("the status file is prepared like stdout and stderr", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "ceraui-status-"));
		const local = {
			stdout: path.join(directory, "software-update.stdout"),
			stderr: path.join(directory, "software-update.stderr"),
			status: path.join(directory, "software-update.status"),
		};
		try {
			await prepareSoftwareUpdateOutput(local, process.getuid?.() ?? 0);
			const stat = await lstat(local.status);
			expect(stat.isFile()).toBe(true);
			expect(stat.mode & 0o777).toBe(0o600);
			expect(stat.size).toBe(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

test("a status file that cannot be prepared never blocks the launch", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "ceraui-status-"));
	const local = {
		stdout: path.join(directory, "software-update.stdout"),
		stderr: path.join(directory, "software-update.stderr"),
		status: path.join(directory, "software-update.status"),
	};
	try {
		await mkdir(local.status);
		await writeFile(path.join(local.status, "occupant"), "");
		expect(
			await prepareSoftwareUpdateOutput(local, process.getuid?.() ?? 0),
		).toEqual({ status: false });
		for (const file of [local.stdout, local.stderr]) {
			const stat = await lstat(file);
			expect(stat.isFile()).toBe(true);
			expect(stat.mode & 0o777).toBe(0o600);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("adoption identifies which units write the status channel", () => {
	test.each([
		["package-scoped unit", shExec(legacyScript), true],
		["pinned unit", flockExec(pinnedScript), true],
		["package-scoped unit started before the channel", aptExec, false],
		[
			"pinned unit started before the channel",
			flockExec(preChannelPinned, "/bin/sh"),
			false,
		],
	])("%s", (_name, execStart, aptStatus) => {
		expect(validateDetachedAptServiceIdentity(show(execStart))).toBe(aptStatus);
		const probe = (running: boolean) =>
			parseDetachedAptServiceProbe(
				{ stdout: show(execStart, running), stderr: "", exitCode: 0 },
				["systemctl", "show"],
			);
		expect(probe(true)).toEqual({
			kind: "running",
			...(aptStatus ? { aptStatus: true } : {}),
		});
		expect(probe(false)).toEqual({
			kind: "finished",
			exitCode: 100,
			cleanup: "reset-failed",
			...(aptStatus ? { aptStatus: true } : {}),
		});
	});

	test.each([
		[
			"another status path",
			shExec(legacyScript.replace("software-update.status", "status")),
		],
		[
			"a status option without the descriptor",
			shExec(legacyScript.replace(`${drain}; `, "")),
		],
		["apt not exec'd", shExec(legacyScript.replace("; exec /usr", "; /usr"))],
		[
			"a drain that stops at its first failure",
			shExec(legacyScript.replace("set +e; ", "")),
		],
		[
			"the status file opened directly, never released",
			shExec(unreleasedScript),
		],
		["a status form under /bin/sh", shExec(legacyScript, "/bin/sh")],
		["a pinned status form under /bin/sh", flockExec(pinnedScript, "/bin/sh")],
		[
			"an extra command",
			shExec(`${legacyScript} && /usr/bin/apt-get -y remove cerastream`),
		],
		[
			"a foreign apt operation",
			shExec(
				legacyScript.replace(
					"install ceralive-device",
					"remove ceralive-device",
				),
			),
		],
		[
			"only one pinned run reporting",
			flockExec(pinnedScript.replace("-o APT::Status-Fd=3 -d", "-d")),
		],
		[
			"the pinned channel on another descriptor",
			flockExec(pinnedScript.replaceAll("Status-Fd=3", "Status-Fd=2")),
		],
	])("refuses %s", (_name, execStart) => {
		expect(() => validateDetachedAptServiceIdentity(show(execStart))).toThrow(
			DetachedAptServiceIdentityError,
		);
	});
});
