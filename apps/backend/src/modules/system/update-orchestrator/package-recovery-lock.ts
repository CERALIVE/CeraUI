import type { Subprocess } from "bun";
import { superviseWorker } from "../../../helpers/spawn-policy.ts";
import type { OsStageControlLease } from "./os-stage-control-lease.ts";

export const PACKAGE_RECOVERY_LOCKS = [
	"/var/lib/dpkg/lock-frontend",
	"/var/lib/dpkg/lock",
	"/var/lib/apt/lists/lock",
	"/var/cache/apt/archives/lock",
] as const;

// Linux x86_64/aarch64 LP64 UAPI: short@0/2, off_t@8/16, pid_t@24, size32.
// OFD ownership survives unrelated closes; it conflicts with dpkg's POSIX locks.
const HOLDER = String.raw`
use strict;
use warnings;
use Config;
use Fcntl qw(O_RDWR O_NOFOLLOW O_NONBLOCK F_WRLCK SEEK_SET);
exit 78 unless $^O eq 'linux'
  && $Config{archname} =~ /\A(?:x86_64|aarch64)(?:-|$)/
  && $Config{ptrsize} == 8 && $Config{longsize} == 8
  && $Config{ivsize} == 8 && $Config{lseeksize} == 8
  && $Config{shortsize} == 2 && $Config{intsize} == 4
  && $Config{byteorder} eq '12345678';
@ARGV or exit 74;
my @locks;
for my $path (@ARGV) {
  sysopen(my $fd, $path, O_RDWR | O_NOFOLLOW | O_NONBLOCK) or exit 74;
  -f $fd or exit 74;
  my $lock = pack('s<s<x4q<q<l<x4', F_WRLCK, SEEK_SET, 0, 0, 0);
  length($lock) == 32 or exit 78;
  fcntl($fd, 37, $lock) or exit 75;
  push @locks, $fd;
}
syswrite(STDOUT, "locked\n") == 7 or exit 74;
while (1) {
  my $count = sysread(STDIN, my $buffer, 4096);
  defined($count) or exit 74;
  last if $count == 0;
}
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
		["/usr/bin/perl", "-e", HOLDER, "--", ...paths],
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
