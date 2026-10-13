import type { Subprocess } from "bun";

export class SpawnTimeoutError extends Error {
	constructor(
		public readonly command: string,
		public readonly partialStdout = "",
		public readonly partialStderr = "",
	) {
		super(`Spawn timed out: ${command}`);
		this.name = "SpawnTimeoutError";
	}
}

export class SpawnAbortError extends SpawnTimeoutError {}

export interface SpawnWithTimeoutResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

type Timer = ReturnType<typeof setTimeout> | number;
export interface BoundedSpawnOptions {
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly maxBuffer?: number;
	readonly onExit?: (exitCode: number) => void;
	readonly onSpawn?: (child: Subprocess<"ignore", "pipe", "pipe">) => void;
	readonly scheduleTimeout?: (callback: () => void, delayMs: number) => Timer;
	readonly cancelTimeout?: (timer: Timer) => void;
}

export const BOUNDED_SPAWN_TERM_GRACE_MS = 100;
export const BOUNDED_SPAWN_REAP_MS = 100;
export const BOUNDED_SPAWN_DRAIN_MS = 50;

/** The command deadline includes pipe drainage; retirement has separate finite bounds. */
export async function collectBoundedChild(
	child: Subprocess<"ignore", "pipe", "pipe">,
	command: string,
	opts: BoundedSpawnOptions & { readonly timeoutMs: number },
): Promise<SpawnWithTimeoutResult> {
	const schedule =
		opts.scheduleTimeout ??
		((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
	const cancel = opts.cancelTimeout ?? ((timer: Timer) => clearTimeout(timer));
	const acc = { stdout: "", stderr: "" };
	const stdout = child.stdout.getReader();
	const stderr = child.stderr.getReader();
	const readers = [stdout, stderr];
	let collecting = true;
	const overflow = Promise.withResolvers<Error>();
	const drain = async (reader: typeof stdout, key: "stdout" | "stderr") => {
		const decoder = new TextDecoder();
		let bytes = 0;
		while (collecting) {
			const chunk = await reader.read();
			if (!collecting) break;
			if (chunk.done) {
				acc[key] += decoder.decode();
				break;
			}
			bytes += chunk.value.byteLength;
			if (opts.maxBuffer !== undefined && bytes > opts.maxBuffer) {
				overflow.resolve(new Error(`${key} maxBuffer length exceeded`));
				break;
			}
			acc[key] += decoder.decode(chunk.value, { stream: true });
		}
	};
	const drained = Promise.allSettled([
		drain(stdout, "stdout"),
		drain(stderr, "stderr"),
	]);
	const deadline = Promise.withResolvers<"timeout" | "abort">();
	const timer = schedule(() => deadline.resolve("timeout"), opts.timeoutMs);
	const onAbort = () => deadline.resolve("abort");
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	if (opts.signal?.aborted) onAbort();
	let terminationIssued = false;
	const exited = child.exited.then((code) => {
		if (!terminationIssued) opts.onExit?.(code);
		return code;
	});
	const bounded = async (work: Promise<unknown>, ms: number) => {
		let bound: Timer | undefined;
		try {
			await Promise.race([
				work,
				new Promise<void>((resolve) => {
					bound = schedule(resolve, ms);
				}),
			]);
		} finally {
			if (bound !== undefined) cancel(bound);
		}
	};
	const signal = (value: "SIGTERM" | "SIGKILL") => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			child.kill(value);
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ESRCH")
			)
				throw error;
		}
	};
	try {
		try {
			opts.onSpawn?.(child);
		} catch (error) {
			terminationIssued = true;
			signal("SIGKILL");
			await bounded(exited, BOUNDED_SPAWN_REAP_MS);
			throw error;
		}
		const outcome = await Promise.race([
			exited.then(async (code) => {
				await Promise.race([drained, deadline.promise]);
				return { kind: "exit", code } as const;
			}),
			deadline.promise.then(
				(reason) => ({ kind: "deadline", reason }) as const,
			),
			overflow.promise.then((error) => ({ kind: "overflow", error }) as const),
		]);
		const successfulBeforeTermination = child.exitCode === 0;
		if (
			outcome.kind === "overflow" ||
			(outcome.kind === "deadline" && !successfulBeforeTermination)
		) {
			terminationIssued = true;
			signal("SIGTERM");
			await bounded(exited, BOUNDED_SPAWN_TERM_GRACE_MS);
			signal("SIGKILL");
			await bounded(exited, BOUNDED_SPAWN_REAP_MS);
			await bounded(drained, BOUNDED_SPAWN_DRAIN_MS);
			if (outcome.kind === "overflow") throw outcome.error;
			throw outcome.reason === "abort"
				? new SpawnAbortError(command, acc.stdout, acc.stderr)
				: new SpawnTimeoutError(command, acc.stdout, acc.stderr);
		}
		if (successfulBeforeTermination)
			await bounded(drained, BOUNDED_SPAWN_DRAIN_MS);
		return {
			exitCode: outcome.kind === "exit" ? outcome.code : 0,
			stdout: acc.stdout,
			stderr: acc.stderr,
		};
	} finally {
		collecting = false;
		cancel(timer);
		opts.signal?.removeEventListener("abort", onAbort);
		for (const reader of readers) void reader.cancel().catch(() => undefined);
	}
}
