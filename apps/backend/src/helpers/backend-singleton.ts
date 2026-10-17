import { accessSync, closeSync, constants, openSync } from "node:fs";
import { dirname } from "node:path";
import type { Subprocess } from "bun";
import { OS_STAGE_GUARD_HELPER } from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { BackendSingletonError } from "./backend-singleton-error.ts";
import {
	monitorSingletonPath,
	type SingletonClock,
	singletonClock,
} from "./backend-singleton-monitor.ts";
import {
	singletonArgv,
	singletonHolderPresent,
	singletonLockIdentity,
	singletonPathMatches,
} from "./backend-singleton-proof.ts";
import type { SingletonCensusIO } from "./backend-singleton-qualify.ts";
import { logger } from "./logger.ts";
import { superviseWorker } from "./spawn-policy.ts";

export const BACKEND_SINGLETON_LOCK = "/run/lock/ceralive-backend.lock";

export { BackendSingletonError } from "./backend-singleton-error.ts";

// Production compilation inlines this direct NODE_ENV read; only the exact
// source-development value exempts boot, never runtime mock/device overrides.
export function backendSingletonApplies(
	nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
	return nodeEnv !== "development";
}

export type BackendSingletonLease = {
	readonly exited: Promise<number>;
	[Symbol.asyncDispose](): Promise<void>;
};

let processLease: BackendSingletonLease | undefined;

/** Fixed production paths; explicit arguments are only an injected I/O seam. */
export async function acquireBackendSingleton(
	paths = { lock: BACKEND_SINGLETON_LOCK, helper: OS_STAGE_GUARD_HELPER },
	clock: SingletonClock = singletonClock,
	censusIO?: SingletonCensusIO,
): Promise<BackendSingletonLease> {
	try {
		closeSync(
			openSync(
				paths.lock,
				constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
				0o600,
			),
		);
	} catch (cause) {
		// Only a directory that genuinely cannot create the lock permits dev boot.
		try {
			accessSync(dirname(paths.lock), constants.W_OK);
		} catch (directoryError) {
			if (
				directoryError instanceof Error &&
				"code" in directoryError &&
				["EACCES", "EROFS", "ENOENT"].includes(String(directoryError.code))
			)
				throw new BackendSingletonError("directory-unavailable", { cause });
		}
		throw new BackendSingletonError("unproven", { cause });
	}
	if (await singletonHolderPresent(paths, undefined, censusIO))
		throw new BackendSingletonError("contended");
	let child: Subprocess<"pipe", "pipe", "pipe"> | undefined;
	const handle = superviseWorker(singletonArgv(paths), {
		startupTimeoutMs: 2_000,
		spawn: (argv) => {
			child = Bun.spawn(argv, {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			return child;
		},
		waitForReady: async (proc) => {
			if (!proc.stdout) throw new BackendSingletonError("unproven");
			const reader = proc.stdout.getReader();
			try {
				const reading = await reader.read();
				if (
					reading.done ||
					new TextDecoder().decode(reading.value) !== "locked\n"
				)
					throw new BackendSingletonError("unproven");
			} finally {
				reader.releaseLock();
			}
		},
	});
	let identity: Awaited<ReturnType<typeof singletonLockIdentity>> = null;
	try {
		await handle.ready;
		if (!child) throw new BackendSingletonError("unproven");
		if (await singletonHolderPresent(paths, child.pid, censusIO))
			throw new BackendSingletonError("contended");
		identity = await singletonLockIdentity(child.pid);
		if (!identity || !(await singletonPathMatches(paths.lock, identity)))
			throw new BackendSingletonError("unproven");
	} catch (cause) {
		await child?.stdin.end();
		await handle.shutdown();
		await child?.exited;
		throw new BackendSingletonError(
			child?.exitCode === 75 ||
				(cause instanceof BackendSingletonError && cause.reason === "contended")
				? "contended"
				: "unproven",
			{ cause },
		);
	}
	const locked = child;
	if (!locked || !identity) throw new BackendSingletonError("unproven");
	const monitor = monitorSingletonPath(paths.lock, identity, clock);
	// Keep draining: a failed helper must never block on an inherited stderr pipe.
	void new Response(locked.stderr).text();
	return {
		exited: Promise.race([
			locked.exited.finally(() => monitor.stop()),
			monitor.lost,
		]),
		async [Symbol.asyncDispose]() {
			monitor.stop();
			locked.stdin.write("release\n");
			await locked.stdin.end();
			await locked.exited;
		},
	};
}

/** Retained until process death, not scoped to the top-level module's evaluation. */
export async function enforceBackendSingleton(
	acquire: () => Promise<BackendSingletonLease> = acquireBackendSingleton,
): Promise<void> {
	try {
		const lease = await acquire();
		processLease = lease;
		void lease.exited.then(() => {
			if (processLease !== lease) return;
			logger.error("Backend singleton lock lost; refusing to continue");
			process.exit(1);
		});
	} catch (error) {
		if (
			error instanceof BackendSingletonError &&
			error.reason === "directory-unavailable"
		) {
			logger.warn(
				"Backend singleton lock directory unavailable; continuing without exclusivity",
				{ error },
			);
			return;
		}
		logger.error(
			"Backend singleton acquisition failed; another instance may be running",
			{ error },
		);
		throw error;
	}
}
