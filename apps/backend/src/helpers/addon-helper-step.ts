import { accessSync, constants } from "node:fs";
import type { Subprocess } from "bun";
import type { ServiceCompletion } from "../modules/system/disruptive-service-reservation.ts";
import {
	type BoundedSpawnOptions,
	collectBoundedChild,
	SpawnAbortError,
	SpawnTimeoutError,
} from "./bounded-spawn.ts";
import type { ExecResult } from "./exec.ts";
import {
	helperGroupRetirement,
	type SignalZero,
} from "./helper-group-retirement.ts";
import { DEFAULT_SPAWN_TIMEOUT_MS } from "./spawn-policy.ts";

type HelperChild = Subprocess<"ignore", "pipe", "pipe">;
export const ADDON_HELPER_ENV = {
	PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
	LANG: "C",
	LC_ALL: "C",
} as const;
type HelperSpawnOptions = {
	readonly stdin: "ignore";
	readonly stdout: "pipe";
	readonly stderr: "pipe";
	readonly env: typeof ADDON_HELPER_ENV;
};
export type AddonHelperRunnerPorts = {
	readonly euid: () => number;
	readonly spawn: (argv: string[], options: HelperSpawnOptions) => HelperChild;
	readonly kill: SignalZero;
	readonly checkLauncher?: () => void;
	readonly collect?: BoundedSpawnOptions;
};
export type AddonHelperDispatch = "none" | "started" | "unknown";
export type AddonHelperStep = {
	readonly run: () => Promise<ExecResult>;
	readonly spawned: () => boolean;
	readonly dispatch: () => AddonHelperDispatch;
	readonly probe: (signal: AbortSignal) => Promise<ServiceCompletion>;
	readonly child: () => HelperChild | undefined;
	readonly exitCode: () => number | undefined;
};
const hostPorts: AddonHelperRunnerPorts = {
	euid: () => process.geteuid?.() ?? -1,
	spawn: (argv, options) => Bun.spawn(argv, options),
	kill: process.kill,
};

export class AddonHelperLaunchError extends Error {
	readonly code = "EACCES";
	constructor() {
		super("add-on mutation requires the packaged root backend");
	}
}

export function createAddonHelperStep(
	args: readonly string[],
	ports: AddonHelperRunnerPorts = hostPorts,
): AddonHelperStep {
	let child: HelperChild | undefined;
	let exitCode: number | undefined;
	let dispatch: AddonHelperDispatch = "unknown";
	const probe = helperGroupRetirement(
		() => (child ? { pgid: child.pid, exitCode } : undefined),
		ports.kill,
	);
	return {
		spawned: () => child !== undefined,
		dispatch: () => (child === undefined ? dispatch : "started"),
		child: () => child,
		exitCode: () => exitCode,
		probe,
		run: async () => {
			let spawnAttempted = false;
			try {
				if (ports.euid() !== 0) throw new AddonHelperLaunchError();
				(
					ports.checkLauncher ??
					(() => accessSync("/usr/bin/setsid", constants.X_OK))
				)();
				const argv = [
					"/usr/bin/setsid",
					"-w",
					"--",
					"/usr/bin/ceralive-addon-helper",
					...args,
				];
				const command = argv.join(" ");
				if (ports.collect?.signal?.aborted) throw new SpawnAbortError(command);
				const options: HelperSpawnOptions = {
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					env: ADDON_HELPER_ENV,
				};
				spawnAttempted = true;
				child = ports.spawn(argv, options);
				// Observe actual exit even when collector timeout suppresses its onExit hook.
				void child.exited.then(
					(code) => {
						exitCode = code;
					},
					() => undefined,
				);
				try {
					const result = await collectBoundedChild(child, command, {
						...ports.collect,
						timeoutMs: ports.collect?.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS,
						maxBuffer: ports.collect?.maxBuffer ?? 1024 * 1024,
					});
					if (result.exitCode !== 0)
						throw Object.assign(new Error(`Command failed: ${command}`), {
							stdout: result.stdout,
							stderr: result.stderr,
							code: result.exitCode,
						});
					return { stdout: result.stdout, stderr: result.stderr };
				} catch (error) {
					if (error instanceof SpawnTimeoutError)
						Object.assign(error, {
							stdout: error.partialStdout,
							stderr: error.partialStderr,
							...(exitCode === undefined ? {} : { code: exitCode }),
						});
					throw error;
				}
			} catch (error) {
				// Bun 1.4.2 can exec, reap on pidfd_open failure, then throw without a handle.
				// Only these source-proven pre-exec tags or our own preparation prove none.
				if (
					child === undefined &&
					(!spawnAttempted ||
						(error instanceof Error &&
							"syscall" in error &&
							(error.syscall === "socketpair" ||
								error.syscall === "fcntl" ||
								error.syscall === "posix_spawn")))
				)
					dispatch = "none";
				throw error;
			}
		},
	};
}
