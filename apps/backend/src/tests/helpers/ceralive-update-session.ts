// One backend process for ceralive-update-notice-restart.test.ts, run as a
// fresh `bun` child that shares only the device files with its siblings. It
// serves the real WebSocket control server (password login, the post-auth
// delivery, live broadcasts) on an ephemeral port, initializes the notice like
// main.ts but only after binding (production order: `hydrate` runs it while
// tabs may already be authenticated), and obeys stdin commands: `check` runs
// the real package check over scripted APT, `apt <json>` replaces the device's
// APT state, `recover` recovers a finished install through the real completion
// path up to the update's deliberate restart, which it holds until `exit` (so a
// test can sync its tabs first), `exit` ends it. `pause-dpkg-read before|after`
// holds the next dpkg read of the device (the scheduled notice's proof) until
// `resume-dpkg-read`. The notice's dpkg readback reads
// the same scripted device. With `olderBackend` it is started with
// main-backend-preload.ts: main's backend from before this notice owner, whose
// own check raises the notice the way main did, and which never initializes or
// writes the offer record.
import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { defaultAptSpaceDeps } from "../../modules/system/apt-space-admission.ts";
import * as updates from "../../modules/system/software-updates.ts";
import { setStreamLivenessSourceForTest } from "../../modules/system/stream-liveness-source.ts";
import { setStreamReconciliationCompletedForTest } from "../../modules/system/stream-reconciliation-latch.ts";
import { setCeraliveSourcesFileForTest } from "../../modules/system/update-apt-channel.ts";
import { setUpdateCapabilityPathForTest } from "../../modules/system/update-capabilities.ts";
import { DownloadPausedLedger } from "../../modules/system/update-orchestrator/download-paused-ledger.ts";
import { DownloadPausedNotices } from "../../modules/system/update-orchestrator/download-paused-notices.ts";
import { UpdateQuarantine } from "../../modules/system/update-orchestrator/quarantine.ts";
import {
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../../modules/system/update-orchestrator/types.ts";
import { setUpdateSettingsFilePathForTest } from "../../modules/system/update-settings.ts";
import { getServer, initServer } from "../../rpc/server.ts";
import { setPasswordHash } from "../../rpc/state/password.ts";
import {
	APPLIED_MARKER,
	type AptScript,
	CHECKED_MARKER,
	HYDRATED_MARKER,
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
	readonly canonicalScheduler?: boolean;
	readonly capable?: boolean;
	readonly failWrites?: boolean;
	// The scheduled package notice's receipt writes fail (its deletion still works).
	readonly failReceiptWrites?: boolean;
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
let apt = scriptedApt(step.apt ?? {});
let compareGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let holdGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
// The next dpkg-query this runner serves pauses before it reads, or after it answered.
let readGate:
	| {
			readonly when: "before" | "after";
			readonly gate: ReturnType<typeof Promise.withResolvers<void>>;
	  }
	| undefined;
let releaseRead: (() => void) | undefined;
// Discovery and the scheduled package notice read the device through this runner.
const gated = async (argv: readonly string[]) => {
	const paused = argv[0] === "dpkg-query" ? readGate : undefined;
	if (paused) readGate = undefined;
	if (paused?.when === "before") {
		process.stdout.write("backend:dpkg-read-pending\n");
		await paused.gate.promise;
	}
	const answer = await apt(argv);
	if (paused?.when === "after") {
		process.stdout.write("backend:dpkg-read-captured\n");
		await paused.gate.promise;
	}
	if (argv[0] === "dpkg" && argv[1] === "--compare-versions" && compareGate) {
		process.stdout.write("backend:compare-captured\n");
		await compareGate.promise;
	}
	if (argv[0] === "/usr/bin/apt-mark" && argv[1] === "showhold" && holdGate) {
		process.stdout.write("backend:holds-captured\n");
		await holdGate.promise;
	}
	return answer;
};
updates.setAptCommandRunnerForTest(gated);
// Set once the finished install reached the update's own restart.
let restarting = false;
setPasswordHash(
	await Bun.password.hash(SESSION_PASSWORD, { algorithm: "bcrypt", cost: 4 }),
);

initServer();
process.stdout.write(`${READY_PREFIX}${getServer()?.port}\n`);

for await (const command of console) {
	if (command === "hydrate") {
		// Main's backend has no such module (and its notifications lack what it imports).
		if (!step.olderBackend)
			(
				await import("../../modules/system/ceralive-update-notice.ts")
			).initCeraliveUpdateNotice({
				path: step.record,
				run: (argv) => apt(argv),
				...(step.failWrites
					? {
							write: () => {
								throw new Error("state directory is read-only");
							},
						}
					: {}),
			});
		// Main's scheduler (the baseline child) has no such owner.
		if (!step.olderBackend && !step.canonicalScheduler) {
			for (const file of ["boot_id", "backend"])
				if (!existsSync(`${step.scratch}/${file}`))
					writeFileSync(`${step.scratch}/${file}`, `${crypto.randomUUID()}\n`);
			(
				await import(
					"../../modules/system/update-orchestrator/package-offer-notice.ts"
				)
			).initScheduledPackageNotice({
				path: `${step.scratch}/scheduled_package_notices.json`,
				run: gated,
				// Stand-ins the tests replace for a reboot and a backend reinstall.
				boot: `${step.scratch}/boot_id`,
				backend: `${step.scratch}/backend`,
				// Every receipt read and write is logged, so a test sees a check that touches none.
				read: (path) => {
					appendFileSync(`${step.scratch}/receipt-io.log`, "read\n");
					return existsSync(path) ? readFileSync(path, "utf8") : null;
				},
				write: (path, text) => {
					appendFileSync(`${step.scratch}/receipt-io.log`, "write\n");
					if (step.failReceiptWrites)
						throw new Error("state directory is full");
					writeFileSync(path, text);
				},
			});
		}
		process.stdout.write(`${HYDRATED_MARKER}\n`);
	} else if (command.startsWith("apt ")) {
		apt = scriptedApt(JSON.parse(command.slice(4)));
		process.stdout.write(`${APPLIED_MARKER}\n`);
	} else if (command === "pause-package-compare") {
		compareGate = Promise.withResolvers<void>();
		process.stdout.write("backend:compare-armed\n");
	} else if (command === "pause-package-holds") {
		holdGate = Promise.withResolvers<void>();
		process.stdout.write("backend:holds-armed\n");
	} else if (command === "resume-package-holds") {
		holdGate?.resolve();
		holdGate = undefined;
	} else if (command.startsWith("pause-dpkg-read ")) {
		const gate = Promise.withResolvers<void>();
		readGate = {
			when: command.endsWith("before") ? "before" : "after",
			gate,
		};
		releaseRead = gate.resolve;
		process.stdout.write("backend:dpkg-read-armed\n");
	} else if (command === "resume-dpkg-read") {
		releaseRead?.();
		releaseRead = undefined;
	} else if (command === "resume-package-compare") {
		compareGate?.resolve();
		compareGate = undefined;
	} else if (command === "check") {
		void updates.runSoftwareUpdateCheck().then(
			() => process.stdout.write(`${CHECKED_MARKER}\n`),
			(error) => process.stderr.write(`check failed ${String(error)}\n`),
		);
	} else if (command === "scheduled-package-check") {
		// Take the real scheduler path at a due, idle check boundary without
		// running unrelated OS observers or touching the machine's state.
		const now = Date.now();
		setOrchestratorStateForTest(initialOrchestratorState(now));
		setOrchestratorRuntimeDepsForTest({
			now: () => now,
			persist: () => undefined,
			isUpdateAdmissionReady: async () => true,
			readOsReceiptEvidence: async () => undefined,
			isReceiptAckPending: () => false,
			observeCredentials: async () => undefined,
			onlyMeteredCandidateExists: async () => false,
			quarantine: new UpdateQuarantine(`${step.scratch}/quarantine.json`),
			loadSettings: async () => ({
				packagesAuto: true,
				systemAuto: false,
				schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
				channel: "stable",
				allowPackagesOverCellular: false,
				allowSystemOverCellular: false,
			}),
			downloadNotices: new DownloadPausedNotices({
				ledger: new DownloadPausedLedger(
					`${step.scratch}/download-notices.json`,
				),
				publish: () => undefined,
				clear: () => undefined,
				report: () => undefined,
			}),
		});
		void runOrchestratorTick().then(
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
					restarting = true;
					process.stdout.write(`${RECOVERY_RESTART_MARKER}\n`);
					return;
				}
				process.stderr.write(`${RECOVERY_FAILED_MARKER} ${String(error)}\n`);
				process.exit(1);
			});
		Object.assign(defaultAptSpaceDeps, {
			run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		});
		// Beside the loop, so `exit` can end the held restart.
		void updates
			.recoverSoftwareUpdateIfRunning({
				recover: step.recoverFails
					? async () => {
							throw new Error("detached update unit unreadable");
						}
					: async (handlers) => {
							// As the real recovery does once it finds the unit.
							handlers.onAttached?.();
							return {
								completion: Promise.resolve(0),
								wasAlreadyFinished: true,
							};
						},
				scheduleRetry: () => undefined,
				resumePeriodicChecks: () => undefined,
			})
			.catch((error) => {
				process.stderr.write(`${RECOVERY_FAILED_MARKER} ${String(error)}\n`);
				process.exit(1);
			});
	} else if (command === "exit") {
		process.exit(restarting ? RESTART_EXIT_CODE : 0);
	}
}
