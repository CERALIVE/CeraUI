// One backend process for ceralive-update-notice-restart.test.ts, run as a
// fresh `bun` child that shares only the device files with its siblings: it
// initializes the notice like main.ts, optionally runs the real package check
// over scripted APT, dismisses what it shows, prints the frames an
// authenticating tab receives, and may then recover a finished install, which
// ends this process through the update's deliberate restart.
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
	notificationDismiss,
	replayedRemovalFrames,
} from "../../modules/ui/notifications.ts";
import {
	type AptScript,
	FRAMES_PREFIX,
	RESTART_EXIT_CODE,
	scriptedApt,
} from "./ceralive-update-apt.ts";

export type SessionStep = {
	readonly record: string;
	readonly boot: string;
	readonly build?: string;
	readonly scratch: string;
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

initCeraliveUpdateNotice({
	path: step.record,
	boot: step.boot,
	...(step.build === undefined ? {} : { build: step.build }),
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
	// Nothing else in this session throws once the frames are out, so this exit names the cause.
	for (const event of ["uncaughtException", "unhandledRejection"] as const)
		process.on(event, () => process.exit(RESTART_EXIT_CODE));
	Object.assign(defaultAptSpaceDeps, {
		run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
	});
	await updates.recoverSoftwareUpdateIfRunning({
		recover: async () => ({
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
