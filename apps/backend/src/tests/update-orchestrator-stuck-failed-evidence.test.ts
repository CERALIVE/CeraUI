import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	packageLocksIdle,
	readPackageConsistency,
} from "../modules/system/update-orchestrator/package-recovery-evidence.ts";
import type { RecoveryProbeIo } from "../modules/system/update-orchestrator/recovery-probes.ts";

const absent =
	"LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\nJob=0\n";
function io(overrides: Partial<RecoveryProbeIo> = {}): RecoveryProbeIo {
	return {
		run: async (argv) => ({
			code: 0,
			stdout:
				argv[0] === "systemctl"
					? absent
					: argv[0] === "busctl"
						? 's "idle"'
						: "",
		}),
		read: async () => "sleep\n",
		list: async (path) => (path === "/proc" ? ["123", "sys"] : []),
		...overrides,
	};
}

test("a real kernel lock on an observed package lock file withholds idle proof", async () => {
	// Given an unprivileged child holding a real flock on a private lock file.
	const dir = await mkdtemp(join(tmpdir(), "package-lock-proof-"));
	const path = join(dir, "lock");
	await Bun.write(path, "");
	const child = Bun.spawn(
		[
			"/usr/bin/flock",
			"-x",
			path,
			"/bin/bash",
			"-c",
			"printf 'ready\\n'; read -r release",
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	try {
		const reader = child.stdout.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(
			"ready\n",
		);
		reader.releaseLock();
		// When the production collector reads the file's real mount/inode identity.
		const idle = await packageLocksIdle([path]);
		// Then the kernel holder cannot be missed.
		expect(idle).toBe(false);
	} finally {
		await child.stdin.end("release\n");
		await child.exited;
		await rm(dir, { recursive: true });
	}
});

test("a malformed kernel lock table is not positive idle evidence", async () => {
	// Given an incomplete lock-table read.
	// When the collector classifies it.
	const idle = await packageLocksIdle(
		[],
		async () => "1: POSIX ADVISORY WRITE",
	);
	// Then it refuses rather than guessing an empty table.
	expect(idle).toBe(false);
});

test("real consistency adapter requires all clean command and directory reads", async () => {
	// Given ordinary strict absence and an empty audit/database update directory.
	const probe = io();
	// When the production adapter reads its IO port.
	const proof = await readPackageConsistency(probe, async () => true);
	// Then each independent proof is positive.
	expect(proof).toEqual({
		unitAbsent: true,
		packagesIdle: true,
		locksIdle: true,
		auditClean: true,
		updatesEmpty: true,
	});
});

test("held dpkg process is not idle even with no install unit", async () => {
	// Given an independent dpkg process.
	const probe = io({ read: async () => "dpkg\n" });
	// When evidence is collected.
	const proof = await readPackageConsistency(probe, async () => true);
	// Then idle proof is withheld.
	expect(proof.packagesIdle).toBe(false);
});

for (const boundary of [
	"unit",
	"process",
	"audit",
	"updates",
	"locks",
] as const) {
	test(`unreadable ${boundary} proof cannot produce recovery evidence`, async () => {
		// Given a read failure at one exact boundary.
		const base = io();
		const fault = () => {
			throw new Error(`EIO at ${boundary}`);
		};
		const probe = io({
			run: (argv) =>
				(boundary === "unit" && argv[0] === "systemctl") ||
				(boundary === "audit" && argv[0] === "dpkg")
					? Promise.reject(new Error("EIO"))
					: base.run(argv),
			read: (path) =>
				boundary === "process"
					? Promise.reject(new Error("EIO"))
					: base.read(path),
			list: (path) =>
				boundary === "updates" && path === "/var/lib/dpkg/updates"
					? Promise.reject(new Error("EIO"))
					: base.list(path),
		});
		// When the adapter attempts the reads.
		const pending = readPackageConsistency(
			probe,
			boundary === "locks" ? async () => fault() : async () => true,
		);
		// Then UNKNOWN propagates rather than turning into consistency.
		await expect(pending).rejects.toThrow();
	});
}
