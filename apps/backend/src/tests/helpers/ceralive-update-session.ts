// One backend process for ceralive-update-notice-restart.test.ts, run as a
// fresh `bun` child that shares only the device files with its siblings: it
// initializes the notice like main.ts, optionally runs the real package check
// over scripted APT, dismisses what it shows, prints the frames an
// authenticating tab receives, and may then recover a finished install, which
// ends this process through the update's deliberate restart. With `olderBackend`
// it is a backend from before this notice owner: it shows the notice the way
// main did, never initializes or writes the offer record.
import type { NotificationsMessage } from "@ceraui/rpc/schemas";
import { defaultAptSpaceDeps } from "../../modules/system/apt-space-admission.ts";
import { initCeraliveUpdateNotice } from "../../modules/system/ceralive-update-notice.ts";
import * as updates from "../../modules/system/software-updates.ts";
import { setStreamLivenessSourceForTest } from "../../modules/system/stream-liveness-source.ts";
import { setStreamReconciliationCompletedForTest } from "../../modules/system/stream-reconciliation-latch.ts";
import { setUpdateCapabilityPathForTest } from "../../modules/system/update-capabilities.ts";
import { setUpdateSettingsFilePathForTest } from "../../modules/system/update-settings.ts";
import {
	getPersistentNotifications,
	notificationBroadcast,
	notificationDismiss,
	replayedRemovalFrames,
} from "../../modules/ui/notifications.ts";
import {
	type AptScript,
	FRAMES_PREFIX,
	RECOVERY_FAILED_MARKER,
	RECOVERY_RESTART_MARKER,
	RESTART_EXIT_CODE,
	scriptedApt,
} from "./ceralive-update-apt.ts";

export type SessionStep = {
	readonly record: string;
	readonly scratch: string;
	readonly olderBackend?: boolean;
	readonly recoverFails?: boolean;
	readonly check?: AptScript;
	readonly dismiss?: boolean;
	readonly failWrites?: boolean;
	readonly recoverInstall?: boolean;
};

const step = JSON.parse(process.argv[2] ?? "") as SessionStep;
setStreamReconciliationCompletedForTest(true);
setStreamLivenessSourceForTest(() => "idle");
setUpdateCapabilityPathForTest(`${step.scratch}/absent-capabilities.json`);
setUpdateSettingsFilePathForTest(`${step.scratch}/settings.json`);
updates.setAptReachabilityProbeForTest(async () => ({
	ipv4: "ok",
	ipv6: "ok",
	used: "any",
	verdict: "any",
	detail: [],
}));
updates.setAptCommandRunnerForTest((argv) =>
	scriptedApt(step.check ?? {})(argv),
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
	initCeraliveUpdateNotice({
		path: step.record,
		...(step.failWrites
			? {
					write: () => {
						throw new Error("state directory is read-only");
					},
				}
			: {}),
	});
if (step.check) await updates.runSoftwareUpdateCheck();
if (step.dismiss) {
	const seen = getPersistentNotifications(true).show.find(
		({ name }) => name === "ceralive_update",
	);
	notificationDismiss("ceralive_update", seen);
}

const frames: unknown[] = [
	{
		...getPersistentNotifications(true),
		replay: true,
	} satisfies NotificationsMessage,
	...replayedRemovalFrames(true),
];
process.stdout.write(`${FRAMES_PREFIX}${JSON.stringify(frames)}\n`);

if (step.recoverInstall) {
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
	// Stay alive until the update's own restart ends the process (the caller bounds this).
	setInterval(() => undefined, 1000);
} else {
	process.exit(0);
}
