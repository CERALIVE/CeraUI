// One backend process for ceralive-update-notice-restart.test.ts, run as a
// fresh `bun` child that shares only the device files with its siblings. It
// serves the real WebSocket control server (password login, the post-auth
// replay, live broadcasts) on an ephemeral port, initializes the notice like
// main.ts, and obeys stdin commands: `check` runs the real package check over
// scripted APT, `recover` recovers a finished install (which ends the process
// through the update's deliberate restart), `exit` ends it. With
// `olderBackend` it is a backend from before this notice owner: it shows the
// notice the way main did and never initializes or writes the offer record.
import { defaultAptSpaceDeps } from "../../modules/system/apt-space-admission.ts";
import { initCeraliveUpdateNotice } from "../../modules/system/ceralive-update-notice.ts";
import * as updates from "../../modules/system/software-updates.ts";
import { setStreamLivenessSourceForTest } from "../../modules/system/stream-liveness-source.ts";
import { setStreamReconciliationCompletedForTest } from "../../modules/system/stream-reconciliation-latch.ts";
import { setCeraliveSourcesFileForTest } from "../../modules/system/update-apt-channel.ts";
import { setUpdateCapabilityPathForTest } from "../../modules/system/update-capabilities.ts";
import { setUpdateSettingsFilePathForTest } from "../../modules/system/update-settings.ts";
import { notificationBroadcast } from "../../modules/ui/notifications.ts";
import { getServer, initServer } from "../../rpc/server.ts";
import { setPasswordHash } from "../../rpc/state/password.ts";
import {
	type AptScript,
	CHECKED_MARKER,
	READY_PREFIX,
	RECOVERY_FAILED_MARKER,
	RECOVERY_RESTART_MARKER,
	RESTART_EXIT_CODE,
	SESSION_PASSWORD,
	scriptedApt,
} from "./ceralive-update-apt.ts";

export type SessionStep = {
	readonly record: string;
	readonly scratch: string;
	// The device's APT answers for this process's whole life.
	readonly apt?: AptScript;
	readonly olderBackend?: boolean;
	readonly capable?: boolean;
	readonly failWrites?: boolean;
	readonly recoverFails?: boolean;
};

const step = JSON.parse(process.argv[2] ?? "") as SessionStep;
setStreamReconciliationCompletedForTest(true);
setStreamLivenessSourceForTest(() => "idle");
// A capable image declares apt-all-packages; otherwise the legacy discovery runs.
const capabilities = `${step.scratch}/capabilities.json`;
if (step.capable)
	await Bun.write(
		capabilities,
		JSON.stringify({
			schema: 1,
			features: ["apt-all-packages"],
			apt_uid: 42042,
			ota_uid: 42041,
		}),
	);
setUpdateCapabilityPathForTest(
	step.capable ? capabilities : `${step.scratch}/absent-capabilities.json`,
);
setUpdateSettingsFilePathForTest(`${step.scratch}/settings.json`);
setCeraliveSourcesFileForTest(`${step.scratch}/sources`);
updates.setAptReachabilityProbeForTest(async () => ({
	ipv4: "ok",
	ipv6: "ok",
	used: "any",
	verdict: "any",
	detail: [],
}));
updates.setAptCommandRunnerForTest((argv) => scriptedApt(step.apt ?? {})(argv));
setPasswordHash(
	await Bun.password.hash(SESSION_PASSWORD, { algorithm: "bcrypt", cost: 4 }),
);

if (step.olderBackend)
	notificationBroadcast(
		"ceralive_update",
		"warning",
		"A CeraLive update is available. Open Settings → Software Updates to install it.",
		0,
		true,
		true,
	);
else
	await initCeraliveUpdateNotice({
		path: step.record,
		inputs: updates.readCeraliveOfferInputs,
		...(step.failWrites
			? {
					write: () => {
						throw new Error("state directory is read-only");
					},
				}
			: {}),
	});

initServer();
process.stdout.write(`${READY_PREFIX}${getServer()?.port}\n`);

for await (const command of console) {
	if (command === "check") {
		await updates.runSoftwareUpdateCheck();
		process.stdout.write(`${CHECKED_MARKER}\n`);
	} else if (command === "recover") {
		// Only the update's own success restart counts; any other error is a failed recovery.
		for (const event of ["uncaughtException", "unhandledRejection"] as const)
			process.on(event, (error) => {
				if (
					error instanceof Error &&
					error.message === updates.UPDATE_RESTART_REASON
				) {
					process.stdout.write(`${RECOVERY_RESTART_MARKER}\n`);
					process.exit(RESTART_EXIT_CODE);
				}
				process.stderr.write(`${RECOVERY_FAILED_MARKER} ${String(error)}\n`);
				process.exit(1);
			});
		Object.assign(defaultAptSpaceDeps, {
			run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		});
		await updates.recoverSoftwareUpdateIfRunning({
			recover: step.recoverFails
				? async () => {
						throw new Error("detached update unit unreadable");
					}
				: async () => ({
						completion: Promise.resolve(0),
						wasAlreadyFinished: true,
					}),
			scheduleRetry: () => undefined,
			resumePeriodicChecks: () => undefined,
		});
	} else if (command === "exit") {
		process.exit(0);
	}
}
