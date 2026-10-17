import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import {
	singletonArgv,
	singletonHolderPresent,
} from "../helpers/backend-singleton-proof.ts";
import type { SingletonCensusIO } from "../helpers/backend-singleton-qualify.ts";

const paths = { lock: "/fixture/lock", helper: "/fixture/helper" };
const pid = 42;
const uid = 1000;
const identity = { dev: 1, ino: 2, device: "00:01" };

function fixture() {
	const reads: string[] = [];
	const io: SingletonCensusIO = {
		readlink: async () => "/fixture/unrelated-executable",
		getuid: () => uid,
		readdir: async () => [String(pid)],
		readText: async (path) => {
			reads.push(path);
			if (path.endsWith("/status"))
				return `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
			return `${singletonArgv(paths).join("\0")}\0`;
		},
		stat: async (path) => {
			reads.push(path);
			const value = await stat("/usr/bin/flock");
			value.uid = uid;
			return value;
		},
		lockIdentity: async (owner) => {
			reads.push(`grant:${owner}`);
			return identity;
		},
	};
	return { io, reads };
}

const argvCases: [string, readonly string[]][] = [
	["extra argument", [...singletonArgv(paths), "extra"]],
	[
		"changed flags",
		singletonArgv(paths).map((arg) => (arg === "-n" ? "-w" : arg)),
	],
	["missing argument", singletonArgv(paths).slice(1)],
	["reordered arguments", singletonArgv(paths).reverse()],
	["empty argument", [...singletonArgv(paths), ""]],
];
test.each(argvCases)(
	"census rejects %s without reading exe or grant",
	async (_name, argv) => {
		// Given an argv that is not the full canonical vector.
		const { io, reads } = fixture();
		const input = {
			...io,
			readText: async (path: string) =>
				path.endsWith("/status") ? io.readText(path) : `${argv.join("\0")}\0`,
		};
		// When the census examines that process.
		const present = await singletonHolderPresent(paths, undefined, input);
		// Then no process metadata or fd proof is read.
		expect(present).toBe(false);
		expect(reads).toEqual(["/usr/bin/flock", `/proc/${pid}/status`]);
	},
);

test("census rejects another uid before reading exe or grant", async () => {
	// Given exact argv owned by another uid, using an injected unprivileged seam.
	const { io, reads } = fixture();
	const input = {
		...io,
		readText: async (path: string) =>
			path.endsWith("/status")
				? `Uid:\t${uid + 1}\t${uid + 1}\t${uid + 1}\t${uid + 1}\n`
				: io.readText(path),
	};
	// When the census examines that process.
	const present = await singletonHolderPresent(paths, undefined, input);
	// Then foreign ownership cannot trigger privileged exe/fd reads.
	expect(present).toBe(false);
	expect(reads).not.toContain(`/proc/${pid}/exe`);
	expect(reads).not.toContain(`grant:${pid}`);
});

test.each(["dev", "ino"] as const)(
	"census fails unproven for a granted holder with a different executable %s",
	async (field) => {
		// Given exact argv and uid, but a different executable identity.
		const { io, reads } = fixture();
		const input = {
			...io,
			stat: async (path: string) => {
				const value = await io.stat(path);
				if (path.endsWith("/exe")) value[field] += 1;
				return value;
			},
		};
		// When the census examines that process.
		const present = singletonHolderPresent(paths, undefined, input);
		// Then strings cannot qualify it, nor can uncertainty silently erase its grant.
		await expect(present).rejects.toMatchObject({
			name: "BackendSingletonError",
			reason: "unproven",
		});
		expect(reads).toContain(`grant:${pid}`);
	},
);

test("post-readiness census ignores a nongranted contender without rejecting the winner", async () => {
	// Given the pending winner and an exact flock contender with no granted fd.
	const { io, reads } = fixture();
	const winner = 43;
	const input = {
		...io,
		readdir: async () => [String(winner), String(pid)],
		lockIdentity: async (owner: number) => {
			reads.push(`grant:${owner}`);
			return null;
		},
	};
	// When acquisition's post-readiness census excludes its pending winner.
	const present = await singletonHolderPresent(paths, winner, input);
	// Then the still-in-flight losing wrapper does not cause contention.
	expect(present).toBe(false);
	expect(reads).toContain(`grant:${pid}`);
	expect(reads).not.toContain(`/proc/${winner}/cmdline`);
});

test.each(["ENOENT", "ESRCH"])(
	"census ignores a matched pid that vanishes with %s",
	async (code) => {
		// Given an exact owned wrapper vanishing before its fd can be proven.
		const { io } = fixture();
		const input = {
			...io,
			lockIdentity: async () => {
				throw Object.assign(new Error("process vanished"), { code });
			},
		};
		// When the census encounters the disappearance.
		const present = await singletonHolderPresent(paths, undefined, input);
		// Then ordinary process exit is not contention or a fatal read failure.
		expect(present).toBe(false);
	},
);

test("census fails closed when a matching owned flock has an unreadable grant", async () => {
	// Given a qualified wrapper whose kernel proof fails for a non-exit reason.
	const { io } = fixture();
	const denied = Object.assign(new Error("fdinfo denied"), { code: "EACCES" });
	const input = {
		...io,
		lockIdentity: async () => {
			throw denied;
		},
	};
	// When the census attempts proof, then the original failure propagates.
	await expect(singletonHolderPresent(paths, undefined, input)).rejects.toBe(
		denied,
	);
});

test("census counts a granted owned flock independently of the current lock pathname", async () => {
	// Given a real grant identity and no pathname observation in the I/O port.
	const { io } = fixture();
	// When the census qualifies the wrapper, then it remains a holder after unlink.
	expect(await singletonHolderPresent(paths, undefined, io)).toBe(true);
});
