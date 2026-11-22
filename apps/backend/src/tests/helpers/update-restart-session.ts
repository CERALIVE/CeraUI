// One backend lifetime for update-restart-tab.test.ts, run as a fresh `bun`
// process that shares only the device's files with the others. It boots like
// main.ts (initial pushes withhold package progress before the server binds),
// serves the real WebSocket server, and runs recovery when the test writes
// "recover" (twice, as the orchestrator's resume and main's standalone call do).
import { writeFile } from "node:fs/promises";
import { loadConfig } from "../../modules/config.ts";
import { setup } from "../../modules/setup.ts";
import { defaultAptSpaceDeps } from "../../modules/system/apt-space-admission.ts";
import { setDetachedAptServiceDepsForTest } from "../../modules/system/software-update-service.ts";
import * as updates from "../../modules/system/software-updates.ts";
import { setStreamLivenessSourceForTest } from "../../modules/system/stream-liveness-source.ts";
import { setStreamReconciliationCompletedForTest } from "../../modules/system/stream-reconciliation-latch.ts";
import { setUpdateCapabilityPathForTest } from "../../modules/system/update-capabilities.ts";
import { setUpdateSettingsFilePathForTest } from "../../modules/system/update-settings.ts";
import { initServer } from "../../rpc/server.ts";
import { scriptedApt } from "./update-restart-apt.ts";
import { RESTART_EXIT_CODE, restartTestUnit } from "./update-restart-unit.ts";

const SPACE_TRANSCRIPT = `After this operation, 2 kB of additional disk space will be used.
'https://repo.invalid/a.deb' a.deb 4000 SHA256:abc
`;
const scratch = process.env.SCRATCH ?? "";
const role = process.argv[2];

// Only the finished update's own restart may end a session that recovered it.
for (const event of ["uncaughtException", "unhandledRejection"] as const)
	process.on(event, (error) => {
		if (String(error).includes("exiting to restart CeraUI")) {
			process.stdout.write("session:restart\n");
			process.exit(RESTART_EXIT_CODE);
		}
		process.stderr.write(`session:failed ${String(error)}\n`);
		process.exit(1);
	});

await writeFile(`${scratch}/backend.pid`, String(process.pid));
await loadConfig();
setup.apt_update_enabled = true;
setStreamReconciliationCompletedForTest(true);
setStreamLivenessSourceForTest(() => "idle");
setUpdateCapabilityPathForTest(`${scratch}/absent-capabilities.json`);
setUpdateSettingsFilePathForTest(`${scratch}/settings.json`);
updates.setAptReachabilityProbeForTest(async () => ({
	ipv4: "ok",
	ipv6: "ok",
	used: "any",
	verdict: "any",
	detail: [],
}));
updates.setAptCommandRunnerForTest(scriptedApt);
Object.assign(defaultAptSpaceDeps, {
	run: async (argv: readonly string[]) => ({
		exitCode: 0,
		stdout:
			argv[0] === "/usr/bin/apt-config"
				? "ARCHIVES='/cache/archives/';"
				: argv.includes("clean")
					? ""
					: SPACE_TRANSCRIPT,
		stderr: "",
	}),
	stat: async () => ({ dev: 1n }),
	statfs: async () => ({ bavail: 268441456n, bsize: 1n }),
});
setDetachedAptServiceDepsForTest(
	restartTestUnit(
		scratch,
		role === "after-postinst"
			? {
					failFirstStdoutRead: true,
					holdSecondStdoutRead: `${scratch}/second-read.fifo`,
				}
			: {},
	),
);

updates.beginSoftwareUpdateRecovery();
if (role === "first") await updates.runUpdateDiscoveryAndReport();
initServer();
process.stdout.write("session:listening\n");

for await (const line of console) {
	if (line.trim() !== "recover") continue;
	await updates.recoverSoftwareUpdateIfRunning();
	await updates.recoverSoftwareUpdateIfRunning();
	process.stdout.write("session:recovered\n");
}
