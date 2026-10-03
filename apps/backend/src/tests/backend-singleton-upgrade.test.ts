import { expect, test } from "bun:test";
import {
	mkdtemp,
	readlink,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	acquireBackendSingleton,
	BackendSingletonError,
} from "../helpers/backend-singleton.ts";
import {
	singletonArgv,
	singletonHolderPresent,
	singletonLockIdentity,
	singletonProcIO,
} from "../helpers/backend-singleton-proof.ts";

const paths = { lock: "/fixture/lock", helper: "/fixture/helper" };

function fixture(target: string) {
	return {
		getuid: () => 1000,
		readdir: async () => ["42"],
		readText: async (path: string) =>
			path.endsWith("/status")
				? "Uid:\t1000\t1000\t1000\t1000\n"
				: `${singletonArgv(paths).join("\0")}\0`,
		stat: async (path: string) => {
			const value = await stat("/usr/bin/flock");
			if (path.endsWith("/exe")) value.ino += 1;
			return value;
		},
		readlink: async () => target,
		lockIdentity: async () => ({ dev: 1, ino: 2, device: "00:01" }),
	};
}

test("census retains a granted wrapper when its canonical flock executable was deleted", async () => {
	// Given exact argv, same uid and a granted old-generation executable.
	const io = fixture("/usr/bin/flock (deleted)");
	// When the census examines it, then the displaced grant still refuses startup.
	expect(await singletonHolderPresent(paths, undefined, io)).toBe(true);
});

test.each([
	"/usr/bin/unrelated",
	"/tmp/flock (deleted)",
	"/usr/bin/flock",
	"/usr/bin/flock (deleted) extra",
])(
	"census refuses unproven when a granted exact-argv executable is %s",
	async (target) => {
		// Given a granted candidate whose executable has no admitted identity.
		const io = fixture(target);
		// When the census runs, then uncertainty cannot be classified absent.
		const result = singletonHolderPresent(paths, undefined, io);
		await expect(result).rejects.toBeInstanceOf(BackendSingletonError);
		await expect(result).rejects.toMatchObject({ reason: "unproven" });
	},
);

test("census ignores an unrelated exact-argv executable when it has no granted lock", async () => {
	// Given a same-uid argv lookalike that owns no kernel grant.
	const io = {
		...fixture("/usr/bin/unrelated"),
		lockIdentity: async () => null,
	};
	// When the census runs, then executable uncertainty alone cannot count a holder.
	expect(await singletonHolderPresent(paths, undefined, io)).toBe(false);
});

test("second startup refuses when both the old flock executable and lock pathname were replaced", async () => {
	// Given a real held flock/helper and a monitor deliberately parked before its tick.
	const root = await mkdtemp(join(tmpdir(), "singleton-upgrade-"));
	const livePaths = {
		lock: join(root, "lock"),
		helper: resolve("../../deployment/ceralive-os-stage-guard"),
	};
	const clock = { schedule: () => () => undefined };
	try {
		await using _first = await acquireBackendSingleton(livePaths, clock);
		await rename(livePaths.lock, `${livePaths.lock}.old`);
		await writeFile(livePaths.lock, "", { mode: 0o600 });
		const io = {
			...singletonProcIO,
			getuid: () => process.getuid?.(),
			lockIdentity: singletonLockIdentity,
			stat: async (path: string) => {
				const value = await stat(path);
				if (path.endsWith("/exe")) value.ino += 1;
				return value;
			},
			readlink: async (path: string) =>
				(await readlink(path)) === "/usr/bin/flock"
					? "/usr/bin/flock (deleted)"
					: readlink(path),
		};
		// When second acquisition sees an injected deleted-flock identity over real proc/fd evidence.
		let second: Awaited<ReturnType<typeof acquireBackendSingleton>> | undefined;
		try {
			await expect(
				(async () => {
					second = await acquireBackendSingleton(livePaths, clock, io);
				})(),
			).rejects.toMatchObject({ reason: "contended" });
			// Then refusal happened while the old wrapper was still holding its old inode.
			const contender = Bun.spawn(
				[
					"/usr/bin/flock",
					"-n",
					"-E",
					"75",
					"-x",
					`${livePaths.lock}.old`,
					"/usr/bin/true",
				],
				{ stdout: "ignore", stderr: "ignore" },
			);
			expect(await contender.exited).toBe(75);
		} finally {
			await second?.[Symbol.asyncDispose]();
		}
	} finally {
		await rm(root, { recursive: true });
	}
});
