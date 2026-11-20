import type { Subprocess } from "bun";
import { logger } from "./logger.ts";

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
interface PipeReader {
	read(): Promise<
		| { readonly done: true }
		| { readonly done: false; readonly value: Uint8Array }
	>;
	cancel(): Promise<void>;
	releaseLock(): void;
}
export interface BoundedSpawnOptions {
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly maxBuffer?: number;
	readonly onExit?: (exitCode: number) => void;
	readonly onSpawn?: (child: Subprocess<"ignore", "pipe", "pipe">) => void;
	/** Observes real child exit even when setup or bounded collection fails. */
	readonly onChildExit?: (exited: Promise<number>) => void;
	/** The caller owns settlement of a daemon request separately from this result. */
	readonly preserveChild?: true;
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
	const exit = child.exited;
	let terminationIssued = false;
	const exited = exit.then(
		(code) => ({ kind: "exit", code }) as const,
		(error: unknown) => {
			logger.error("Bounded child exit observation failed", {
				pid: child.pid,
				error,
			});
			return { kind: "observation_failed", error } as const;
		},
	);
	const schedule =
		opts.scheduleTimeout ??
		((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
	const cancel = opts.cancelTimeout ?? ((timer: Timer) => clearTimeout(timer));
	const acc = { stdout: "", stderr: "" };
	const readers: PipeReader[] = [];
	let collecting = true;
	let discarding = false;
	const overflow = Promise.withResolvers<Error>();
	const drain = async (reader: PipeReader, key: "stdout" | "stderr") => {
		const decoder = new TextDecoder();
		let bytes = 0;
		while (collecting) {
			const chunk = await reader.read();
			if (!collecting) break;
			if (chunk.done) {
				if (!discarding) acc[key] += decoder.decode();
				break;
			}
			if (discarding) continue;
			bytes += chunk.value.byteLength;
			if (opts.maxBuffer !== undefined && bytes > opts.maxBuffer) {
				overflow.resolve(new Error(`${key} maxBuffer length exceeded`));
				if (!opts.preserveChild) break;
				discarding = true;
				continue;
			}
			acc[key] += decoder.decode(chunk.value, { stream: true });
		}
	};
	const deadline = Promise.withResolvers<"timeout" | "abort">();
	let timer: Timer | undefined;
	const onAbort = () => deadline.resolve("abort");
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
	const closeReaders = () => {
		collecting = false;
		for (const reader of readers) {
			void reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
	};
	try {
		let drained: Promise<unknown>;
		try {
			opts.onChildExit?.(exit);
			opts.onSpawn?.(child);
			const stdout = child.stdout.getReader();
			readers.push(stdout);
			const stderr = child.stderr.getReader();
			readers.push(stderr);
			timer = schedule(() => deadline.resolve("timeout"), opts.timeoutMs);
			opts.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts.signal?.aborted) onAbort();
			drained = Promise.allSettled([
				drain(stdout, "stdout"),
				drain(stderr, "stderr"),
			]);
		} catch (error) {
			terminationIssued = true;
			if (!opts.preserveChild) {
				signal("SIGKILL");
				await bounded(exited, BOUNDED_SPAWN_REAP_MS);
			}
			throw error;
		}
		const outcome = await Promise.race([
			exited.then(async (result) => {
				if (result.kind === "exit") {
					if (!terminationIssued) opts.onExit?.(result.code);
					await Promise.race([drained, deadline.promise]);
				}
				return result;
			}),
			deadline.promise.then(
				(reason) => ({ kind: "deadline", reason }) as const,
			),
			overflow.promise.then((error) => ({ kind: "overflow", error }) as const),
		]);
		if (outcome.kind === "observation_failed") {
			if (!opts.preserveChild) signal("SIGKILL");
			throw outcome.error;
		}
		const successfulBeforeTermination = child.exitCode === 0;
		if (
			outcome.kind === "overflow" ||
			(outcome.kind === "deadline" && !successfulBeforeTermination)
		) {
			terminationIssued = true;
			if (!opts.preserveChild) {
				signal("SIGTERM");
				await bounded(exited, BOUNDED_SPAWN_TERM_GRACE_MS);
				signal("SIGKILL");
				await bounded(exited, BOUNDED_SPAWN_REAP_MS);
				await bounded(drained, BOUNDED_SPAWN_DRAIN_MS);
			}
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
		if (timer !== undefined) cancel(timer);
		opts.signal?.removeEventListener("abort", onAbort);
		if (opts.preserveChild) {
			discarding = true;
			void exited.then(closeReaders);
		} else closeReaders();
	}
}
