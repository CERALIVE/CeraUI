/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import type { RecordedSoftwareUpdateOutcome } from "./software-update-output.ts";
import {
	buildDetachedAptAllCommand,
	buildDetachedAptUpgradeCommand,
	type DetachedAptServiceDeps,
	type DetachedAptServiceState,
	defaultDetachedAptServiceDeps,
	type SoftwareUpdateOutputPaths,
} from "./software-update-service.ts";

export type { SoftwareUpdateOutputPaths } from "./software-update-service.ts";
export { buildDetachedAptUpgradeCommand } from "./software-update-service.ts";

const OUTPUT_POLL_INTERVAL_MS = 250;
const FINAL_DRAIN_MAX_FAILURES = 20;
const RETIRE_ATTEMPTS = 5;
// 16 MiB per file per poll; a backlog beyond that is caught up on later polls.
const MAX_READS_PER_DRAIN = 256;
const INSPECT_RETRY_MAX_MS = 30_000;
/** How long a retired unit's recorded outcome is told to reconnecting tabs. */
export const RECORDED_OUTCOME_REPLAY_MS = 30 * 60_000;

export type SoftwareUpdateOutputHandlers = {
	readonly onStdout: (chunk: string) => void;
	readonly onStderr: (chunk: string) => void;
	/** APT::Status-Fd records; read only from a unit that writes them. */
	readonly onStatus?: (chunk: string) => void;
	/**
	 * Runs after every poll's reads and once after the final drain.
	 * `caughtUp`: every file was read to its end without an error.
	 */
	readonly onDrained?: (caughtUp: boolean) => void;
	/** The status file kept failing and is no longer read. */
	readonly onStatusLost?: () => void;
	/** `aptStatus`: the recovered unit writes the status channel. */
	readonly onAttached?: (aptStatus: boolean) => void;
	readonly onObserverError?: (
		error: unknown,
		suppressedRetries?: number,
	) => void;
};

export type DetachedAptUpgradeDeps = DetachedAptServiceDeps;

export type RecoveredDetachedAptUpgrade =
	| AttachedDetachedAptUpgrade
	| {
			/**
			 * An earlier lifetime observed this exit and acted on it: the unit is
			 * gone, or it is a finished unit whose retirement failed. Never adopted
			 * again, so a unit that cannot be retired cannot restart CeraUI twice.
			 */
			readonly recorded: RecordedSoftwareUpdateOutcome;
			readonly unit: "absent" | "finished";
	  };

export type AttachedDetachedAptUpgrade = {
	readonly completion: Promise<number>;
	/**
	 * True when the unit was ALREADY in its "finished" state at the moment we
	 * inspected it — i.e. only a bounded final drain + cleanup remain on
	 * `completion`, never an unbounded poll loop (the "running" case can take
	 * minutes). A caller may safely AWAIT `completion` when this is true; it
	 * must not when it is false, or it risks blocking boot on a live apt
	 * transaction. See software-updates.ts `recoverSoftwareUpdate()`.
	 */
	readonly wasAlreadyFinished: boolean;
};

type OutputCursor = {
	readonly path: string;
	readonly offset: number;
	readonly decoder: TextDecoder;
	readonly emit: (chunk: string) => void;
	/** Telemetry only: its failures never block a drain or the outcome. */
	readonly optional?: true;
	readonly failures?: number;
};

export class DetachedAptServiceVanishedError extends Error {
	constructor() {
		super("software-update transient service vanished after launch");
		this.name = "DetachedAptServiceVanishedError";
	}
}

export class DetachedAptServiceAlreadyExistsError extends Error {
	constructor() {
		super("a detached apt transaction already exists");
		this.name = "DetachedAptServiceAlreadyExistsError";
	}
}

export class DetachedAptServiceCleanupError extends Error {
	constructor(
		readonly transactionExitCode: number,
		readonly cleanupError: unknown,
		/** false: nothing stops a later lifetime adopting this finished unit again. */
		readonly outcomeRecorded: boolean,
	) {
		super("apt transaction finished, but its transient service cleanup failed");
		this.name = "DetachedAptServiceCleanupError";
	}
}

function reportObserverError(
	handlers: SoftwareUpdateOutputHandlers,
	error: unknown,
): void {
	handlers.onObserverError?.(error);
}

async function drainOutputCursor(
	cursor: OutputCursor,
	read: DetachedAptUpgradeDeps["readOutput"],
): Promise<{ readonly cursor: OutputCursor; readonly atEnd: boolean }> {
	const next = await read(cursor.path, cursor.offset);
	if (next.bytes.byteLength > 0) {
		const text = cursor.decoder.decode(next.bytes, { stream: true });
		if (text.length > 0) cursor.emit(text);
	}
	// One read is bounded; only an empty read proves the file was drained.
	return {
		cursor: { ...cursor, offset: next.nextOffset },
		atEnd: next.bytes.byteLength === 0,
	};
}

async function drainAvailableOutput(
	cursors: readonly OutputCursor[],
	handlers: SoftwareUpdateOutputHandlers,
	readOutput: DetachedAptUpgradeDeps["readOutput"],
): Promise<{
	readonly cursors: readonly OutputCursor[];
	readonly caughtUp: boolean;
	readonly failed: boolean;
}> {
	let caughtUp = true;
	let failed = false;
	const drained: OutputCursor[] = [];
	// In order: apt writes a status record before the dpkg output it announces,
	// so the status file read last is never behind the transcript read first.
	for (const start of cursors) {
		let cursor: OutputCursor | undefined = start;
		for (let reads = 0; ; reads++) {
			if (reads === MAX_READS_PER_DRAIN) {
				caughtUp = false;
				break;
			}
			try {
				const next = await drainOutputCursor(cursor, readOutput);
				cursor = { ...next.cursor, failures: 0 };
				if (next.atEnd) break;
			} catch (error) {
				reportObserverError(handlers, error);
				caughtUp = false;
				if (!cursor.optional) {
					failed = true;
					break;
				}
				const failures = (cursor.failures ?? 0) + 1;
				cursor =
					failures < FINAL_DRAIN_MAX_FAILURES
						? { ...cursor, failures }
						: undefined;
				if (!cursor) handlers.onStatusLost?.();
				break;
			}
		}
		if (cursor) drained.push(cursor);
	}
	return { cursors: drained, caughtUp, failed };
}

function createOutputCursors(
	paths: SoftwareUpdateOutputPaths,
	handlers: SoftwareUpdateOutputHandlers,
	aptStatus: boolean,
): readonly OutputCursor[] {
	const cursor = (
		path: string,
		emit: (chunk: string) => void,
	): OutputCursor => ({ path, offset: 0, decoder: new TextDecoder(), emit });
	return [
		cursor(paths.stdout, handlers.onStdout),
		cursor(paths.stderr, handlers.onStderr),
		// A pre-channel unit never wrote this file; it may hold an older run's records.
		...(aptStatus && handlers.onStatus
			? [
					{
						...cursor(paths.status, handlers.onStatus),
						optional: true as const,
					},
				]
			: []),
	];
}

type FinishedState = Extract<
	DetachedAptServiceState,
	{ readonly kind: "finished" }
>;

async function retireDetachedAptUnit(
	state: FinishedState,
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps,
	outcomeRecorded: boolean,
): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await deps.cleanup(state);
			return;
		} catch (error) {
			if (attempt === RETIRE_ATTEMPTS)
				throw new DetachedAptServiceCleanupError(
					state.exitCode,
					error,
					outcomeRecorded,
				);
			reportObserverError(handlers, error);
			await deps.sleep(OUTPUT_POLL_INTERVAL_MS);
		}
	}
}

export type ObserveOptions = {
	/** false: observe only; the unit stays for a later owner to retire. */
	readonly retire?: boolean;
};

async function observeDetachedAptUpgrade(
	initialState: Exclude<DetachedAptServiceState, { readonly kind: "absent" }>,
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps,
	options: ObserveOptions = {},
): Promise<number> {
	let state: DetachedAptServiceState = initialState;
	let cursors = createOutputCursors(
		deps.outputPaths,
		handlers,
		initialState.aptStatus === true,
	);
	let inspectRetryMs = 1_000;
	let lastInspectReportAt = -Infinity;
	let suppressedInspectErrors = 0;

	while (state.kind === "running") {
		const drained = await drainAvailableOutput(
			cursors,
			handlers,
			deps.readOutput,
		);
		cursors = drained.cursors;
		handlers.onDrained?.(drained.caughtUp);
		await deps.sleep(OUTPUT_POLL_INTERVAL_MS);
		try {
			state = await deps.inspect();
		} catch (error) {
			const now = deps.now?.() ?? Date.now();
			if (now - lastInspectReportAt >= INSPECT_RETRY_MAX_MS) {
				handlers.onObserverError?.(error, suppressedInspectErrors);
				lastInspectReportAt = now;
				suppressedInspectErrors = 0;
			} else {
				suppressedInspectErrors++;
			}
			await deps.sleep(inspectRetryMs);
			inspectRetryMs = Math.min(inspectRetryMs * 2, INSPECT_RETRY_MAX_MS);
			continue;
		}
		inspectRetryMs = 1_000;
		lastInspectReportAt = -Infinity;
		suppressedInspectErrors = 0;
		if (state.kind === "absent") throw new DetachedAptServiceVanishedError();
	}
	if (state.kind !== "finished") throw new DetachedAptServiceVanishedError();

	let finalDrainFailures = 0;
	let caughtUp = false;
	for (;;) {
		const drained = await drainAvailableOutput(
			cursors,
			handlers,
			deps.readOutput,
		);
		cursors = drained.cursors;
		caughtUp = drained.caughtUp;
		if (caughtUp) break;
		// The exit status is the outcome; unreadable output only costs its transcript.
		if (drained.failed && ++finalDrainFailures >= FINAL_DRAIN_MAX_FAILURES)
			break;
		await deps.sleep(OUTPUT_POLL_INTERVAL_MS);
	}
	for (const cursor of cursors) {
		const tail = cursor.decoder.decode();
		if (tail.length > 0) cursor.emit(tail);
	}
	handlers.onDrained?.(caughtUp);
	// APT has exited, so this read was complete; record before retiring.
	const outcomeRecorded = await deps
		.recordOutcome({
			exitCode: state.exitCode,
			at: deps.now?.() ?? Date.now(),
		})
		.then(
			() => true,
			(error: unknown) => {
				reportObserverError(handlers, error);
				return false;
			},
		);
	if (options.retire !== false)
		await retireDetachedAptUnit(state, handlers, deps, outcomeRecorded);
	return state.exitCode;
}

async function launchDetachedAptUnit(
	command: (aptStatus: boolean) => readonly string[],
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps,
): Promise<number> {
	const existing = await deps.inspect();
	if (existing.kind === "running")
		throw new DetachedAptServiceAlreadyExistsError();
	if (existing.kind === "finished") {
		// Only a leftover whose exit an observer recorded; only its retirement failed.
		if (!(await deps.readRecordedOutcome()))
			throw new DetachedAptServiceAlreadyExistsError();
		await retireDetachedAptUnit(existing, handlers, deps, true).catch(() => {
			throw new DetachedAptServiceAlreadyExistsError();
		});
		if ((await deps.inspect()).kind !== "absent")
			throw new DetachedAptServiceAlreadyExistsError();
	}
	const aptStatus = (await deps.prepareOutput())?.status !== false;
	await deps.start(command(aptStatus));
	if (!aptStatus) handlers.onStatusLost?.();
	return observeDetachedAptUpgrade(
		aptStatus ? { kind: "running", aptStatus } : { kind: "running" },
		handlers,
		deps,
	);
}

export async function runDetachedAptUpgrade(
	aptArgs: readonly string[],
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps = defaultDetachedAptServiceDeps(),
): Promise<number> {
	return launchDetachedAptUnit(
		(aptStatus) =>
			buildDetachedAptUpgradeCommand(aptArgs, deps.outputPaths, aptStatus),
		handlers,
		deps,
	);
}

export async function runDetachedAptAll(
	installArgs: readonly string[],
	verdict: "any" | "force_ipv4" | "force_ipv6",
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps = defaultDetachedAptServiceDeps(),
): Promise<number> {
	return launchDetachedAptUnit(
		(aptStatus) =>
			buildDetachedAptAllCommand(
				installArgs,
				verdict,
				deps.outputPaths,
				aptStatus,
			),
		handlers,
		deps,
	);
}

export async function recoverDetachedAptUpgrade(
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps = defaultDetachedAptServiceDeps(),
	options: ObserveOptions = {},
): Promise<RecoveredDetachedAptUpgrade | null> {
	const state = await deps.inspect();
	if (state.kind !== "running") {
		const recorded = await deps
			.readRecordedOutcome()
			.catch((error: unknown) => {
				reportObserverError(handlers, error);
				return null;
			});
		if (state.kind === "absent") {
			const now = deps.now?.() ?? Date.now();
			return recorded && now - recorded.at < RECORDED_OUTCOME_REPLAY_MS
				? { recorded, unit: "absent" }
				: null;
		}
		if (recorded) {
			if (options.retire !== false)
				await deps
					.cleanup(state)
					.catch((error: unknown) => reportObserverError(handlers, error));
			return {
				recorded: { ...recorded, exitCode: state.exitCode },
				unit: "finished",
			};
		}
	}
	handlers.onAttached?.(state.aptStatus === true);
	return {
		completion: observeDetachedAptUpgrade(state, handlers, deps, options),
		wasAlreadyFinished: state.kind === "finished",
	};
}
