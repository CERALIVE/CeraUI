// One backend lifetime for update-restart-tab.test.ts, run as a fresh `bun`
// process that shares only the device's files with the others. It serves the
// real RPC WebSocket handler on a kernel-assigned loopback port, with main's
// initial status (nothing about a surviving unit until recovery has looked),
// and runs main's recovery when the test writes "recover". The "refused" role
// is a boot whose update startup was refused, as main.ts marks it, so recovery
// never looks at the unit. The device is capable (versioned pins) except in
// the "legacy-first" role. dpkg-query and dpkg are the test's, on PATH.
import { writeFile } from "node:fs/promises";
import { loadConfig } from "../../modules/config.ts";
import { setup } from "../../modules/setup.ts";
import { defaultAptSpaceDeps } from "../../modules/system/apt-space-admission.ts";
import { markBootDegraded } from "../../modules/system/readiness.ts";
import { setDetachedAptServiceDepsForTest } from "../../modules/system/software-update-service.ts";
import * as updates from "../../modules/system/software-updates.ts";
import { setSshStatusDepsForTest } from "../../modules/system/ssh.ts";
import { setStreamLivenessSourceForTest } from "../../modules/system/stream-liveness-source.ts";
import { setStreamReconciliationCompletedForTest } from "../../modules/system/stream-reconciliation-latch.ts";
import { setCeraliveSourcesFileForTest } from "../../modules/system/update-apt-channel.ts";
import { setUpdateCapabilityPathForTest } from "../../modules/system/update-capabilities.ts";
import { setUpdateSettingsFilePathForTest } from "../../modules/system/update-settings.ts";
import {
	createServerWebSocketHandler,
	initSocketData,
} from "../../rpc/adapter.ts";
import type { ServerSocketData } from "../../rpc/types.ts";
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
setUpdateCapabilityPathForTest(
	role === "legacy-first"
		? `${scratch}/absent-capabilities.json`
		: `${scratch}/capabilities.json`,
);
setCeraliveSourcesFileForTest(`${scratch}/ceralive.sources`);
setUpdateSettingsFilePathForTest(`${scratch}/settings.json`);
setSshStatusDepsForTest({
	systemctlIsActive: async () => ({ stdout: "inactive\n", stderr: "" }),
	systemctlIsEnabled: async () => ({ stdout: "disabled\n", stderr: "" }),
	readShadow: () => "",
});
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

if (role === "first" || role === "legacy-first")
	await updates.runUpdateDiscoveryAndReport();
if (role === "refused") markBootDegraded("update-orchestrator-maintenance");
const server = Bun.serve<ServerSocketData>({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (request, srv) =>
		new URL(request.url).pathname === "/ws" &&
		srv.upgrade(request, { data: initSocketData() })
			? undefined
			: new Response(null, { status: 404 }),
	websocket: createServerWebSocketHandler(),
});
process.stdout.write(`session:listening ${server.port}\n`);

for await (const line of console) {
	if (line.trim() === "exit") {
		// A restart already decided would have ended the process first.
		await new Promise((resolve) => setImmediate(resolve));
		process.exit(0);
	}
	if (line.trim() !== "recover") continue;
	await updates.recoverSoftwareUpdateIfRunning();
	process.stdout.write("session:recovered\n");
}
