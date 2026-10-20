import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FailedRecoveryPort,
	recoverFailedUpdate,
} from "../../modules/system/update-orchestrator/failed-recovery.ts";
import type { OsStageControlLease } from "../../modules/system/update-orchestrator/os-stage-control-lease.ts";
import { readPackageConsistency } from "../../modules/system/update-orchestrator/package-recovery-evidence.ts";
import { acquirePackageRecoveryLocks } from "../../modules/system/update-orchestrator/package-recovery-lock.ts";
import { initialOrchestratorState } from "../../modules/system/update-orchestrator/types.ts";

export async function lockFixture() {
	const dir = await mkdtemp(join(tmpdir(), "package-recovery-fence-"));
	const paths = ["frontend", "dpkg", "lists", "archives"].map((name) =>
		join(dir, name),
	);
	for (const path of paths) await Bun.write(path, "");
	const before = {
		...initialOrchestratorState(100),
		phase: "failed" as const,
		failureReason: "commit_unit_absent_on_resume",
		packageAttempt: { bootId: "old", slot: "rootfs.1" },
	};
	const effects: string[] = [];
	const held = async (): Promise<OsStageControlLease> => ({
		held: () => true,
		async [Symbol.asyncDispose]() {
			return;
		},
	});
	const port: FailedRecoveryPort = {
		snapshot: () => before,
		current: () => true,
		acquireControl: held,
		acquireUpdateLock: held,
		acquirePackageLocks: () => acquirePackageRecoveryLocks(paths),
		readPersisted: async () => before,
		readPackageEvidence: async (locks) => ({
			...(await readPackageConsistency(
				{
					run: async (argv) => ({
						code: 0,
						stderr: "",
						stdout:
							argv[0] === "systemctl"
								? "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\nJob=0\n"
								: argv[0] === "busctl"
									? 's "idle"'
									: "",
					}),
					read: async () => "sleep\n",
					list: async () => [],
				},
				async () => locks.held(),
			)),
			bootId: "current",
			slot: "rootfs.0",
		}),
		clearPending: async () => {
			effects.push("clear");
		},
		persist: () => {
			effects.push("persist");
		},
		adopt: () => {
			effects.push("adopt");
		},
		now: () => 200,
		inspectSync: async () => ({ kind: "absent" }),
		readSyncEvidence: async () => {
			throw new TypeError("unexpected mirror read");
		},
		readSlots: async () => [],
		readVersion: async () => undefined,
	};
	return {
		paths,
		port,
		effects,
		before,
		close: () => rm(dir, { recursive: true }),
	};
}

// Independent dpkg-style POSIX contender, not the production OFD program.
export function packageWriterArgv(path: string, mode = "probe"): string[] {
	return [
		"/usr/bin/perl",
		"-e",
		String.raw`
use strict;
use warnings;
use Fcntl qw(O_RDWR F_SETLK F_SETLKW F_WRLCK SEEK_SET);
my ($mode, $path) = @ARGV;
sysopen(my $fd, $path, O_RDWR) or die "open: $!";
my $lock = pack('s<s<x4q<q<l<x4', F_WRLCK, SEEK_SET, 0, 0, 0);
fcntl($fd, $mode eq 'wait' ? F_SETLKW : F_SETLK, $lock) or exit 75;
if ($mode eq 'hold') {
  $| = 1;
  print "ready\n";
  while (sysread(STDIN, my $buffer, 4096)) {}
}
`,
		mode,
		path,
	];
}

export function compete(path: string): number {
	// Publication is synchronous; the bounded real child must finish inside it.
	return Bun.spawnSync(packageWriterArgv(path), {
		timeout: 2_000,
		stdout: "pipe",
		stderr: "pipe",
	}).exitCode;
}

export async function recoverWith(port: FailedRecoveryPort) {
	try {
		return await recoverFailedUpdate(port);
	} catch (error) {
		if (error instanceof Error) return false;
		throw error;
	}
}
