import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import {
	singletonHolderPresent,
	singletonLockIdentity,
} from "../helpers/backend-singleton-proof.ts";
import type { SingletonProcIO } from "../helpers/backend-singleton-qualify.ts";

const pid = 2202416;
const paths = {
	lock: "/run/lock/ceralive-backend.lock",
	helper: "/usr/libexec/ceralive/ceralive-os-stage-guard",
};
const raw = await Bun.file(
	new URL("./fixtures/real-device/opi-singleton-proc.txt", import.meta.url),
).text();

function section(name: string): string {
	const value = raw.split(`##### ${name}\n`)[1]?.split("##### ")[0];
	if (!value) throw new Error(`missing fixture section: ${name}`);
	return value;
}

const cmdline = Buffer.from(section("cmdline-base64"), "base64").toString();
const fdinfo = section("fdinfo-3");

function procIO(info: string): SingletonProcIO {
	return {
		readdir: async () => ["3"],
		readText: async (path) => {
			if (path.endsWith("/status")) return "Uid:\t0\t0\t0\t0\n";
			if (path.endsWith("/cmdline")) return cmdline;
			if (path.endsWith("/mountinfo")) return section("mountinfo-lock-row");
			if (path.endsWith("/fdinfo/3")) return info;
			throw new Error(`unexpected fixture read: ${path}`);
		},
		stat: async (path) => {
			const value = await stat("/usr/bin/flock");
			value.uid = 0;
			if (path.endsWith("/fd/3")) {
				const [dev, , ino] = section("lock-stat-backend-row").split(" ");
				value.dev = Number.parseInt(dev ?? "", 16);
				value.ino = Number(ino);
			}
			return value;
		},
	};
}

test("census recognizes the H7 Orange Pi granted singleton wrapper", async () => {
	// Given the real cmdline, held fdinfo and mount/stat identity receipts.
	const io = procIO(fdinfo);
	const census = {
		...io,
		getuid: () => 0,
		readlink: async () => "/usr/bin/flock",
		readdir: async () => [String(pid)],
		lockIdentity: (owner: number) => singletonLockIdentity(owner, io),
	};
	// When the production census qualifies the recorded wrapper.
	const present = await singletonHolderPresent(paths, undefined, census);
	// Then this recorded granted fd counts as a holder, without pathname stat.
	expect(present).toBe(true);
});

test.each([
	["another owner", fdinfo.replace(String(pid), String(pid + 1))],
	["waiter", fdinfo.replace("1: FLOCK", "1: -> FLOCK")],
	["no grant", fdinfo.split("lock:")[0] ?? ""],
	["wrong device", fdinfo.replace("00:21:7", "00:22:7")],
	["wrong inode", fdinfo.replace("00:21:7", "00:21:8")],
])(
	"held-fd proof rejects %s in a synthetic negative control",
	async (_name, info) => {
		// Given a single explicit corruption of the real fdinfo grant.
		const io = procIO(info);
		// When the production reader correlates the grant with fd/mount metadata.
		const identity = await singletonLockIdentity(pid, io);
		// Then it cannot authorize holder admission.
		expect(identity).toBeNull();
	},
);

test("held-fd proof rejects a granted row on a nonregular file", async () => {
	// Given real fdinfo but a synthetic directory behind its fd.
	const io = procIO(fdinfo);
	const directory = await stat("/proc");
	directory.dev = 33;
	directory.ino = 7;
	// When production proof observes that directory rather than a regular file.
	const identity = await singletonLockIdentity(pid, {
		...io,
		stat: async () => directory,
	});
	// Then a grant row alone is not a holder.
	expect(identity).toBeNull();
});
