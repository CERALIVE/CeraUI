// One backend lifetime for update-restart-tab.test.ts, run as a fresh `bun`
// process that shares only the device's files with the others. It boots like
// main.ts (initial pushes withhold package progress before the socket binds),
// serves the real RPC WebSocket handler on a kernel-assigned loopback port,
// and runs recovery when the test writes "recover" (twice, as the
// orchestrator's resume and main's standalone call do). "park <step>" makes the
// next update wait forever at that step, so the test can kill CeraUI there;
// "crash <step>" kills this backend at once at a step after the unit finished.
import { writeFile } from "node:fs/promises";
import { loadConfig } from "../../modules/config.ts";
import { setup } from "../../modules/setup.ts";
import { defaultAptSpaceDeps } from "../../modules/system/apt-space-admission.ts";
import { setDetachedAptServiceDepsForTest } from "../../modules/system/software-update-service.ts";
import * as updates from "../../modules/system/software-updates.ts";
import { setSshStatusDepsForTest } from "../../modules/system/ssh.ts";
import { setStreamLivenessSourceForTest } from "../../modules/system/stream-liveness-source.ts";
import { setStreamReconciliationCompletedForTest } from "../../modules/system/stream-reconciliation-latch.ts";
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

let parkAt: string | undefined;
let crashAt: string | undefined;
function crash(step: string): void {
	if (crashAt === step) process.kill(process.pid, "SIGKILL");
}
async function park(step: string): Promise<void> {
	if (parkAt !== step) return;
	process.stdout.write(`session:parked ${step}\n`);
	await new Promise<never>(() => undefined);
}

await writeFile(`${scratch}/backend.pid`, String(process.pid));
await loadConfig();
setup.apt_update_enabled = true;
setStreamReconciliationCompletedForTest(true);
setStreamLivenessSourceForTest(() => "idle");
setUpdateCapabilityPathForTest(`${scratch}/absent-capabilities.json`);
setUpdateSettingsFilePathForTest(`${scratch}/settings.json`);
setSshStatusDepsForTest({
	systemctlIsActive: async () => ({ stdout: "inactive\n", stderr: "" }),
	systemctlIsEnabled: async () => ({ stdout: "disabled\n", stderr: "" }),
	readShadow: () => "",
});
updates.setAptReachabilityProbeForTest(async () => {
	await park("reachability");
	return { ipv4: "ok", ipv6: "ok", used: "any", verdict: "any", detail: [] };
});
updates.setAptCommandRunnerForTest(async (argv) => {
	if (argv[1] === "update") await park("apt-update");
	return scriptedApt(argv);
});
Object.assign(defaultAptSpaceDeps, {
	run: async (argv: readonly string[]) => {
		if (!argv.includes("clean")) await park("space");
		return {
			exitCode: 0,
			stdout:
				argv[0] === "/usr/bin/apt-config"
					? "ARCHIVES='/cache/archives/';"
					: argv.includes("clean")
						? ""
						: SPACE_TRANSCRIPT,
			stderr: "",
		};
	},
	stat: async () => ({ dev: 1n }),
	statfs: async () => ({ bavail: 268441456n, bsize: 1n }),
});
const unit = restartTestUnit(
	scratch,
	role === "after-postinst"
		? {
				failFirstStdoutRead: true,
				holdSecondStdoutRead: `${scratch}/second-read.fifo`,
			}
		: { failCleanup: role === "boot" },
);
setDetachedAptServiceDepsForTest({
	...unit,
	inspect: async () => {
		const state = await unit.inspect();
		if (state.kind === "finished") crash("unit-finished");
		return state;
	},
	updateAttempt: (change, options) => {
		const written = unit.updateAttempt(change, options);
		if (written?.exitCode !== undefined) crash("exit-recorded");
		return written;
	},
	cleanup: async (state) => {
		crash("retire");
		return unit.cleanup(state);
	},
	prepareOutput: async () => {
		await park("prepare-output");
		return unit.prepareOutput();
	},
	start: async (command) => {
		await park("unit-start");
		return unit.start(command);
	},
});

updates.beginSoftwareUpdateRecovery();
if (role === "first") await updates.runUpdateDiscoveryAndReport();
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
	if (line.startsWith("crash ")) {
		crashAt = line.slice("crash ".length).trim();
		process.stdout.write(`session:crashing ${crashAt}\n`);
		continue;
	}
	if (line.startsWith("park ")) {
		parkAt = line.slice("park ".length).trim();
		process.stdout.write(`session:parking ${parkAt}\n`);
		continue;
	}
	if (line.trim() !== "recover") continue;
	await updates.recoverSoftwareUpdateIfRunning();
	await updates.recoverSoftwareUpdateIfRunning();
	process.stdout.write("session:recovered\n");
}
