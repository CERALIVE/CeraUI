import { describe, expect, it } from "bun:test";
import { recoverDetachedAptUpgrade } from "../modules/system/software-update-process.ts";
import { buildDetachedAptAllCommand } from "../modules/system/software-update-service.ts";
import {
	DetachedAptServiceIdentityError,
	InvalidDetachedAptUpgradeArgumentsError,
} from "../modules/system/software-update-service-contract.ts";
import { parseDetachedAptServiceProbe } from "../modules/system/software-update-service-state.ts";

// From Rock 5B+ systemctl show after our detached apt-get completed. systemd
// omits unset ExecStartPre/ExecStartPost even when --property names both.
const finishedUnit = `Type=exec
RemainAfterExit=yes
ExecMainCode=1
ExecMainStatus=0
ExecStart={ path=/usr/bin/apt-get ; argv[]=/usr/bin/apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -o Acquire::ForceIPv4=true install cerastream ; ignore_errors=no ; start_time=[Sat 2026-09-26 01:31:39 UTC] ; stop_time=[Sat 2026-09-26 01:31:44 UTC] ; pid=53469 ; code=exited ; status=0 }
StandardOutput=append
StandardError=append
User=
Id=ceralive-software-update.service
Description=CeraLive software update
LoadState=loaded
ActiveState=active
SubState=exited
FragmentPath=/run/systemd/transient/ceralive-software-update.service
Transient=yes
`;

const command = ["systemctl", "show", "ceralive-software-update.service"];
const probe = (stdout: string) =>
	parseDetachedAptServiceProbe({ exitCode: 0, stdout, stderr: "" }, command);

// Captured from systemd on rock-5b-plus 2026-09-28 (completed unit).
const flockFinishedExecStart = `ExecStart={ path=/usr/bin/flock ; argv[]=/usr/bin/flock -x /run/lock/ceralive-update.lock /bin/sh -ec /usr/bin/apt-get -d -y upgrade --with-new-pkgs -o Acquire::ForceIPv4=true && /usr/bin/apt-get -y --no-download --no-remove -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -o Acquire::ForceIPv4=true install ceralive-apt-credentials=1.0.1 cerastream=2026.9.8 ; ignore_errors=no ; start_time=[Mon 2026-09-28 18:05:58 UTC] ; stop_time=[Mon 2026-09-28 18:06:04 UTC] ; pid=1088904 ; code=exited ; status=0 }`;
// Running form of the rock-5b-plus 2026-09-28 systemd rendering.
const flockRunningExecStart = `ExecStart={ path=/usr/bin/flock ; argv[]=/usr/bin/flock -x /run/lock/ceralive-update.lock /bin/sh -ec /usr/bin/apt-get -d -y upgrade --with-new-pkgs -o Acquire::ForceIPv4=true && /usr/bin/apt-get -y --no-download --no-remove -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -o Acquire::ForceIPv4=true install ceralive-apt-credentials=1.0.1 cerastream=2026.9.8 ; ignore_errors=no ; start_time=[Mon 2026-09-28 18:05:58 UTC] ; stop_time=[n/a] ; pid=1088904 ; code=(null) ; status=0/0 }`;
const flockUnit = (execStart: string) =>
	finishedUnit.replace(/^ExecStart=.*$/m, execStart);

describe("detached apt unit hook identity on a real systemd show", () => {
	it("accepts an omitted no-hook pair and observes the completed transaction", () => {
		expect(probe(finishedUnit)).toEqual({
			kind: "finished",
			exitCode: 0,
			cleanup: "stop",
		});
	});

	it.each(["ExecStartPre", "ExecStartPost"])(
		"refuses a foreign unit with a populated %s hook",
		(hook) => {
			expect(() =>
				probe(`${finishedUnit}${hook}={ path=/bin/true ; }\n`),
			).toThrow(DetachedAptServiceIdentityError);
		},
	);

	it("retains compatibility with systemd versions that print empty hook fields", () => {
		expect(probe(`${finishedUnit}ExecStartPre=\nExecStartPost=\n`)).toEqual({
			kind: "finished",
			exitCode: 0,
			cleanup: "stop",
		});
	});

	it("adopts the completed flock unit rendered by systemd on the board", () => {
		expect(probe(flockUnit(flockFinishedExecStart))).toEqual({
			kind: "finished",
			exitCode: 0,
			cleanup: "stop",
		});
	});

	it("adopts the running flock unit rendered by systemd", () => {
		expect(
			probe(
				flockUnit(flockRunningExecStart).replace(
					"SubState=exited",
					"SubState=running",
				),
			),
		).toEqual({ kind: "running" });
	});

	it.each(["--allow-unauthenticated", "-o", "-y", "+x", ".x", ":x", "~x"])(
		"refuses a real-rendering flock unit with %s as a pinned package name",
		(name) => {
			expect(() =>
				probe(
					flockUnit(
						flockFinishedExecStart.replace(
							"ceralive-apt-credentials=1.0.1 cerastream=2026.9.8 ; ignore_errors=",
							`${name}=1 ; ignore_errors=`,
						),
					),
				),
			).toThrow(DetachedAptServiceIdentityError);
		},
	);

	it.each(["foreign-first", "foreign-last"])(
		"refuses two ExecStart properties with %s",
		(order) => {
			const foreign = "ExecStart={ path=/bin/true ; argv[]=/bin/true ; }";
			const extra =
				order === "foreign-first"
					? `${foreign}\n${flockFinishedExecStart}`
					: `${flockFinishedExecStart}\n${foreign}`;
			expect(() =>
				probe(
					flockUnit(flockFinishedExecStart).replace(
						flockFinishedExecStart,
						extra,
					),
				),
			).toThrow(DetachedAptServiceIdentityError);
		},
	);

	it("round-trips the launcher's script through systemd's real ExecStart rendering", () => {
		const launcher = buildDetachedAptAllCommand(
			[
				"-y",
				"--no-download",
				"--no-remove",
				"-o",
				"Dpkg::Options::=--force-confdef",
				"-o",
				"Dpkg::Options::=--force-confold",
				"-o",
				"Acquire::ForceIPv4=true",
				"install",
				"ceralive-apt-credentials=1.0.1",
				"cerastream=2026.9.8",
			],
			"force_ipv4",
			{
				stdout: "/run/ceralive/software-update.stdout",
				stderr: "/run/ceralive/software-update.stderr",
			},
		);
		const script = launcher.at(-1);
		expect(script).toBeDefined();
		expect(() =>
			probe(
				flockUnit(
					flockFinishedExecStart.replace(
						/^ExecStart=.*? \/bin\/sh -ec .*? ; ignore_errors=/,
						`ExecStart={ path=/usr/bin/flock ; argv[]=/usr/bin/flock -x /run/lock/ceralive-update.lock /bin/sh -ec ${script} ; ignore_errors=`,
					),
				),
			),
		).not.toThrow();
	});

	it.each([
		["flock path", "/usr/bin/flock", "/tmp/flock"],
		["lock path", "/run/lock/ceralive-update.lock", "/tmp/foreign.lock"],
		["shell", "/bin/sh -ec", "/bin/bash -ec"],
		[
			"chained command",
			"cerastream=2026.9.8 ; ignore_errors=",
			"cerastream=2026.9.8 && rm -rf / ; ignore_errors=",
		],
		["no-download", " --no-download", ""],
		["no-remove", " --no-remove", ""],
		[
			"package order",
			"ceralive-apt-credentials=1.0.1 cerastream=2026.9.8",
			"cerastream=2026.9.8 ceralive-apt-credentials=1.0.1",
		],
		["unpinned package", "cerastream=2026.9.8", "cerastream"],
		[
			"injected metadata boundary",
			"cerastream=2026.9.8 ; ignore_errors=",
			"cerastream=2026.9.8 ; ignore_errors=no ; /bin/true ; ignore_errors=",
		],
		["download phase", " -d -y upgrade", " -y upgrade"],
		[
			"different family",
			"Acquire::ForceIPv4=true &&",
			"Acquire::ForceIPv6=true &&",
		],
		["metadata refusal", " ; ignore_errors=no ;", " ; ignore_errors=yes ;"],
	])("refuses a flock unit with %s changed", (_name, original, changed) => {
		expect(() =>
			probe(flockUnit(flockFinishedExecStart.replace(original, changed))),
		).toThrow(DetachedAptServiceIdentityError);
	});

	it("rejects metadata delimiters, spaces and quotes in a pinned package token before launch", () => {
		for (const token of [
			"cerastream=2026.9.8 ; ignore_errors=no",
			"cerastream=2026.9.8 malicious",
			"cerastream='2026.9.8'",
		]) {
			expect(() =>
				buildDetachedAptAllCommand(
					[
						"-y",
						"--no-download",
						"--no-remove",
						"-o",
						"Dpkg::Options::=--force-confdef",
						"-o",
						"Dpkg::Options::=--force-confold",
						"install",
						token,
					],
					"any",
					{
						stdout: "/run/ceralive/software-update.stdout",
						stderr: "/run/ceralive/software-update.stderr",
					},
				),
			).toThrow(InvalidDetachedAptUpgradeArgumentsError);
		}
	});

	it("allows the observer to drain and clean up after a running unit finishes", async () => {
		let reads = 0;
		let cleaned = 0;
		const recovered = await recoverDetachedAptUpgrade(
			{ onStdout: () => {}, onStderr: () => {} },
			{
				outputPaths: {
					stdout: "/run/ceralive/software-update.stdout",
					stderr: "/run/ceralive/software-update.stderr",
				},
				prepareOutput: async () => {},
				start: async () => {},
				inspect: async () =>
					probe(
						reads === 0
							? finishedUnit.replace("SubState=exited", "SubState=running")
							: finishedUnit,
					),
				cleanup: async () => {
					cleaned++;
				},
				readOutput: async (_file, offset) => ({
					bytes: new Uint8Array(),
					nextOffset: offset,
				}),
				sleep: async () => {
					reads++;
				},
			},
		);
		expect(recovered).not.toBeNull();
		expect(await recovered?.completion).toBe(0);
		expect(cleaned).toBe(1);
	});

	it("backs off a refused service probe and throttles warnings until the owned unit can be observed", async () => {
		let clock = 0;
		let inspections = 0;
		let cleaned = 0;
		const sleeps: number[] = [];
		const reports: { at: number; suppressed: number }[] = [];
		const running = flockUnit(flockRunningExecStart).replace(
			"SubState=exited",
			"SubState=running",
		);
		const foreign = running.replace(
			"/run/lock/ceralive-update.lock",
			"/tmp/foreign.lock",
		);
		const recovered = await recoverDetachedAptUpgrade(
			{
				onStdout: () => {},
				onStderr: () => {},
				onObserverError: (error, suppressed = 0) => {
					expect(error).toBeInstanceOf(DetachedAptServiceIdentityError);
					reports.push({ at: clock, suppressed });
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
					if (inspections === 1) return probe(running);
					if (inspections <= 9) return probe(foreign);
					return probe(flockUnit(flockFinishedExecStart));
				},
				cleanup: async () => {
					cleaned++;
				},
				readOutput: async (_file, offset) => ({
					bytes: new Uint8Array(),
					nextOffset: offset,
				}),
				sleep: async (milliseconds) => {
					sleeps.push(milliseconds);
					clock += milliseconds;
				},
				now: () => clock,
			},
		);
		expect(await recovered?.completion).toBe(0);
		expect(cleaned).toBe(1);
		expect(sleeps).toEqual([
			250, 1_000, 250, 2_000, 250, 4_000, 250, 8_000, 250, 16_000, 250, 30_000,
			250, 30_000, 250, 30_000, 250,
		]);
		expect(reports).toEqual([
			{ at: 250, suppressed: 0 },
			{ at: 32_500, suppressed: 4 },
			{ at: 62_750, suppressed: 0 },
			{ at: 93_000, suppressed: 0 },
		]);
	});
});
