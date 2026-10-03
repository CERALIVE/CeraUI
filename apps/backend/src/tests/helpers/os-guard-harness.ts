import { afterEach, test } from "bun:test";
import { watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Subprocess } from "bun";
import { SOFTWARE_UPDATE_LOCK } from "../../modules/system/update-orchestrator/lock.ts";
import { createOsStageJobOwner } from "../../modules/system/update-orchestrator/os-stage-job.ts";
import {
	OS_STAGE_GUARD_HELPER,
	OS_STAGE_GUARD_UNIT,
	type OsStageJobRecord,
} from "../../modules/system/update-orchestrator/os-stage-job-files.ts";
import { createTestOsStageGuard } from "./os-stage-test-guard.ts";

export function guardUnit(token: string, active = true, status = 0): string {
	return [
		`Id=${OS_STAGE_GUARD_UNIT}`,
		`FragmentPath=/run/systemd/transient/${OS_STAGE_GUARD_UNIT}`,
		"Description=CeraLive OS stage lock",
		"Transient=yes",
		"Type=exec",
		"RemainAfterExit=yes",
		"User=",
		"DropInPaths=",
		"ExecStartPre=",
		"ExecStartPost=",
		"ExecStop=",
		"ExecStopPost=",
		`ExecStart={ path=/usr/bin/flock ; argv[]=/usr/bin/flock -n -E 75 -x ${SOFTWARE_UPDATE_LOCK} ${OS_STAGE_GUARD_HELPER} ${token} ; ignore_errors=no ; start_time=[] ; stop_time=[] ; pid=100 ; code=(null) ; status=0 }`,
		`ActiveState=${active ? "active" : "inactive"}`,
		`MainPID=${active ? 100 : 0}`,
		`ExecMainStatus=${status}`,
	].join("\n");
}

type Child = Subprocess<"ignore", "ignore", "pipe">;
type Scope = {
	readonly cancel: AbortController;
	readonly children: Child[];
	readonly drains: Promise<string>[];
	readonly roots: string[];
	body: Promise<void>;
};
const scopes = new Set<Scope>();

afterEach(async () => {
	for (const scope of scopes) {
		scope.cancel.abort();
		for (const child of scope.children) {
			// The guardian forks bash/sleep: kill its private session, not only flock.
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch (error) {
				if (
					!(error instanceof Error && "code" in error && error.code === "ESRCH")
				)
					throw error;
			}
		}
		// A Bun test timeout does not cancel an async test body's continuation.
		await Promise.allSettled([
			scope.body,
			...scope.drains,
			...scope.children.map((child) => child.exited),
		]);
		for (const root of scope.roots)
			await rm(root, { recursive: true, force: true });
	}
	scopes.clear();
});

export function guardTest(
	name: string,
	record: OsStageJobRecord,
	run: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>,
): void {
	test(name, () => {
		const scope: Scope = {
			cancel: new AbortController(),
			children: [],
			drains: [],
			roots: [],
			body: Promise.resolve(),
		};
		scopes.add(scope);
		scope.body = harness(record, scope)
			.then(run)
			.catch((error: unknown) => {
				// Teardown cancellation belongs to the already failed test, not the next one.
				if (
					scope.cancel.signal.aborted &&
					error instanceof Error &&
					(error === scope.cancel.signal.reason ||
						error.cause === scope.cancel.signal.reason)
				)
					return;
				throw error;
			});
		return scope.body;
	});
}

async function harness(record: OsStageJobRecord, scope: Scope) {
	const { signal } = scope.cancel;
	const root = await mkdtemp(join(tmpdir(), "ceraui-os-guard-"));
	scope.roots.push(root);
	signal.throwIfAborted();
	const directory = join(root, "job");
	const lock = join(root, "update.lock");
	const helper = await createTestOsStageGuard(root, directory);
	const commands: string[][] = [];
	let child: Child | undefined;
	let stopped = false;
	let changed = Promise.withResolvers<void>();
	let dirty = false;
	const wrongToken = Promise.withResolvers<void>();
	const spawn = (
		argv: string[],
		env: Record<string, string | undefined> = process.env,
	) => {
		signal.throwIfAborted();
		const proc = Bun.spawn(argv, {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
			env,
			detached: true,
		});
		scope.children.push(proc);
		return proc;
	};
	const owner = createOsStageJobOwner(record, {
		cliGone: async () => true,
		inspect: async () =>
			stopped
				? { kind: "absent" }
				: child?.exitCode === null
					? {
							kind: "live",
							pid: String(child.pid),
							invocationId: "a".repeat(32),
						}
					: {
							kind: "terminal",
							cleanExit: child?.exitCode === 0,
							invocationId: "a".repeat(32),
							exitStatus: child?.exitCode ?? 0,
						},
		kernel: async ({ pid }) => {
			// A contention probe before the helper owns the lock could win the race itself.
			if (pid !== null && !(await Bun.file(join(directory, "ready")).exists()))
				return false;
			const probe = spawn(["flock", "-n", "-E", "75", "-x", lock, "true"]);
			scope.drains.push(new Response(probe.stderr).text());
			return (await probe.exited) === (pid === null ? 0 : 75);
		},
		jobIdle: async () => true,
		directory,
		uid: process.getuid?.() ?? -1,
		now: () => performance.now(),
		sleep: async () => {
			if (!dirty)
				await Promise.race([
					changed.promise,
					child?.exited,
					delay(10_000, undefined, { signal }),
				]);
			signal.throwIfAborted();
			dirty = false;
			changed = Promise.withResolvers<void>();
		},
		run: async (argv) => {
			signal.throwIfAborted();
			commands.push(argv);
			if (argv[1] === "stop") stopped = true;
			if (argv[0] === "systemd-run") {
				const watcher = watch(directory, () => {
					dirty = true;
					changed.resolve();
				});
				signal.addEventListener("abort", () => watcher.close(), { once: true });
				child = spawn([
					"flock",
					"-n",
					"-E",
					"75",
					"-x",
					lock,
					"bash",
					"-x",
					helper,
					record.attemptId,
				]);
				const guardian = child;
				scope.drains.push(
					(async () => {
						let trace = "";
						for await (const chunk of guardian.stderr) {
							trace += new TextDecoder().decode(chunk);
							if (trace.includes("[[ different-attempt =="))
								wrongToken.resolve();
						}
						watcher.close();
						return trace;
					})(),
				);
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (argv.includes("--property=LoadState"))
				return { exitCode: 0, stderr: "", stdout: "LoadState=not-found\n" };
			return {
				exitCode: 0,
				stderr: "",
				stdout: guardUnit(
					record.attemptId,
					child?.exitCode === null,
					child?.exitCode ?? 0,
				),
			};
		},
	});
	const contender = async () => {
		const proc = spawn(["flock", "-n", "-E", "75", "-x", lock, "true"]);
		scope.drains.push(new Response(proc.stderr).text());
		const result = await proc.exited;
		signal.throwIfAborted();
		return result;
	};
	return {
		owner,
		directory,
		commands,
		contender,
		waitForWrongToken: async () => {
			await Promise.race([
				wrongToken.promise,
				delay(10_000, undefined, { signal }).then(() => {
					throw new Error("guardian did not inspect the wrong release token");
				}),
			]);
			signal.throwIfAborted();
		},
	};
}
