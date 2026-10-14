import { spyOn } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createAddonHelperStep } from "../../helpers/addon-helper-step.ts";
import * as spawnPolicy from "../../helpers/spawn-policy.ts";
import { setSysextEvidenceForTest } from "../../modules/addons/disruptive-sysext-step.ts";
import { probeServiceCompletion } from "../../modules/system/disruptive-service-reservation.ts";
import { helperDispatchFixture } from "./helper-dispatch-fixture.ts";

export const HELPER_SURVIVORS = [
	"jq",
	"install",
	"rm",
	"mkdir",
	"ln",
	"sha256sum",
	"cut",
	"gpgv",
	"cat",
	"systemctl:unmask",
	"systemctl:enable",
	"systemctl:start",
	"systemctl:stop",
	"systemctl:disable",
	"systemctl:mask",
	"systemd-sysext:refresh",
] as const;

// A scratch helper forks a tool, waits for its READY, then exits. The tool keeps
// the inherited group, redirects pipes, and cannot finish before our release.
const HELPER = `#!/usr/bin/python3
import os, sys, signal, json
signal.alarm(30)
d = os.path.dirname(sys.argv[0])
actor = open(d + '/actor').read().split(':')
for name in ['ready', 'release']: os.mkfifo(d + '/' + name)
p = os.fork()
if p == 0:
 signal.alarm(30)
 for fd in [1, 2]: os.dup2(os.open('/dev/null', os.O_WRONLY), fd)
 os.execv('/usr/bin/bash', ['/usr/bin/bash', d + '/' + actor[0], d] + actor[1:])
with open(d + '/ready') as f: f.read(1)
print(json.dumps({'pid': p, 'pgid': os.getpgrp(), 'sid': os.getsid(0)}), flush=True)
`;

export async function helperLostHandleFixture(error: unknown, actor = "jq") {
	const f = helperDispatchFixture();
	const dir = await mkdtemp(join(tmpdir(), "helper-lost-handle-"));
	const pidfile = join(dir, "launch.pid");
	await writeFile(join(dir, "helper"), HELPER, { mode: 0o700 });
	await writeFile(join(dir, "actor"), actor);
	await writeFile(
		join(dir, actor.split(":")[0] ?? "jq"),
		'printf R > "$1/ready"\nread -r < "$1/release"\n',
	);
	let survivor = 0,
		pgid = 0,
		signals = 0,
		reads = 0,
		job = 9;
	const targets: number[] = [];
	const abort = new AbortController();
	const launchFile = {
		prepare: () => pidfile,
		read: async () =>
			readFile(pidfile, "utf8").catch((cause: unknown) => {
				if (
					cause instanceof Error &&
					"code" in cause &&
					cause.code === "ENOENT"
				)
					return null;
				throw cause;
			}),
		cleanup: () => {
			void rm(pidfile, { force: true });
		},
	};
	const unitPort = spyOn(spawnPolicy, "spawnWithTimeout").mockImplementation(
		async () => ({
			exitCode: 0,
			stdout: `Job=${job}\nActiveState=inactive\nSubState=dead\n`,
			stderr: "",
		}),
	);
	setSysextEvidenceForTest({
		procRoot: "/fixture-proc",
		procIo: {
			list: async () => (survivor ? ["1", String(survivor)] : ["1"]),
			read: async (file) => {
				reads++;
				return file.endsWith("/1/cmdline")
					? "/sbin/init\0"
					: `/usr/bin/bash\0${dir}/${actor.split(":")[0]}\0`;
			},
			link: async () => "/usr/bin/bash",
		},
		probe: async (scope, signal) => {
			f.units.push(scope.unit);
			return probeServiceCompletion(scope, signal);
		},
	});
	const createStep = (args: readonly string[]) => {
		const ports = {
			euid: () => 0,
			checkLauncher: () => undefined,
			launchFile,
			collect: { signal: abort.signal },
			spawn: (
				argv: string[],
				options: { readonly env: Readonly<Record<string, string>> },
			) => {
				// Execute the production launcher verbatim, changing ONLY the helper path.
				const result = Bun.spawnSync(
					argv.map((arg) =>
						arg === "/usr/bin/ceralive-addon-helper"
							? join(dir, "helper")
							: arg,
					),
					{
						...options,
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				if (result.exitCode !== 0) throw new Error(result.stderr.toString());
				const row: unknown = JSON.parse(result.stdout.toString());
				if (
					!row ||
					typeof row !== "object" ||
					!("pid" in row) ||
					typeof row.pid !== "number" ||
					!("pgid" in row) ||
					typeof row.pgid !== "number" ||
					!("sid" in row) ||
					row.sid !== row.pgid
				)
					throw new Error("invalid tool identity");
				survivor = row.pid;
				pgid = row.pgid;
				throw error;
			},
			kill: (pid: number, signal: 0) => {
				signals++;
				targets.push(pid);
				return process.kill(pid, signal);
			},
		};
		return createAddonHelperStep(args, ports);
	};
	return {
		...f,
		createStep,
		abort,
		targets,
		launchFile,
		pidfile,
		alive: () => {
			process.kill(survivor, 0);
			return true;
		},
		pgid: () => pgid,
		reads: () => reads,
		signals: () => signals,
		settleUnits: () => {
			job = 0;
		},
		retire: async () => {
			await writeFile(join(dir, "release"), "done\n");
			const deadline = Date.now() + 10000;
			for (;;) {
				try {
					process.kill(-pgid, 0);
				} catch (cause) {
					if (
						cause instanceof Error &&
						"code" in cause &&
						cause.code === "ESRCH"
					)
						break;
					throw cause;
				}
				if (Date.now() >= deadline) throw new Error("tool not reaped");
				await setImmediate();
			}
		},
		cleanup: async () => {
			if (survivor) {
				try {
					process.kill(survivor, "SIGKILL");
				} catch (cause) {
					if (
						!(
							cause instanceof Error &&
							"code" in cause &&
							cause.code === "ESRCH"
						)
					)
						throw cause;
				}
			}
			f.reset();
			unitPort.mockRestore();
			await rm(dir, { recursive: true, force: true });
		},
	};
}
