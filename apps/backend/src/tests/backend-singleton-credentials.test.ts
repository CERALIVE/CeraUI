import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireBackendSingleton } from "../helpers/backend-singleton.ts";
import {
	singletonArgv,
	singletonHolderPresent,
} from "../helpers/backend-singleton-proof.ts";

const paths = { lock: "/fixture/lock", helper: "/fixture/helper" };
const cmdline = `${singletonArgv(paths).join("\0")}\0`;
const denied = Object.assign(new Error("proc read denied"), { code: "EACCES" });

function fixture(status: string) {
	const reads: string[] = [];
	const io = {
		readlink: async () => "/usr/bin/flock",
		getuid: () => 0,
		readdir: async () => ["42"],
		readText: async (path: string) => {
			reads.push(path);
			return path.endsWith("/status") ? status : cmdline;
		},
		stat: async (path: string) => {
			reads.push(path);
			const value = await stat("/usr/bin/flock");
			value.uid = 0;
			return value;
		},
		lockIdentity: async () => ({ dev: 1, ino: 2, device: "00:01" }),
	};
	return { io, reads };
}

test("census does not count a non-dumpable foreign-uid granted lookalike as a root holder", async () => {
	// Given root-owned proc metadata, readable exact argv/exe and a granted fd.
	const { io } = fixture("Uid:\t1000\t1000\t1000\t1000\n");
	// When actual kernel credentials qualify it, then root startup is not refused.
	expect(await singletonHolderPresent(paths, undefined, io)).toBe(false);
});

test("startup acquires when a non-dumpable foreign uid has root-owned proc metadata", async () => {
	// Given injected foreign kernel credentials with root-owned proc metadata.
	const { io } = fixture("Uid:\t1000\t1000\t1000\t1000\n");
	const root = await mkdtemp(join(tmpdir(), "singleton-foreign-"));
	const livePaths = {
		lock: join(root, "lock"),
		helper: resolve("../../deployment/ceralive-os-stage-guard"),
	};
	const input = {
		...io,
		readText: async (path: string) =>
			path.endsWith("/status")
				? io.readText(path)
				: `${singletonArgv(livePaths).join("\0")}\0`,
	};
	try {
		// When real acquisition uses that census before and after readiness.
		await using _lease = await acquireBackendSingleton(
			livePaths,
			undefined,
			input,
		);
		// Then the real kernel grants only this backend the canonical lock.
		const contender = Bun.spawn(
			[
				"/usr/bin/flock",
				"-n",
				"-E",
				"75",
				"-x",
				livePaths.lock,
				"/usr/bin/true",
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		expect(await contender.exited).toBe(75);
	} finally {
		await rm(root, { recursive: true });
	}
});

test.each([
	[
		"non-dumpable foreign uid with root-owned proc directory",
		"1000\t1000\t1000\t1000",
	],
	["foreign real uid", "1000\t0\t0\t0"],
	["foreign effective uid", "0\t1000\t0\t0"],
])(
	"census ignores %s before any candidate read can refuse startup",
	async (_name, uids) => {
		// Given kernel credentials differing from our simulated root backend.
		const { io, reads } = fixture(`Uid:\t${uids}\n`);
		const input = {
			...io,
			readText: async (path: string) => {
				if (!path.endsWith("/status")) throw denied;
				return io.readText(path);
			},
		};
		// When the same production census used before and after acquisition runs.
		const present = await singletonHolderPresent(paths, undefined, input);
		// Then an inaccessible lookalike cannot cause a startup refusal.
		expect(present).toBe(false);
		expect(reads).toEqual(["/usr/bin/flock", "/proc/42/status"]);
	},
);

test.each(["unreadable", "nonmatching"])(
	"census ignores status EACCES when argv is %s",
	async (mode) => {
		// Given a restricted process without readable exact observer evidence.
		const { io } = fixture("");
		const input = {
			...io,
			readText: async (path: string) => {
				if (path.endsWith("/status") || mode === "unreadable") throw denied;
				return "/bin/true\0";
			},
		};
		// When restricted-proc policy examines it, then it is non-qualifying.
		expect(await singletonHolderPresent(paths, undefined, input)).toBe(false);
	},
);

test("census fails unproven when status is denied but argv exactly names the observer", async () => {
	// Given exact argv but credentials the kernel reader cannot prove.
	const { io } = fixture("");
	const input = {
		...io,
		readText: async (path: string) => {
			if (path.endsWith("/status")) throw denied;
			return cmdline;
		},
	};
	// When the census runs, then uncertainty cannot silently erase a holder.
	await expect(
		singletonHolderPresent(paths, undefined, input),
	).rejects.toMatchObject({
		name: "BackendSingletonError",
		reason: "unproven",
		cause: denied,
	});
});

test.each(["/cmdline", "/exe"])(
	"qualified credentials retain fail-closed errors at %s",
	async (suffix) => {
		// Given same real/effective uid and a subsequent non-vanished read failure.
		const { io } = fixture("Uid:\t0\t0\t0\t0\n");
		const input = {
			...io,
			readText: async (path: string) => {
				if (path.endsWith(suffix)) throw denied;
				return io.readText(path);
			},
			stat: async (path: string) => {
				if (path.endsWith(suffix)) throw denied;
				return io.stat(path);
			},
		};
		// When the next qualification read fails, then its cause propagates.
		await expect(singletonHolderPresent(paths, undefined, input)).rejects.toBe(
			denied,
		);
	},
);
