import { expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

useSessionOwnerForFile();
for (const mode of [
	"unwritable",
	"missing-directory",
	"missing-bash",
	"missing-helper",
	"nonexecutable-helper",
] as const) {
	test(`real launcher ${mode} fails before helper effects and retires its started group`, async () => {
		// Given a scratch side-effect marker which must never be reached.
		const f = helperDispatchFixture(),
			dir = await mkdtemp(join(tmpdir(), "helper-launch-failure-"));
		const marker = join(dir, "ran"),
			helper = join(dir, "helper");
		await writeFile(helper, `#!/usr/bin/bash\nprintf R > '${marker}'\n`, {
			mode: mode === "nonexecutable-helper" ? 0o600 : 0o700,
		});
		let probes = 0;
		const file = createHelperLaunchFile(dir, process.getuid?.() ?? -1);
		const step = createAddonHelperStep(["refresh"], {
			euid: () => 0,
			checkLauncher: () => undefined,
			launchFile: file,
			spawn: (argv, options) =>
				Bun.spawn(
					argv.map((arg, index) => {
						if (index === 3 && mode === "missing-bash")
							return join(dir, "absent-bash");
						if (index === 7 && mode === "unwritable") return "/dev/full";
						if (index === 7 && mode === "missing-directory")
							return join(dir, "absent", "pid");
						return arg === "/usr/bin/ceralive-addon-helper"
							? mode === "missing-helper"
								? join(dir, "absent-helper")
								: helper
							: arg;
					}),
					options,
				),
			kill: (pid, signal) => {
				probes++;
				return process.kill(pid, signal);
			},
		});
		try {
			// When the production runner executes the actual launcher.
			const result = await invokeHelperAction("refresh", {
				isRealDevice: async () => true,
				exec: async () => ({ stdout: "", stderr: "" }),
				createStep: () => step,
			}).catch((error: unknown) => error);
			// Then real exit evidence, not no-dispatch inference, releases the ticket.
			expect(result).toHaveProperty(
				"code",
				mode === "unwritable" || mode === "missing-directory"
					? 125
					: mode === "nonexecutable-helper"
						? 126
						: 127,
			);
			expect(step.dispatch()).toBe("started");
			expect(probes).toBe(1);
			expect(isDisruptiveActionPending()).toBe(false);
			expect(
				await readFile(marker, "utf8").catch((cause: unknown) => {
					if (
						cause instanceof Error &&
						"code" in cause &&
						cause.code === "ENOENT"
					)
						return null;
					throw cause;
				}),
			).toBeNull();
		} finally {
			file.cleanup();
			f.reset();
			await rm(dir, { recursive: true, force: true });
		}
	}, 15000);
}

test("retained launch FD recovers written identity even when its pathname is removed before the throw", async () => {
	// Given a real exclusively created identity file, unlinked after the launcher writes it.
	const f = helperDispatchFixture(),
		dir = await mkdtemp(join(tmpdir(), "helper-launch-unlink-"));
	const file = createHelperLaunchFile(dir, process.getuid?.() ?? -1);
	let path = "",
		pgid = 0;
	const step = createAddonHelperStep(["refresh"], {
		euid: () => 0,
		checkLauncher: () => undefined,
		launchFile: {
			...file,
			prepare: () => {
				path = file.prepare();
				return path;
			},
		},
		spawn: (argv, options) => {
			const result = Bun.spawnSync(
				argv.flatMap((arg) =>
					arg === "/usr/bin/ceralive-addon-helper" ? ["/usr/bin/true"] : arg,
				),
				options,
			);
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
			unlinkSync(path);
			throw Object.assign(new Error("pidfd"), {
				syscall: "pidfd_open",
				code: "ENFILE",
			});
		},
		kill: (pid) => {
			pgid = -pid;
			return true;
		},
	});
	try {
		// When the lost-handle path reads the retained inode instead of the removed name.
		await invokeHelperAction("refresh", {
			isRealDevice: async () => true,
			exec: async () => ({ stdout: "", stderr: "" }),
			createStep: () => step,
		}).catch((error: unknown) => error);
		// Then previously written identity remains unknown/live until the group probe retires it.
		expect(step.dispatch()).toBe("unknown");
		expect(pgid).toBeGreaterThan(1);
		expect(isDisruptiveActionPending()).toBe(true);
	} finally {
		file.cleanup();
		f.reset();
		await rm(dir, { recursive: true, force: true });
	}
}, 15000);

test("normal handle path never reads its pid file and preserves helper argv and sanitized effective shell environment", async () => {
	// Given poisoned parent shell variables and a scratch Bash helper that emits its inputs.
	const dir = await mkdtemp(join(tmpdir(), "helper-launch-env-"));
	const helper = join(dir, "helper");
	const oldBashEnv = process.env.BASH_ENV,
		oldShellOpts = process.env.SHELLOPTS;
	process.env.BASH_ENV = join(dir, "forbidden-hook");
	process.env.SHELLOPTS = "xtrace:monitor";
	await writeFile(
		helper,
		'#!/usr/bin/bash\nprintf "%s\\n" "$@"\n/usr/bin/env | /usr/bin/sort\n',
		{ mode: 0o700 },
	);
	let reads = 0;
	const file = createHelperLaunchFile(dir, process.getuid?.() ?? -1);
	const step = createAddonHelperStep(["enable", "cog-display"], {
		euid: () => 0,
		checkLauncher: () => undefined,
		launchFile: {
			...file,
			read: async () => {
				reads++;
				throw new Error("normal path cannot read identity");
			},
		},
		spawn: (argv, options) =>
			Bun.spawn(
				argv.map((arg) =>
					arg === "/usr/bin/ceralive-addon-helper" ? helper : arg,
				),
				options,
			),
		kill: process.kill,
	});
	try {
		// When the real launcher execs the Bash helper with the fixed environment.
		const result = await step.run();
		const direct = Bun.spawn([helper, "enable", "cog-display"], {
			env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(direct.stdout).text();
		await direct.exited;
		// Then the unchanged helper's effective environment and argument boundaries are identical.
		expect(result.stdout).toBe(stdout);
		expect(result.stdout).not.toContain("BASH_ENV=");
		expect(result.stdout).not.toContain("SHELLOPTS=");
		expect(reads).toBe(0);
		expect(await step.probe(new AbortController().signal)).toBe("completed");
	} finally {
		if (oldBashEnv === undefined) delete process.env.BASH_ENV;
		else process.env.BASH_ENV = oldBashEnv;
		if (oldShellOpts === undefined) delete process.env.SHELLOPTS;
		else process.env.SHELLOPTS = oldShellOpts;
		file.cleanup();
		await rm(dir, { recursive: true, force: true });
	}
}, 15000);
