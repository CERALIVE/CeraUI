import { spyOn } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createAddonHelperStep } from "../../helpers/addon-helper-step.ts";
import * as spawnPolicy from "../../helpers/spawn-policy.ts";
import { setSysextEvidenceForTest } from "../../modules/addons/disruptive-sysext-step.ts";
import { probeServiceCompletion } from "../../modules/system/disruptive-service-reservation.ts";
import { helperDispatchFixture } from "./helper-dispatch-fixture.ts";

// The leader is synchronously reaped before the port throws, as in Bun's pidfd path.
// The survivor is a scratch script actor, NOT the installed helper or a host census.
const LEADER = `import os, sys, json, signal
signal.alarm(30)
d = sys.argv[1]
for name in ['ready', 'release']: os.mkfifo(d + '/' + name)
p = os.fork()
if p == 0:
 signal.alarm(30)
 for fd in [1, 2]: os.dup2(os.open('/dev/null', os.O_WRONLY), fd)
 os.execv('/bin/bash', ['/bin/bash', d + '/ceralive-addon-helper', d])
with open(d + '/ready') as f: f.read(1)
print(json.dumps({'pid': p, 'pgid': os.getpgrp(), 'sid': os.getsid(0)}), flush=True)
`;

export async function helperPostExecFixture(error: unknown) {
	const f = helperDispatchFixture();
	const dir = await mkdtemp(join(tmpdir(), "helper-post-exec-"));
	await writeFile(
		join(dir, "ceralive-addon-helper"),
		'printf R > "$1/ready"\nread -r < "$1/release"\n',
	);
	let survivor = 0,
		pgid = 0,
		visible = true,
		signals = 0,
		reads = 0;
	let job = 9;
	const abort = new AbortController();
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
			list: async () => (visible && survivor ? ["1", String(survivor)] : ["1"]),
			read: async (file) => {
				reads++;
				if (file === "/fixture-proc/1/cmdline") return "/sbin/init\0";
				return readFile(`/proc/${survivor}/${basename(file)}`, "utf8");
			},
			link: async (file) =>
				file === "/fixture-proc/1/exe" ? "/sbin/init" : "/bin/bash",
		},
		probe: async (scope, signal) => {
			f.units.push(scope.unit);
			return probeServiceCompletion(scope, signal);
		},
	});
	const createStep = (args: readonly string[]) =>
		createAddonHelperStep(args, {
			euid: () => 0,
			checkLauncher: () => undefined,
			collect: { signal: abort.signal },
			spawn: () => {
				const result = Bun.spawnSync(
					[
						"/usr/bin/setsid",
						"-w",
						"--",
						"/usr/bin/python3",
						"-c",
						LEADER,
						dir,
					],
					{
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
					throw new Error("invalid survivor identity");
				survivor = row.pid;
				pgid = row.pgid;
				throw error;
			},
			kill: () => {
				signals++;
			},
		});
	return {
		...f,
		createStep,
		abort,
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
					await readFile(`/proc/${survivor}/stat`, "utf8");
				} catch (error) {
					if (
						error instanceof Error &&
						"code" in error &&
						(error.code === "ENOENT" || error.code === "ESRCH")
					)
						break;
					throw error;
				}
				if (Date.now() >= deadline) throw new Error("survivor not reaped");
				await setImmediate();
			}
			visible = false;
		},
		cleanup: async () => {
			if (survivor) {
				try {
					process.kill(survivor, "SIGKILL");
				} catch (error) {
					if (
						!(
							error instanceof Error &&
							"code" in error &&
							error.code === "ESRCH"
						)
					)
						throw error;
				}
			}
			f.reset();
			unitPort.mockRestore();
			await rm(dir, { recursive: true, force: true });
		},
	};
}
