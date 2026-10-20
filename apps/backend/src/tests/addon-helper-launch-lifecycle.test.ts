import { afterEach, expect, test } from "bun:test";
import {
	chmod,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAddonHelperStep } from "../helpers/addon-helper-step.ts";
import { createHelperLaunchFile } from "../helpers/helper-launch-file.ts";
import { isDisruptiveActionPending } from "../modules/system/disruptive-action-reservation.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	helperDispatchFixture,
	invokeHelperAction,
} from "./helpers/helper-dispatch-fixture.ts";
import { sysextDescriptor } from "./sysext-action-fixture.ts";

useSessionOwnerForFile();
let f: ReturnType<typeof helperDispatchFixture> | undefined;
afterEach(() => f?.reset());
for (const action of ["enable", "disable", "refresh"] as const) {
	for (const code of ["EACCES", "ENOENT", "ENOSPC", "EROFS"] as const) {
		test(`${action} launch preparation ${code} prevents spawn and releases with original failure`, async () => {
			// Given a private-file preparation failure before helper dispatch.
			f = helperDispatchFixture();
			const original = Object.assign(new Error("prepare"), { code });
			let spawns = 0;
			const step = createAddonHelperStep([action], {
				euid: () => 0,
				checkLauncher: () => undefined,
				launchFile: {
					prepare: () => {
						throw original;
					},
					read: async () => null,
					cleanup: () => undefined,
				},
				spawn: () => {
					spawns++;
					throw new Error("forbidden dispatch");
				},
				kill: () => undefined,
			});
			// When the admitted real wrapper cannot prepare identity.
			const result = await invokeHelperAction(action, {
				isRealDevice: async () => true,
				exec: async () => ({ stdout: "", stderr: "" }),
				readDescriptor: async () => sysextDescriptor,
				createStep: () => step,
			}).catch((error: unknown) => error);
			// Then no helper can run and no resolver wedge remains.
			expect(result).toBe(original);
			expect(step.dispatch()).toBe("none");
			expect(spawns).toBe(0);
			expect(isDisruptiveActionPending()).toBe(false);
			expect(f.delays).toEqual([]);
		});
	}
	for (const code of ["EACCES", "EIO", "ENOSPC"] as const) {
		test(`${action} unreadable identity ${code} holds until repaired bytes and group retirement`, async () => {
			// Given lost ownership whose retained file cannot currently be read.
			f = helperDispatchFixture();
			let repaired = false,
				probes = 0;
			const original = Object.assign(new Error("pidfd"), {
				syscall: "pidfd_open",
			});
			const step = createAddonHelperStep([action], {
				euid: () => 0,
				checkLauncher: () => undefined,
				launchFile: {
					prepare: () => "/fixture/file",
					read: async () => {
						if (!repaired) throw Object.assign(new Error("read"), { code });
						return "42\n";
					},
					cleanup: () => {
						throw new Error("best-effort cleanup");
					},
				},
				spawn: () => {
					throw original;
				},
				kill: () => {
					probes++;
					throw Object.assign(new Error("retired"), { code: "ESRCH" });
				},
			});
			// When observation retries after repair, not merely after elapsed time.
			const result = await invokeHelperAction(action, {
				isRealDevice: async () => true,
				exec: async () => ({ stdout: "", stderr: "" }),
				readDescriptor: async () => sysextDescriptor,
				createStep: () => step,
			}).catch((error: unknown) => error);
			expect(result).toBe(original);
			expect(isDisruptiveActionPending()).toBe(true);
			expect(probes).toBe(0);
			repaired = true;
			await f.wakeups[0]?.();
			// Then repaired authoritative bytes plus ESRCH release despite cleanup failure.
			expect(probes).toBe(1);
			expect(isDisruptiveActionPending()).toBe(false);
		});
	}
}

test("first-use stale sweep excludes active current files and cleanup does not delete a replacement inode", async () => {
	// Given crash residue and a fresh private directory, then two current requests.
	const dir = await mkdtemp(join(tmpdir(), "helper-launch-sweep-"));
	const stale = join(dir, "00000000-0000-4000-8000-000000000000.pid");
	await writeFile(stale, "42\n");
	const first = createHelperLaunchFile(dir, process.getuid?.() ?? -1),
		second = createHelperLaunchFile(dir, process.getuid?.() ?? -1);
	try {
		// When first-use sweeps and subsequent preparation preserves active files.
		const a = first.prepare(),
			b = second.prepare();
		await writeFile(a, "123\n");
		await writeFile(b, "456\n");
		expect(await readFile(stale, "utf8").catch(() => null)).toBeNull();
		expect(await first.read()).toBe("123\n");
		expect(a).not.toBe(b);
		await rm(a);
		await writeFile(a, "replacement\n");
		first.cleanup();
		first.cleanup();
		// Then current sibling evidence and a replacement inode survive exact-owned cleanup.
		expect(await readFile(a, "utf8")).toBe("replacement\n");
		expect(await second.read()).toBe("456\n");
	} finally {
		first.cleanup();
		second.cleanup();
		await rm(dir, { recursive: true, force: true });
	}
});

for (const shape of ["public", "symlink", "wrong-owner"] as const) {
	test(`launch directory ${shape} refuses identity preparation`, async () => {
		// Given a directory whose ownership/private ancestry does not satisfy the contract.
		const dir = await mkdtemp(join(tmpdir(), "helper-launch-private-"));
		if (shape === "public") await chmod(dir, 0o755);
		if (shape === "symlink") await symlink(dir, `${dir}-link`);
		const file = createHelperLaunchFile(
			shape === "symlink" ? `${dir}-link` : dir,
			shape === "wrong-owner" ? -1 : (process.getuid?.() ?? -1),
		);
		try {
			// When preparation tries to create effect authority in that directory.
			expect(() => file.prepare()).toThrow();
			// Then this refusal stays before any launcher dispatch.
		} finally {
			file.cleanup();
			await rm(`${dir}-link`, { force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});
}
