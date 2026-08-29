/*
 * Task 11 — apt-get is now invoked argv-only (no shell interpolation, no
 * `args.split(" ")`). These tests pin the security-critical contract:
 *
 *   - a held-back package list maps to one argv element per package;
 *   - each package name is charset-validated, so a name carrying shell
 *     metacharacters or whitespace is rejected before it can reach apt-get.
 */
import { describe, expect, it } from "bun:test";
import {
	lstat,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isParseError } from "../modules/system/cli-parse.ts";
import {
	prepareSoftwareUpdateOutput,
	readSoftwareUpdateOutput,
} from "../modules/system/software-update-output.ts";
import {
	buildDetachedAptUpgradeCommand,
	DetachedAptOutputUnavailableError,
	DetachedAptServiceAlreadyExistsError,
	DetachedAptServiceCleanupError,
	recoverDetachedAptUpgrade,
	runDetachedAptUpgrade,
} from "../modules/system/software-update-process.ts";
import {
	DetachedAptServiceCommandError,
	DetachedAptServiceIdentityError,
	parseDetachedAptServiceProbe,
	parseDetachedAptServiceState,
	validateDetachedAptServiceFragment,
	validateDetachedAptServiceIdentity,
} from "../modules/system/software-update-service.ts";
import {
	buildAptInstallArgs,
	buildAptUpgradeArgs,
	classifyAptUpdateResult,
	deriveAptProgress,
	isSoftwareUpdateRecoveryInconclusive,
	parseAptUpgradeSummary,
	parseHeldBackPackages,
	recoverSoftwareUpdateIfRunning,
	resetSoftwareUpdateSizeRunner,
	resetSoftwareUpdateState,
	runUpdateDiscoveryAndReport,
	setSoftwareUpdateSizeRunner,
} from "../modules/system/software-updates.ts";

const SOFTWARE_UPDATES_PATH = new URL(
	"../modules/system/software-updates.ts",
	import.meta.url,
);
const MAIN_PATH = new URL("../main.ts", import.meta.url);
const DETACHED_APT_ARGS = [
	"-y",
	"-o",
	"Dpkg::Options::=--force-confdef",
	"-o",
	"Dpkg::Options::=--force-confold",
	"dist-upgrade",
] as const;

function serviceState(properties: {
	readonly activeState: string;
	readonly subState: string;
	readonly execMainCode?: number;
	readonly execMainStatus?: number;
	readonly id?: string;
	readonly user?: string;
	readonly execStart?: string;
}): string {
	return [
		`Id=${properties.id ?? "ceralive-software-update.service"}`,
		"FragmentPath=/run/systemd/transient/ceralive-software-update.service",
		"Description=CeraLive software update",
		"LoadState=loaded",
		`ActiveState=${properties.activeState}`,
		`SubState=${properties.subState}`,
		"Transient=yes",
		"Type=exec",
		"RemainAfterExit=yes",
		`User=${properties.user ?? ""}`,
		`ExecStart=${properties.execStart ?? "{ path=/usr/bin/apt-get ; argv[]=/usr/bin/apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade ; }"}`,
		"ExecStartPre=",
		"ExecStartPost=",
		"StandardOutput=append",
		"StandardError=append",
		`ExecMainCode=${properties.execMainCode ?? 0}`,
		`ExecMainStatus=${properties.execMainStatus ?? 0}`,
		"",
	].join("\n");
}

describe("parseHeldBackPackages() — charset validation", () => {
	it("splits a whitespace-separated list into individual package names", () => {
		expect(parseHeldBackPackages("pkg-a pkg-b")).toEqual(["pkg-a", "pkg-b"]);
	});

	it("accepts Debian-name punctuation (. + : ~ -)", () => {
		expect(parseHeldBackPackages("lib.foo g++ a:b1 x~rc-1")).toEqual([
			"lib.foo",
			"g++",
			"a:b1",
			"x~rc-1",
		]);
	});

	it("collapses irregular whitespace and drops empty tokens", () => {
		expect(parseHeldBackPackages("  pkg-a   pkg-b \n pkg-c ")).toEqual([
			"pkg-a",
			"pkg-b",
			"pkg-c",
		]);
	});

	it("rejects a name carrying shell metacharacters", () => {
		expect(() => parseHeldBackPackages("pkg; rm -rf /")).toThrow(
			/invalid package name/,
		);
	});

	it("rejects a single poisoned name embedded in a valid list", () => {
		expect(() => parseHeldBackPackages("good-pkg $(reboot)")).toThrow(
			/invalid package name/,
		);
	});
});

describe("buildAptInstallArgs() — argv mapping", () => {
	it("maps the package list to one argv element each, after install --assume-no", () => {
		expect(buildAptInstallArgs(["pkg-a", "pkg-b"])).toEqual([
			"install",
			"--assume-no",
			"pkg-a",
			"pkg-b",
		]);
	});
});

describe("buildAptUpgradeArgs() — argv mapping", () => {
	const base = [
		"-y",
		"-o",
		"Dpkg::Options::=--force-confdef",
		"-o",
		"Dpkg::Options::=--force-confold",
	];

	it("dist-upgrades when there are no held-back packages", () => {
		expect(buildAptUpgradeArgs()).toEqual([...base, "dist-upgrade"]);
		expect(buildAptUpgradeArgs([])).toEqual([...base, "dist-upgrade"]);
	});

	it("installs held-back packages as separate argv elements", () => {
		expect(buildAptUpgradeArgs(["pkg-a", "pkg-b"])).toEqual([
			...base,
			"install",
			"pkg-a",
			"pkg-b",
		]);
	});
});

describe("buildDetachedAptUpgradeCommand() — service-cgroup isolation", () => {
	it("runs apt in a PID-1-owned transient service with durable output sinks", () => {
		const command = buildDetachedAptUpgradeCommand(DETACHED_APT_ARGS, {
			stdout: "/run/ceralive/software-update.stdout",
			stderr: "/run/ceralive/software-update.stderr",
		});

		expect(command).toEqual([
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
			"/usr/bin/apt-get",
			...DETACHED_APT_ARGS,
		]);
		expect(command).not.toContain("--scope");
		expect(command).not.toContain("--pipe");
	});

	it("rejects caller-selected output paths", () => {
		expect(() =>
			buildDetachedAptUpgradeCommand(DETACHED_APT_ARGS, {
				stdout: "/tmp/update.stdout",
				stderr: "/tmp/update.stderr",
			}),
		).toThrow(/runtime paths are fixed/);
	});

	it("rejects a detached apt operation outside the upgrade contract", () => {
		expect(() =>
			buildDetachedAptUpgradeCommand(["-y", "remove", "ceralui"], {
				stdout: "/run/ceralive/software-update.stdout",
				stderr: "/run/ceralive/software-update.stderr",
			}),
		).toThrow(/arguments do not match/);
	});

	it("keeps the production upgrade off the ceralive service cgroup", async () => {
		const source = await Bun.file(SOFTWARE_UPDATES_PATH).text();
		expect(source).toContain("runDetachedAptUpgrade,");
		expect(source).toContain('from "./software-update-process.ts";');
		expect(source).toContain(
			"runDetachedAptUpgrade(buildAptUpgradeArgs(heldBack), monitor.handlers)",
		);
		expect(source).not.toContain(
			'Bun.spawn(["apt-get", ...buildAptUpgradeArgs(heldBack)]',
		);
	});

	it("runs apt refresh and discovery argv-only", async () => {
		const source = await Bun.file(SOFTWARE_UPDATES_PATH).text();
		expect(source).toContain(
			'["/usr/bin/apt-get", "update", "--allow-releaseinfo-change"]',
		);
		expect(source).toContain(
			'["/usr/bin/apt-get", "dist-upgrade", "--assume-no"]',
		);
		expect(source).toContain(
			'["/usr/bin/apt-get", ...buildAptInstallArgs(packages)]',
		);
		expect(source).not.toContain("execPNR(");
		expect(source).not.toContain("Bun.$`apt-get");
	});

	it("replaces a hostile output symlink without touching its target", async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), "ceralive-update-output-"),
		);
		const victim = path.join(directory, "victim");
		const stdout = path.join(directory, "software-update.stdout");
		const stderr = path.join(directory, "software-update.stderr");
		try {
			await writeFile(victim, "must remain intact");
			await symlink(victim, stdout);
			await prepareSoftwareUpdateOutput(
				{ stdout, stderr },
				process.getuid?.() ?? 0,
			);

			expect(await readFile(victim, "utf8")).toBe("must remain intact");
			expect((await lstat(stdout)).isFile()).toBe(true);
			expect((await lstat(stdout)).isSymbolicLink()).toBe(false);
			expect((await lstat(stderr)).mode & 0o777).toBe(0o600);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("refuses to read output from a caller-selected path", async () => {
		await expect(
			readSoftwareUpdateOutput("/tmp/update.stdout", 0),
		).rejects.toThrow(/runtime paths are fixed/);
	});

	it("streams progress from durable files while the detached service runs", async () => {
		const paths = {
			stdout: "/run/ceralive/software-update.stdout",
			stderr: "/run/ceralive/software-update.stderr",
		};
		const files = new Map<string, Uint8Array>();
		const encoder = new TextEncoder();
		let polls = 0;
		let inspections = 0;
		let finished = false;
		let cleanupCalls = 0;
		const stdout: string[] = [];
		const stderr: string[] = [];

		const code = await runDetachedAptUpgrade(
			DETACHED_APT_ARGS,
			{
				onStdout: (chunk) => stdout.push(chunk),
				onStderr: (chunk) => stderr.push(chunk),
			},
			{
				outputPaths: paths,
				prepareOutput: async () => {
					files.set(paths.stdout, new Uint8Array());
					files.set(paths.stderr, new Uint8Array());
				},
				start: async () => {},
				inspect: async () => {
					inspections++;
					if (inspections === 1) return { kind: "absent" };
					return finished
						? { kind: "finished", exitCode: 0, cleanup: "stop" }
						: { kind: "running" };
				},
				cleanup: async () => {
					cleanupCalls++;
				},
				readOutput: async (file, offset) => {
					const bytes = files.get(file) ?? new Uint8Array();
					return { bytes: bytes.slice(offset), nextOffset: bytes.byteLength };
				},
				sleep: async () => {
					polls++;
					if (polls === 1) {
						files.set(paths.stdout, encoder.encode("Get:1 package\n"));
						files.set(paths.stderr, encoder.encode("apt warning\n"));
						return;
					}
					files.set(
						paths.stdout,
						encoder.encode("Get:1 package\nSetting up package\n"),
					);
					finished = true;
				},
			},
		);

		expect(code).toBe(0);
		expect(stdout.join("")).toBe("Get:1 package\nSetting up package\n");
		expect(stderr.join("")).toBe("apt warning\n");
		expect(cleanupCalls).toBe(1);
	});

	it("refuses to prepare output or launch when the named unit already exists", async () => {
		let prepared = 0;
		let started = 0;
		const completion = runDetachedAptUpgrade(
			DETACHED_APT_ARGS,
			{ onStdout: () => {}, onStderr: () => {} },
			{
				outputPaths: {
					stdout: "/run/ceralive/software-update.stdout",
					stderr: "/run/ceralive/software-update.stderr",
				},
				prepareOutput: async () => {
					prepared++;
				},
				start: async () => {
					started++;
				},
				inspect: async () => ({ kind: "running" }),
				cleanup: async () => {},
				readOutput: async (_file, offset) => ({
					bytes: new Uint8Array(),
					nextOffset: offset,
				}),
				sleep: async () => {},
			},
		);

		await expect(completion).rejects.toBeInstanceOf(
			DetachedAptServiceAlreadyExistsError,
		);
		expect({ prepared, started }).toEqual({ prepared: 0, started: 0 });
	});

	it("retries transient output and state probe failures without ending the transaction", async () => {
		let inspections = 0;
		let reads = 0;
		let observerErrors = 0;
		const encoder = new TextEncoder();
		const code = await runDetachedAptUpgrade(
			DETACHED_APT_ARGS,
			{
				onStdout: () => {},
				onStderr: () => {},
				onObserverError: () => {
					observerErrors++;
				},
			},
			{
				outputPaths: {
					stdout: "/run/ceralive/software-update.stdout",
					stderr: "/run/ceralive/software-update.stderr",
				},
				prepareOutput: async () => {},
				start: async () => {},
				inspect: async () => {
					inspections++;
					if (inspections === 1) return { kind: "absent" };
					if (inspections === 2)
						throw new Error("systemctl temporarily failed");
					return { kind: "finished", exitCode: 0, cleanup: "stop" };
				},
				cleanup: async () => {},
				readOutput: async (_file, offset) => {
					reads++;
					if (reads === 1) throw new Error("output temporarily unreadable");
					const bytes =
						offset === 0 ? encoder.encode("complete\n") : new Uint8Array();
					return { bytes, nextOffset: offset + bytes.byteLength };
				},
				sleep: async () => {},
			},
		);

		expect(code).toBe(0);
		expect(observerErrors).toBe(2);
	});

	it("retains one output cursor when the other output read fails", async () => {
		const paths = {
			stdout: "/run/ceralive/software-update.stdout",
			stderr: "/run/ceralive/software-update.stderr",
		};
		const stdoutBytes = new TextEncoder().encode("Unpacking package-a\n");
		const stdoutOffsets: number[] = [];
		const stdout: string[] = [];
		let inspections = 0;
		let stderrReads = 0;
		let observerErrors = 0;
		const code = await runDetachedAptUpgrade(
			DETACHED_APT_ARGS,
			{
				onStdout: (chunk) => stdout.push(chunk),
				onStderr: () => {},
				onObserverError: () => {
					observerErrors++;
				},
			},
			{
				outputPaths: paths,
				prepareOutput: async () => {},
				start: async () => {},
				inspect: async () => {
					inspections++;
					if (inspections === 1) return { kind: "absent" };
					if (inspections === 2) return { kind: "running" };
					return { kind: "finished", exitCode: 0, cleanup: "stop" };
				},
				cleanup: async () => {},
				readOutput: async (file, offset) => {
					if (file === paths.stderr) {
						stderrReads++;
						if (stderrReads === 1)
							throw new Error("stderr temporarily unreadable");
						return { bytes: new Uint8Array(), nextOffset: offset };
					}
					stdoutOffsets.push(offset);
					return {
						bytes: stdoutBytes.slice(offset),
						nextOffset: stdoutBytes.byteLength,
					};
				},
				sleep: async () => {},
			},
		);

		expect(code).toBe(0);
		expect(stdout.join("")).toBe("Unpacking package-a\n");
		expect(stdoutOffsets).toEqual([
			0,
			stdoutBytes.byteLength,
			stdoutBytes.byteLength,
		]);
		expect(observerErrors).toBe(1);
	});

	it("retries the final output drain before cleaning up a terminal unit", async () => {
		const paths = {
			stdout: "/run/ceralive/software-update.stdout",
			stderr: "/run/ceralive/software-update.stderr",
		};
		let inspections = 0;
		let terminal = false;
		let failedFinalRead = false;
		let cleanupCalls = 0;
		let observerErrors = 0;
		const code = await runDetachedAptUpgrade(
			DETACHED_APT_ARGS,
			{
				onStdout: () => {},
				onStderr: () => {},
				onObserverError: () => {
					observerErrors++;
				},
			},
			{
				outputPaths: paths,
				prepareOutput: async () => {},
				start: async () => {},
				inspect: async () => {
					inspections++;
					if (inspections === 1) return { kind: "absent" };
					terminal = true;
					return { kind: "finished", exitCode: 0, cleanup: "stop" };
				},
				cleanup: async () => {
					cleanupCalls++;
				},
				readOutput: async (file, offset) => {
					if (terminal && file === paths.stdout && !failedFinalRead) {
						failedFinalRead = true;
						throw new Error("terminal output temporarily unreadable");
					}
					return { bytes: new Uint8Array(), nextOffset: offset };
				},
				sleep: async () => {},
			},
		);

		expect(code).toBe(0);
		expect(observerErrors).toBe(1);
		expect(failedFinalRead).toBe(true);
		expect(cleanupCalls).toBe(1);
	});

	it("bounds a permanently unreadable final drain without deleting recovery evidence", async () => {
		const paths = {
			stdout: "/run/ceralive/software-update.stdout",
			stderr: "/run/ceralive/software-update.stderr",
		};
		let inspections = 0;
		let terminal = false;
		let cleanupCalls = 0;
		let observerErrors = 0;
		const completion = runDetachedAptUpgrade(
			DETACHED_APT_ARGS,
			{
				onStdout: () => {},
				onStderr: () => {},
				onObserverError: () => {
					observerErrors++;
				},
			},
			{
				outputPaths: paths,
				prepareOutput: async () => {},
				start: async () => {},
				inspect: async () => {
					inspections++;
					if (inspections === 1) return { kind: "absent" };
					terminal = true;
					return { kind: "finished", exitCode: 0, cleanup: "stop" };
				},
				cleanup: async () => {
					cleanupCalls++;
				},
				readOutput: async (file, offset) => {
					if (terminal && file === paths.stdout) {
						throw new Error("terminal output permanently unreadable");
					}
					return { bytes: new Uint8Array(), nextOffset: offset };
				},
				sleep: async () => {},
			},
		);

		await expect(completion).rejects.toBeInstanceOf(
			DetachedAptOutputUnavailableError,
		);
		expect(observerErrors).toBe(20);
		expect(cleanupCalls).toBe(0);
	});

	it("reports cleanup failure separately from the retained transaction exit", async () => {
		let inspections = 0;
		const completion = runDetachedAptUpgrade(
			DETACHED_APT_ARGS,
			{ onStdout: () => {}, onStderr: () => {} },
			{
				outputPaths: {
					stdout: "/run/ceralive/software-update.stdout",
					stderr: "/run/ceralive/software-update.stderr",
				},
				prepareOutput: async () => {},
				start: async () => {},
				inspect: async () => {
					inspections++;
					return inspections === 1
						? { kind: "absent" }
						: { kind: "finished", exitCode: 0, cleanup: "stop" };
				},
				cleanup: async () => {
					throw new Error("systemctl stop failed");
				},
				readOutput: async (_file, offset) => ({
					bytes: new Uint8Array(),
					nextOffset: offset,
				}),
				sleep: async () => {},
			},
		);

		await expect(completion).rejects.toMatchObject({
			name: DetachedAptServiceCleanupError.name,
			transactionExitCode: 0,
		});
	});

	it("reattaches after a backend restart without preparing or relaunching apt", async () => {
		const paths = {
			stdout: "/run/ceralive/software-update.stdout",
			stderr: "/run/ceralive/software-update.stderr",
		};
		const encoder = new TextEncoder();
		const files = new Map<string, Uint8Array>([
			[paths.stdout, encoder.encode("Get:1 package\n")],
			[paths.stderr, new Uint8Array()],
		]);
		let finished = false;
		let attached = 0;
		let prepared = 0;
		let started = 0;
		let cleaned = 0;
		const stdout: string[] = [];

		const recovered = await recoverDetachedAptUpgrade(
			{
				onAttached: () => {
					attached++;
				},
				onStdout: (chunk) => stdout.push(chunk),
				onStderr: () => {},
			},
			{
				outputPaths: paths,
				prepareOutput: async () => {
					prepared++;
				},
				start: async () => {
					started++;
				},
				inspect: async () =>
					finished
						? { kind: "finished", exitCode: 0, cleanup: "stop" }
						: { kind: "running" },
				cleanup: async () => {
					cleaned++;
				},
				readOutput: async (file, offset) => {
					const bytes = files.get(file) ?? new Uint8Array();
					return { bytes: bytes.slice(offset), nextOffset: bytes.byteLength };
				},
				sleep: async () => {
					files.set(
						paths.stdout,
						encoder.encode("Get:1 package\nSetting up package\n"),
					);
					finished = true;
				},
			},
		);

		expect(recovered).not.toBeNull();
		if (!recovered) throw new Error("expected detached update recovery");
		expect(await recovered.completion).toBe(0);
		expect(stdout.join("")).toBe("Get:1 package\nSetting up package\n");
		expect({ attached, prepared, started, cleaned }).toEqual({
			attached: 1,
			prepared: 0,
			started: 0,
			cleaned: 1,
		});
	});

	it("keeps recovery fail-closed and retries an inconclusive boot probe", async () => {
		resetSoftwareUpdateState();
		let recoverCalls = 0;
		let retry: (() => void) | undefined;
		let periodicResumes = 0;
		const deps = {
			recover: async () => {
				recoverCalls++;
				if (recoverCalls === 1) throw new Error("systemctl unavailable");
				return null;
			},
			scheduleRetry: (callback: () => void) => {
				retry = callback;
			},
			resumePeriodicChecks: () => {
				periodicResumes++;
			},
		};

		await expect(recoverSoftwareUpdateIfRunning(deps)).rejects.toThrow(
			"systemctl unavailable",
		);
		expect(isSoftwareUpdateRecoveryInconclusive()).toBe(true);
		expect(retry).toBeDefined();
		retry?.();
		await Bun.sleep(0);
		expect(recoverCalls).toBe(2);
		expect(isSoftwareUpdateRecoveryInconclusive()).toBe(false);
		expect(periodicResumes).toBe(1);
		resetSoftwareUpdateState();
	});

	it("joins concurrent recovery callers onto one probe", async () => {
		resetSoftwareUpdateState();
		let recoverCalls = 0;
		let release: (() => void) | undefined;
		const deps = {
			recover: async () => {
				recoverCalls++;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return null;
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		};
		const first = recoverSoftwareUpdateIfRunning(deps);
		const second = recoverSoftwareUpdateIfRunning(deps);
		expect(second).toBe(first);
		expect(recoverCalls).toBe(1);
		release?.();
		expect(await first).toBe(false);
		expect(await second).toBe(false);
		resetSoftwareUpdateState();
	});

	it("probes recovery before the periodic apt refresh can contend for the lock", async () => {
		const source = await Bun.file(MAIN_PATH).text();
		const recovery = source.indexOf(
			'await guardNonCritical("software-update-recovery"',
		);
		const periodic = source.indexOf("periodicCheckForSoftwareUpdates();");
		expect(recovery).toBeGreaterThan(-1);
		expect(periodic).toBeGreaterThan(recovery);
	});
});

describe("parseDetachedAptServiceState() — restart recovery", () => {
	it("distinguishes an absent unit, a running transaction, and both terminal states", () => {
		expect(
			parseDetachedAptServiceState(
				"LoadState=not-found\nActiveState=inactive\n",
			),
		).toEqual({ kind: "absent" });
		expect(
			parseDetachedAptServiceState(
				serviceState({ activeState: "active", subState: "running" }),
			),
		).toEqual({ kind: "running" });
		expect(
			parseDetachedAptServiceState(
				serviceState({
					activeState: "active",
					subState: "exited",
					execMainCode: 1,
				}),
			),
		).toEqual({ kind: "finished", exitCode: 0, cleanup: "stop" });
		expect(
			parseDetachedAptServiceState(
				serviceState({
					activeState: "failed",
					subState: "failed",
					execMainCode: 1,
					execMainStatus: 100,
				}),
			),
		).toEqual({ kind: "finished", exitCode: 100, cleanup: "reset-failed" });
	});

	it("treats activating and reloading as live but rejects unknown loaded states", () => {
		for (const activeState of ["activating", "reloading"]) {
			expect(
				parseDetachedAptServiceState(
					serviceState({ activeState, subState: "start" }),
				),
			).toEqual({ kind: "running" });
		}
		expect(() =>
			parseDetachedAptServiceState(
				serviceState({ activeState: "inactive", subState: "dead" }),
			),
		).toThrow(/unrecognized.*state/);
	});

	it("refuses a unit with a foreign id, user, command, or apt operation", () => {
		for (const output of [
			serviceState({
				activeState: "active",
				subState: "running",
				id: "foreign.service",
			}),
			serviceState({
				activeState: "active",
				subState: "running",
				user: "nobody",
			}),
			serviceState({
				activeState: "active",
				subState: "running",
				execStart: "{ path=/bin/sleep ; argv[]=/bin/sleep 60 ; }",
			}),
			serviceState({
				activeState: "active",
				subState: "running",
				execStart:
					"{ path=/usr/bin/apt-get ; argv[]=/usr/bin/apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold remove ceralui ; }",
			}),
		]) {
			expect(() => validateDetachedAptServiceIdentity(output)).toThrow(
				DetachedAptServiceIdentityError,
			);
		}
	});

	it("binds recovered output to the exact durable files", () => {
		expect(() =>
			validateDetachedAptServiceFragment(`
[Service]
StandardOutput=append:/run/ceralive/software-update.stdout
StandardError=append:/run/ceralive/software-update.stderr
`),
		).not.toThrow();
		expect(() =>
			validateDetachedAptServiceFragment(`
[Service]
StandardOutput=append:/tmp/foreign.stdout
StandardError=append:/run/ceralive/software-update.stderr
`),
		).toThrow(/StandardOutput path does not match/);
		expect(() =>
			validateDetachedAptServiceFragment(`
[Unit]
StandardOutput=append:/run/ceralive/software-update.stdout
[Service]
StandardError=append:/run/ceralive/software-update.stderr
`),
		).toThrow(/StandardOutput path does not match/);
		expect(() =>
			validateDetachedAptServiceFragment(`
[Service]
StandardOutput=append:/run/ceralive/software-update.stdout
StandardOutput=append:/tmp/foreign.stdout
StandardError=append:/run/ceralive/software-update.stderr
`),
		).toThrow(/StandardOutput is duplicated/);
	});

	it("rejects a failed systemctl probe even when stdout looks adoptable", () => {
		expect(() =>
			parseDetachedAptServiceProbe(
				{
					exitCode: 1,
					stdout: serviceState({ activeState: "active", subState: "running" }),
					stderr: "transport failed",
				},
				["systemctl", "show", "ceralive-software-update.service"],
			),
		).toThrow(DetachedAptServiceCommandError);
		expect(
			parseDetachedAptServiceProbe(
				{
					exitCode: 1,
					stdout: "LoadState=not-found\nActiveState=inactive\n",
					stderr: "unit not found",
				},
				["systemctl", "show", "ceralive-software-update.service"],
			),
		).toEqual({ kind: "absent" });
	});
});

describe("deriveAptProgress() — arbitrary output chunk boundaries", () => {
	it("recognizes progress tokens split across several durable-file reads", () => {
		let status = {
			total: 0,
			downloading: 0,
			unpacking: 0,
			setting_up: 0,
		};
		let output = "";
		for (const chunk of [
			"2 upgraded, 0 newly installed, 0 to remove.\nGet:",
			"1 package\nUnpack",
			"ing package-a\nSet",
			"ting up package-a\n",
		]) {
			output += chunk;
			status = deriveAptProgress(status, output);
		}

		expect(status).toEqual({
			total: 2,
			downloading: 2,
			unpacking: 1,
			setting_up: 1,
		});
	});
});

describe("update discovery admission", () => {
	it("coalesces concurrent discovery cycles", async () => {
		let calls = 0;
		let release: (() => void) | undefined;
		setSoftwareUpdateSizeRunner(
			() =>
				new Promise((resolve) => {
					calls++;
					release = () => resolve(null);
				}),
		);
		try {
			const first = runUpdateDiscoveryAndReport();
			await Bun.sleep(0);
			expect(await runUpdateDiscoveryAndReport()).toBe("busy");
			expect(calls).toBe(1);
			release?.();
			expect(await first).toBeNull();
		} finally {
			resetSoftwareUpdateSizeRunner();
		}
	});
});

describe("classifyAptUpdateResult() — Bun.$ exit/stderr classification (Task 16)", () => {
	it("exit 0 with no stderr → null (success)", () => {
		expect(classifyAptUpdateResult(0, "")).toBeNull();
	});

	it("exit 0 but stderr present → true (treated as error, legacy semantics)", () => {
		expect(classifyAptUpdateResult(0, "W: some warning")).toBe(true);
	});

	it("non-zero exit with no stderr → ExecException-shaped error carrying the code", () => {
		const res = classifyAptUpdateResult(100, "");
		expect(res).toBeInstanceOf(Error);
		expect((res as Error & { code?: number }).code).toBe(100);
	});

	it("non-zero exit with stderr → true (stderr dominates the classification)", () => {
		expect(classifyAptUpdateResult(100, "E: failed")).toBe(true);
	});
});

describe("parseAptUpgradeSummary() — named fail-loud apt parser", () => {
	it("parses upgraded + newly-installed count, download size, and CeraLive package presence", () => {
		const result = parseAptUpgradeSummary(`
The following packages will be upgraded:
  ceraui unrelated
2 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.
Need to get 12.3 MB/44.0 MB of archives.
`);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({
				upgradeCount: 3,
				downloadSize: "12.3 MB",
				ceralivePackages: true,
				packages: ["ceraui", "unrelated"],
			});
		}
	});

	it("treats zero updates as a valid summary without requiring size or package headings", () => {
		const result = parseAptUpgradeSummary(
			"0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({
				upgradeCount: 0,
				ceralivePackages: false,
				packages: [],
			});
		}
	});

	it("fails loud when apt's count line drifts", () => {
		const result = parseAptUpgradeSummary("apt output changed shape");
		expect(isParseError(result)).toBe(true);
		if (!result.ok) expect(result.reason).toContain("upgraded/newly installed");
	});

	it("fails loud when upgrades exist but the download-size line is missing", () => {
		const result = parseAptUpgradeSummary(`
The following packages will be upgraded:
  ceraui
1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.
`);
		expect(isParseError(result)).toBe(true);
		if (!result.ok) expect(result.reason).toContain("Need to get");
	});
});
