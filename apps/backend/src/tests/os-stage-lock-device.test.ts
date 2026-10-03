import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOFTWARE_UPDATE_LOCK } from "../modules/system/update-orchestrator/lock.ts";
import {
	type OsGuardKernelDeps,
	proveOsGuardKernelOwnership,
} from "../modules/system/update-orchestrator/os-stage-guard-lock.ts";
import { OS_STAGE_GUARD_HELPER } from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import {
	kernelDeviceFromMount,
	readOsLockKernelDevice,
} from "../modules/system/update-orchestrator/os-stage-lock-device.ts";
import { realDeviceSection } from "./helpers/real-device-fixture.ts";

const attemptId = "33333333-3333-4333-8333-333333333333";
const pid = "1168323";
const group = "/system.slice/ceralive-os-stage-guard.service";

test.each([true, false])(
	"same-inode foreign filesystem does not disrupt held=%s proof",
	async (held) => {
		const [ino, dev] = (await realDeviceSection("rock-guardian", "lock-stat"))
			.trim()
			.split(" ")
			.map(Number);
		const identity = { ino: ino ?? 0, dev: dev ?? 0 };
		const fdinfo = await realDeviceSection("rock-guardian", "fdinfo-3");
		const locks = await realDeviceSection("rock-guardian", "locks");
		const device = kernelDeviceFromMount(
			fdinfo,
			"34 23 0:29 / /run rw - tmpfs tmpfs rw\n",
			identity.ino,
		);
		const deps: OsGuardKernelDeps = {
			lock: SOFTWARE_UPDATE_LOCK,
			device: async () => device,
			identity: async () => identity,
			list: async (path) => (path === "/proc" ? (held ? [pid] : []) : ["3"]),
			read: async (path) => {
				if (path === "/proc/locks")
					return `${held ? locks : ""}9: POSIX ADVISORY WRITE 500 08:02:${identity.ino} 0 EOF\n`;
				if (path.endsWith("cgroup.procs")) return held ? `${pid}\n` : "";
				if (path.endsWith("/stat"))
					return realDeviceSection("rock-guardian", `proc-stat-${pid}`);
				if (path.endsWith("/cgroup")) return `0::${group}\n`;
				if (path.endsWith("/cmdline"))
					return [
						"/usr/bin/flock",
						"-n",
						"-E",
						"75",
						"-x",
						SOFTWARE_UPDATE_LOCK,
						OS_STAGE_GUARD_HELPER,
						attemptId,
						"",
					].join("\0");
				if (path.includes("/fdinfo/")) return fdinfo;
				throw new Error(`unexpected fixture read ${path}`);
			},
		};
		expect(
			await proveOsGuardKernelOwnership(
				{ pid: held ? pid : null, attemptId },
				deps,
			),
		).toBe(true);
	},
);

test("mount metadata resolves hex kernel device numbers without decoding st_dev", async () => {
	const fdinfo = await realDeviceSection("rock-guardian", "fdinfo-3");
	expect(
		kernelDeviceFromMount(
			fdinfo,
			"34 23 259:65535 / /run rw - tmpfs tmpfs rw\n",
			8215,
		),
	).toBe("103:ffff");
});

test.each([
	["missing mount", "", 8215],
	["different inode", "34 23 0:29 / /run rw - tmpfs tmpfs rw\n", 9000],
	[
		"duplicate mount",
		"34 23 0:29 / /run rw - tmpfs tmpfs rw\n34 23 8:2 / /run rw - ext4 disk rw\n",
		8215,
	],
] as const)("%s refuses device mapping", async (_name, mounts, inode) => {
	const fdinfo = await realDeviceSection("rock-guardian", "fdinfo-3");
	expect(kernelDeviceFromMount(fdinfo, mounts, inode)).toBeNull();
});

test("a real local fd maps its validated filesystem identity", async () => {
	const root = await mkdtemp(join(tmpdir(), "ceraui-device-map-"));
	try {
		const path = join(root, "lock");
		await writeFile(path, "", { mode: 0o600 });
		const value = await stat(path);
		expect(
			await readOsLockKernelDevice(path, { dev: value.dev, ino: value.ino }),
		).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
		expect(
			await readOsLockKernelDevice(path, {
				dev: value.dev + 1,
				ino: value.ino,
			}),
		).toBeNull();
	} finally {
		await rm(root, { recursive: true });
	}
});
