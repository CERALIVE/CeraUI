import type { Subprocess } from "bun";
import { superviseWorker } from "../../../helpers/spawn-policy.ts";
import type { OsStageControlLease } from "./os-stage-control-lease.ts";

export const PACKAGE_RECOVERY_LOCKS = [
	"/var/lib/dpkg/lock-frontend",
	"/var/lib/dpkg/lock",
	"/var/lib/apt/lists/lock",
	"/var/cache/apt/archives/lock",
] as const;

// The shell retains each open description after flock exits. EOF on the backend's
// private stdin releases every lock even after SIGKILL; no detached holder survives.
const HOLDER = `
for path in "$@"; do
  [[ -f "$path" && ! -L "$path" ]] || exit 74
  exec {fd}<>"$path" || exit 74
  /usr/bin/flock --fcntl --exclusive --nonblock "$fd" || exit 75
done
printf 'locked\\n'
IFS= read -r release || :
`;

export class PackageRecoveryLockError extends Error {
	override readonly name = "PackageRecoveryLockError";
}

type HolderOptions = {
	readonly startupTimeoutMs?: number;
	readonly spawn?: (argv: string[]) => Subprocess<"pipe", "pipe", "pipe">;
};

export async function acquirePackageRecoveryLocks(
	paths: readonly string[] = PACKAGE_RECOVERY_LOCKS,
	options: HolderOptions = {},
): Promise<OsStageControlLease> {
	let child: Subprocess<"pipe", "pipe", "pipe"> | undefined;
	const handle = superviseWorker(
		[
			"/bin/bash",
			"--noprofile",
			"--norc",
			"-c",
			HOLDER,
			"package-recovery-lock",
			...paths,
		],
		{
			startupTimeoutMs: options.startupTimeoutMs ?? 2_000,
			spawn: (argv) => {
				child = options.spawn
					? options.spawn(argv)
					: Bun.spawn(argv, {
							stdin: "pipe",
							stdout: "pipe",
							stderr: "pipe",
							env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
						});
				return child;
			},
			waitForReady: async (proc) => {
				if (!proc.stdout)
					throw new PackageRecoveryLockError("missing readiness pipe");
				const reader = proc.stdout.getReader();
				try {
					const reading = await reader.read();
					if (
						reading.done ||
						new TextDecoder().decode(reading.value) !== "locked\n"
					)
						throw new PackageRecoveryLockError("package locks refused");
				} finally {
					reader.releaseLock();
				}
			},
		},
	);
	let released = false;
	const release = async () => {
		if (released) return;
		released = true;
		try {
			await child?.stdin.end();
		} finally {
			try {
				await handle.shutdown();
			} finally {
				await child?.exited;
				if (child) await new Response(child.stderr).text();
			}
		}
	};
	try {
		await handle.ready;
	} catch (cause) {
		await release();
		throw new PackageRecoveryLockError("package lock readiness failed", {
			cause,
		});
	}
	const locked = child;
	if (!locked)
		throw new PackageRecoveryLockError("package lock child unavailable");
	return {
		pid: String(locked.pid),
		held: () =>
			!released && locked.exitCode === null && locked.signalCode === null,
		[Symbol.asyncDispose]: release,
	};
}
