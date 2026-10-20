import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../helpers/logger.ts";
import type { SpawnWithTimeoutResult } from "../helpers/spawn-policy.ts";
import {
	getUpdateState,
	resetAptReachabilityProbeForTest,
	resetSoftwareUpdateCheckRunner,
	resetSoftwareUpdateState,
	runUpdateDiscoveryAndReport,
	setAptCommandRunnerForTest,
	setAptReachabilityProbeForTest,
	setSoftwareUpdateCheckRunner,
	startSoftwareUpdate,
} from "../modules/system/software-updates.ts";
import { setCeraliveSourcesFileForTest } from "../modules/system/update-apt-channel.ts";
import { setUpdateCapabilityPathForTest } from "../modules/system/update-capabilities.ts";
import { setUpdateSettingsFilePathForTest } from "../modules/system/update-settings.ts";
import * as notifications from "../modules/ui/notifications.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();
const sentinel = "DISCOVERY_AUDIT_SENTINEL";
const simulation = "Inst libc6 [1] (2 Debian:13/stable [amd64])\n";
const inventory = `Package files:
 500 https://deb.debian.org/debian trixie/main amd64 Packages
     release o=Debian,n=trixie,l=Debian
     origin deb.debian.org
Pinned packages:
`;
const policy = `libc6:
  Candidate: 2
  Version table:
     2 500
        500 https://deb.debian.org/debian trixie/main amd64 Packages
`;
let dir = "";
let failureCommand = "inventory";
let stderr = `E: ${sentinel}`;
let simulationText = simulation;
let recheckText = simulation;
let recheckExit = 0;
const commands: string[][] = [];
let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
let notification: ReturnType<
	typeof spyOn<typeof notifications, "notificationBroadcast">
>;

beforeEach(async () => {
	// Given: a private capable image, explicit idle owner and argv-only APT port.
	dir = await mkdtemp(join(tmpdir(), "apt-diag-"));
	const capability = join(dir, "capabilities.json");
	await writeFile(
		capability,
		JSON.stringify({
			schema: 1,
			features: ["apt-all-packages"],
			apt_uid: 42042,
			ota_uid: 42041,
		}),
	);
	setUpdateCapabilityPathForTest(capability);
	setCeraliveSourcesFileForTest(join(dir, "sources"));
	setUpdateSettingsFilePathForTest(join(dir, "settings.json"));
	resetSoftwareUpdateState();
	failureCommand = "inventory";
	stderr = `E: ${sentinel}`;
	simulationText = simulation;
	recheckText = simulation;
	recheckExit = 0;
	commands.length = 0;
	setAptReachabilityProbeForTest(async () => ({
		ipv4: "ok",
		ipv6: "ok",
		used: "any",
		verdict: "any",
		detail: [],
	}));
	setAptCommandRunnerForTest(async (argv): Promise<SpawnWithTimeoutResult> => {
		commands.push([...argv]);
		if (argv[1] === "policy") {
			const command = argv[2] ? "package" : "inventory";
			return command === failureCommand
				? { exitCode: 100, stdout: "", stderr }
				: { exitCode: 0, stdout: argv[2] ? policy : inventory, stderr: "" };
		}
		if (argv.includes("install"))
			return { exitCode: recheckExit, stdout: recheckText, stderr };
		return {
			exitCode: 0,
			stderr: "",
			stdout: argv[1] === "-s" ? simulationText : "",
		};
	});
	warn = spyOn(logger, "warn");
	notification = spyOn(notifications, "notificationBroadcast");
});

afterEach(async () => {
	warn.mockRestore();
	notification.mockRestore();
	setAptCommandRunnerForTest(null);
	setUpdateCapabilityPathForTest(null);
	setCeraliveSourcesFileForTest(null);
	setUpdateSettingsFilePathForTest(null);
	resetAptReachabilityProbeForTest();
	resetSoftwareUpdateCheckRunner();
	resetSoftwareUpdateState();
	notifications.notificationRemove("ceralive_update_failed");
	await rm(dir, { recursive: true, force: true });
});

function installAttempt(): Promise<void> {
	const completion = Promise.withResolvers<void>();
	setSoftwareUpdateCheckRunner((callback) => {
		queueMicrotask(() => {
			Promise.resolve(callback(null, 0)).then(
				() => completion.resolve(),
				completion.reject,
			);
		});
		return true;
	});
	expect(startSoftwareUpdate()).toEqual({ started: true });
	return completion.promise;
}

it.each([
	["inventory", "source-policy"],
	["package", "package-policy"],
])(
	"logs the command exit and stderr when %s policy fails",
	async (command, step) => {
		failureCommand = command;
		// When: real capable discovery handles the injected command refusal.
		await runUpdateDiscoveryAndReport();
		// Then: the handling boundary retains the distinguishing evidence once.
		expect(warn).toHaveBeenCalledWith("Capable APT update refused", {
			reason: "discovery_failed",
			step,
			exit: 100,
			detail: `E: ${sentinel}`,
		});
	},
);

it("logs a parse reason when an Inst row is malformed", async () => {
	failureCommand = "none";
	simulationText = `Inst ${sentinel}\n`;
	// When
	await runUpdateDiscoveryAndReport();
	// Then
	expect(warn).toHaveBeenCalledWith("Capable APT update refused", {
		reason: "discovery_failed",
		step: "parse-simulation",
		exit: undefined,
		detail: `invalid or duplicate Inst row: Inst ${sentinel}`,
	});
});

it("logs the mismatched vector when a pinned recheck differs", async () => {
	failureCommand = "none";
	recheckText =
		"Inst libc6 [1] (2+RECHECK-AUDIT-SENTINEL Debian:13/stable [amd64])\n";
	// When
	await installAttempt();
	// Then
	expect(warn).toHaveBeenCalledWith("Capable APT update refused", {
		reason: "discovery_failed",
		step: "pinned-recheck",
		exit: undefined,
		detail: "pinned package/version mismatch: libc6=2+RECHECK-AUDIT-SENTINEL",
	});
	expect(
		commands.every(
			(argv) =>
				argv[1] === "-s" || argv[1] === "policy" || argv[1] === "showhold",
		),
	).toBe(true);
});

it("logs stderr when the pinned simulation command exits nonzero", async () => {
	failureCommand = "none";
	recheckExit = 100;
	// When
	await installAttempt();
	// Then
	expect(warn).toHaveBeenCalledWith("Capable APT update refused", {
		reason: "discovery_failed",
		step: "pinned-simulation",
		exit: 100,
		detail: stderr,
	});
});

it("keeps the existing failed state and notification bytes when discovery refuses", async () => {
	// When
	await runUpdateDiscoveryAndReport();
	// Then: these assertions pass on the unmodified parent too.
	expect(JSON.stringify(getUpdateState())).toBe(
		'{"kind":"failed","reason":"discovery_failed"}',
	);
	expect(JSON.stringify(notification.mock.calls.at(-1))).toBe(
		'["ceralive_update_failed","error","The software update was refused. Open Settings → Software Updates to see the reason.",0,true,true]',
	);
});

it("keeps the existing failed state and notification bytes when recheck refuses", async () => {
	failureCommand = "none";
	recheckExit = 100;
	// When
	await installAttempt();
	// Then
	expect(JSON.stringify(getUpdateState())).toBe(
		'{"kind":"failed","reason":"discovery_failed"}',
	);
	expect(JSON.stringify(notification.mock.calls.at(-1))).toBe(
		'["ceralive_update_failed","error","The software update was refused. Open Settings → Software Updates to see the reason.",0,true,true]',
	);
});

it("logs once when identical discovery refusals recur across retry calls", async () => {
	// When: one retry sequence reaches the same handling catch three times.
	for (let attempt = 0; attempt < 3; attempt++)
		await runUpdateDiscoveryAndReport();
	// Then
	expect(warn).toHaveBeenCalledTimes(1);
});

it("logs once when identical pre-install refusals recur", async () => {
	failureCommand = "none";
	recheckExit = 100;
	// When
	for (let attempt = 0; attempt < 3; attempt++) await installAttempt();
	// Then
	expect(warn).toHaveBeenCalledTimes(1);
});

it("redacts credentials and bounds stderr before passing it to the logger", async () => {
	stderr = `E: ${sentinel}\npassword=fixture-password\nhttps://fixture-user:fixture-password@apt.example/path?token=fixture-token\n${"x".repeat(1500)}`;
	// When
	await runUpdateDiscoveryAndReport();
	// Then: capture the logger INPUT, not its downstream redaction backstop.
	const calls = JSON.stringify(warn.mock.calls);
	expect(calls).toContain(sentinel);
	expect(calls).not.toMatch(/fixture-password|fixture-user|fixture-token/);
	expect(calls).not.toContain("x".repeat(501));
});
