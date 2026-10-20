import { spyOn } from "bun:test";
import { watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const COMMAND_BUDGET = 20_000;

export function manualCommandTimer() {
	const timerHost: {
		setTimeout: (
			callback: () => void,
			delay?: number,
		) => ReturnType<typeof setTimeout>;
	} = globalThis;
	const native = timerHost.setTimeout;
	let fire: (() => void) | undefined;
	const replacement = (callback: () => void, delay?: number) => {
		if (delay === COMMAND_BUDGET) {
			fire = callback;
			return native(() => undefined, 60_000);
		}
		return native(callback, delay);
	};
	const timers = spyOn(timerHost, "setTimeout").mockImplementation(replacement);
	return {
		fire: () => {
			if (!fire) throw new Error("command did not register its timer");
			fire();
		},
		[Symbol.dispose]() {
			timers.mockRestore();
		},
	};
}

/** Real child readiness drives a manually fired command timer; no startup race. */
export async function terminationChild() {
	const root = await mkdtemp(join(tmpdir(), "termination-child-"));
	const path = join(root, "ready");
	const ready = Promise.withResolvers<void>();
	const watcher = watch(root, (_event, filename) => {
		if (filename === "ready") ready.resolve();
	});
	const source = `
		process.on('SIGTERM', () => {
			process.stdout.write('TERM_EXIT_ZERO');
			process.exit(0);
		});
		process.stdout.write('READY');
		process.stderr.write('DIAGNOSTIC');
		await Bun.write(${JSON.stringify(path)}, 'ready');
		await Bun.sleep(60000);
	`;
	const clock = manualCommandTimer();
	const spawns = spyOn(Bun, "spawn");
	return {
		args: ["-e", source],
		command: `exec '${process.execPath}' -e '${source.replaceAll("'", "'\\''")}'`,
		ready: ready.promise,
		deadline: clock.fire,
		async [Symbol.asyncDispose]() {
			clock[Symbol.dispose]();
			const children = spawns.mock.results
				.filter((result) => result.type === "return")
				.map((result) => result.value);
			spawns.mockRestore();
			for (const child of children) {
				if (child.exitCode === null && child.signalCode === null)
					child.kill("SIGKILL");
				await child.exited;
			}
			watcher.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

export async function settled(work: Promise<unknown>) {
	try {
		return { kind: "success", value: await work } as const;
	} catch (error) {
		return { kind: "failure", error } as const;
	}
}
