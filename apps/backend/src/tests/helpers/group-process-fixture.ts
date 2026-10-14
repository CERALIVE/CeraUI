import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
	type AddonHelperRunnerPorts,
	createAddonHelperStep,
} from "../../helpers/addon-helper-step.ts";
import { createHelperLaunchFile } from "../../helpers/helper-launch-file.ts";
import { prepareHelperScriptGroup } from "./helper-step-fixture.ts";

const PROGRAM = `import os, sys, signal, json
d, mode, code = sys.argv[1], sys.argv[2], int(sys.argv[3])
signal.alarm(30)
os.mkfifo(d + '/release')
if mode == 'zero-term':
 signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
elif mode == 'kill':
 signal.signal(signal.SIGTERM, signal.SIG_IGN)
if mode not in ['plain', 'zero-term']:
 r, w = os.pipe()
 p = os.fork()
 if p == 0:
  if mode == 'double':
   q = os.fork()
   if q != 0: os._exit(0)
  if mode == 'escape': os.setsid()
  for fd in [1, 2]: os.dup2(os.open('/dev/null', os.O_WRONLY), fd)
  with open(d + '/worker', 'w') as f: json.dump({'pid': os.getpid(), 'pgid': os.getpgrp(), 'sid': os.getsid(0)}, f)
  os.write(w, b'R')
  with open(d + '/release') as f: f.read()
  os._exit(0)
 if mode == 'double': os.waitpid(p, 0)
 os.read(r, 1)
print('partial-out', flush=True)
print('partial-err', file=sys.stderr, flush=True)
with open(d + '/leader', 'w') as f: json.dump({'pid': os.getpid(), 'pgid': os.getpgrp(), 'sid': os.getsid(0)}, f)
if mode in ['term', 'kill', 'zero-term']:
 with open(d + '/release') as f: f.read()
os._exit(code)
`;

export async function groupProcessFixture(mode: string, code = 0) {
	const dir = await mkdtemp(join(tmpdir(), "helper-group-"));
	const script = mode.startsWith("script:");
	const [, action = "refresh", actor = ""] = mode.split(":");
	if (script) await prepareHelperScriptGroup(dir, action, actor);
	const waiters = new Set<() => void>();
	const watcher = watch(dir, () => {
		for (const wake of [...waiters]) wake();
	});
	const wait = async (name: string): Promise<string> => {
		const result = Promise.withResolvers<string>();
		const check = () => {
			void readFile(join(dir, name), "utf8").then(
				(s) => {
					if (s) result.resolve(s);
				},
				(error: unknown) => {
					if (
						!(
							error instanceof Error &&
							"code" in error &&
							error.code === "ENOENT"
						)
					)
						result.reject(error);
				},
			);
		};
		waiters.add(check);
		const watchdog = setTimeout(
			() => result.reject(new Error(`readiness missing: ${name}`)),
			10000,
		);
		try {
			check();
			return await result.promise;
		} finally {
			clearTimeout(watchdog);
			waiters.delete(check);
		}
	};
	const timers = new Map<
		number,
		{ readonly run: () => void; readonly ms: number }
	>();
	let index = 0;
	let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;
	const launches: Array<{
		readonly argv: readonly string[];
		readonly options: unknown;
	}> = [];
	const ports: AddonHelperRunnerPorts = {
		euid: () => 0,
		launchFile: createHelperLaunchFile(dir, process.getuid?.() ?? -1),
		spawn: (argv, options) => {
			launches.push({ argv: [...argv], options });
			child = script
				? Bun.spawn(
						[
							...argv.slice(0, 8),
							new URL("../../../ceralive-addon-helper", import.meta.url)
								.pathname,
							action,
							"test-addon",
						],
						{
							...options,
							env: {
								...options.env,
								PATH: `${dir}/tools:${options.env.PATH}`,
								CERALIVE_ADDON_REGISTRY_DIR: `${dir}/registry`,
								CERALIVE_ADDON_CACHE_DIR: `${dir}/cache`,
								CERALIVE_ADDON_STAGE_DIR: `${dir}/stage`,
								CERALIVE_ADDON_EXT_DIR: `${dir}/scan`,
								CERALIVE_GPGV: "/usr/bin/true",
								CERALIVE_SYSEXT: "/usr/bin/true",
							},
						},
					)
				: Bun.spawn(
						[
							...argv.slice(0, 8),
							"/usr/bin/python3",
							"-c",
							PROGRAM,
							dir,
							mode,
							String(code),
						],
						options,
					);
			return child;
		},
		kill: process.kill,
		collect: {
			scheduleTimeout: (run, ms) => {
				timers.set(++index, { run, ms });
				return index;
			},
			cancelTimeout: (id) => {
				if (typeof id === "number") timers.delete(id);
			},
		},
	};
	const step = createAddonHelperStep(["refresh"], ports);
	let workerPid: number | undefined;
	return {
		step,
		launches,
		wait,
		worker: async () => {
			const row: unknown = JSON.parse(await wait("worker"));
			if (
				!row ||
				typeof row !== "object" ||
				!("pid" in row) ||
				typeof row.pid !== "number"
			)
				throw new Error("invalid worker");
			workerPid = row.pid;
			return row;
		},
		fire: (ms: number) => {
			const match = [...timers].find(([, entry]) => entry.ms === ms);
			if (!match) throw new Error(`missing timer ${ms}`);
			timers.delete(match[0]);
			match[1].run();
		},
		fireWhenScheduled: async (ms: number) => {
			const watchdog = Promise.withResolvers<void>();
			const timer = setTimeout(
				() => watchdog.reject(new Error(`missing scheduled bound ${ms}`)),
				10000,
			);
			try {
				for (;;) {
					const match = [...timers].find(([, entry]) => entry.ms === ms);
					if (match) {
						timers.delete(match[0]);
						match[1].run();
						return;
					}
					await Promise.race([setImmediate(), watchdog.promise]);
				}
			} finally {
				clearTimeout(timer);
			}
		},
		release: () => writeFile(join(dir, "release"), "done"),
		workerRetired: () => {
			workerPid = undefined;
		},
		cleanup: async () => {
			watcher.close();
			if (child && child.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL");
			if (child) await child.exited;
			if (workerPid !== undefined) {
				try {
					process.kill(workerPid, "SIGKILL");
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
			await rm(dir, { recursive: true, force: true });
		},
	};
}
