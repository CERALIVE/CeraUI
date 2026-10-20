import { expect, test } from "bun:test";
import { acquirePackageRecoveryLocks } from "../modules/system/update-orchestrator/package-recovery-lock.ts";
import {
	compete,
	lockFixture,
} from "./helpers/package-recovery-lock-fixture.ts";

test("package locks exclude POSIX writers when the lock CLI is unavailable", async () => {
	// Given an empty PATH and an unavailable absolute lock CLI, as on older runners.
	const f = await lockFixture();
	const emptyPath = `${f.paths[0]}/no-executables`;
	try {
		// When the real holder runs with a clean environment and no usable lock CLI.
		{
			await using lease = await acquirePackageRecoveryLocks(f.paths, {
				spawn: (argv) =>
					Bun.spawn(
						[
							"/usr/bin/env",
							"-i",
							`PATH=${emptyPath}`,
							...argv.map((arg) =>
								arg.replaceAll("/usr/bin/flock", `${emptyPath}/flock`),
							),
						],
						{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
					),
			});
			// Then the kernel refuses independent POSIX writers on every inode.
			expect(lease.held()).toBe(true);
			expect(f.paths.map(compete)).toEqual([75, 75, 75, 75]);
		}
		expect(f.paths.map(compete)).toEqual([0, 0, 0, 0]);
	} finally {
		await f.close();
	}
});

for (const [field, value] of [
	["ptrsize", "4"],
	["byteorder", "87654321"],
	["archname", "mips64-linux"],
] as const) {
	test(`unsupported Perl ABI ${field} refuses before acknowledging locks`, async () => {
		const f = await lockFixture();
		try {
			const operation = acquirePackageRecoveryLocks(f.paths, {
				spawn: (argv) =>
					Bun.spawn(
						argv.map((arg) =>
							arg.replace(
								"use Config;",
								`use Config; my %Config = %Config::Config; $Config{${field}} = '${value}';`,
							),
						),
						{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
					),
			});
			await expect(operation).rejects.toThrow("package lock readiness failed");
			expect(f.paths.map(compete)).toEqual([0, 0, 0, 0]);
		} finally {
			await f.close();
		}
	});
}
