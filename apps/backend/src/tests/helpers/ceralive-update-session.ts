// One backend process for ceralive-update-notice-restart.test.ts, run as a
// fresh `bun` child that shares only the device files with its siblings. It
// serves the real WebSocket control server (password login, the post-auth
// replay, live broadcasts) on an ephemeral port, initializes the notice like
// main.ts but only after binding (production order: `hydrate` runs it while
// tabs may already be authenticated), and obeys stdin commands: `check` runs
// the real package check over scripted APT, `apt <json>` replaces the device's
// APT state, `block <bin>` holds the next run of that command (its answer fixed
// by the state when it starts) until `release`, `recover` recovers a finished install (which ends the process
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
	APPLIED_MARKER,
	type AptScript,
	BLOCK_SET_MARKER,
	BLOCKED_MARKER,
	CHECKED_MARKER,
	HYDRATED_MARKER,
	READY_PREFIX,
	RECOVERY_FAILED_MARKER,
	RECOVERY_RESTART_MARKER,
	RELEASED_MARKER,
	REPLAY_PREFIX,
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
// The APT state generation: it moves whenever the scripted device state does.
let generation = 0;
const moved = () => {
	generation++;
};
let apt = scriptedApt(step.apt ?? {}, moved);
let block: { bin: string; release?: () => void } | undefined;
updates.setAptCommandRunnerForTest(async (argv) => {
	const answer = apt(argv);
	if (
		block !== undefined &&
		block.release === undefined &&
		argv[0] === block.bin
	) {
		const held = Promise.withResolvers<void>();
		block.release = held.resolve;
		process.stdout.write(`${BLOCKED_MARKER}\n`);
		await held.promise;
	}
	return answer;
});
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

initServer();
process.stdout.write(`${READY_PREFIX}${getServer()?.port}\n`);

for await (const command of console) {
	// Hydration and checks run beside the loop, so `apt`, `block` and `release` can
	// arrive while one of their reads is held.
	if (command === "hydrate") {
		void (async () => {
			if (!step.olderBackend)
				await initCeraliveUpdateNotice({
					path: step.record,
					evidence: () => updates.readAdmittedCeraliveOfferEvidence(),
					generation: () => String(generation),
					observe: (outcome) =>
						process.stdout.write(`${REPLAY_PREFIX}${outcome}\n`),
					...(step.failWrites
						? {
								write: () => {
									throw new Error("state directory is read-only");
								},
							}
						: {}),
				});
			process.stdout.write(`${HYDRATED_MARKER}\n`);
		})().catch((error) =>
			process.stderr.write(`hydrate failed ${String(error)}\n`),
		);
	} else if (command.startsWith("block ")) {
		block = { bin: command.slice(6) };
		process.stdout.write(`${BLOCK_SET_MARKER}\n`);
	} else if (command === "release") {
		block?.release?.();
		block = undefined;
		process.stdout.write(`${RELEASED_MARKER}\n`);
	} else if (command.startsWith("apt ")) {
		apt = scriptedApt(JSON.parse(command.slice(4)), moved);
		moved();
		process.stdout.write(`${APPLIED_MARKER}\n`);
	} else if (command === "check") {
		void updates.runSoftwareUpdateCheck().then(
			() => process.stdout.write(`${CHECKED_MARKER}\n`),
			(error) => process.stderr.write(`check failed ${String(error)}\n`),
		);
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
