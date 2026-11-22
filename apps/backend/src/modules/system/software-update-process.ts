/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import { randomUUID } from "node:crypto";
import { uptime } from "node:os";
import type { SoftwareUpdateAttempt } from "./software-update-output.ts";
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
const RECORD_ATTEMPTS = 5;
// 16 MiB per file per poll; a backlog beyond that is caught up on later polls.
const MAX_READS_PER_DRAIN = 256;
const INSPECT_RETRY_MAX_MS = 30_000;
/** How long a gone unit's recorded exit is told to reconnecting tabs. */
export const RECORDED_OUTCOME_REPLAY_MS = 30 * 60_000;

/** Boot-relative, so a wall-clock correction never makes a record look fresh or stale. */
export function softwareUpdateUptimeMs(
	deps: Pick<DetachedAptServiceDeps, "uptimeMs">,
): number {
	return deps.uptimeMs?.() ?? Math.round(uptime() * 1000);
}

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
	/** After the exit: whether it is durably in the attempt record. */
	readonly onOutcomeRecorded?: (recorded: boolean) => void;
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
			 * The current attempt's exit, which an earlier lifetime recorded: the
			 * unit is gone, or it is a finished unit never adopted again.
			 */
			readonly recorded: { readonly exitCode: number };
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

/** The exit is recorded; only retiring the finished unit failed. */
export class DetachedAptServiceCleanupError extends Error {
	constructor(
		readonly transactionExitCode: number,
		readonly cleanupError: unknown,
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

function readAttempt(
	deps: DetachedAptUpgradeDeps,
	handlers: SoftwareUpdateOutputHandlers,
): SoftwareUpdateAttempt | null {
	try {
		return deps.readAttempt();
	} catch (error) {
		reportObserverError(handlers, error);
		return null;
	}
}

async function drainOutputCursor(
	cursor: OutputCursor,
	read: DetachedAptUpgradeDeps["readOutput"],
): Promise<{ readonly cursor: OutputCursor; readonly atEnd: boolean }> {
	const next = await read(cursor.path, cursor.offset);
	let { bytes, nextOffset } = next;
	// The status file is a zero-filled reservation: APT's records end at the first NUL.
	const reserved = cursor.optional ? bytes.indexOf(0) : -1;
	if (reserved >= 0) {
		bytes = bytes.subarray(0, reserved);
		nextOffset = cursor.offset + reserved;
	}
	if (bytes.byteLength > 0) {
		const text = cursor.decoder.decode(bytes, { stream: true });
		if (text.length > 0) cursor.emit(text);
	}
	// One read is bounded; only an empty read (or the reservation) proves the end.
	return {
		cursor: { ...cursor, offset: nextOffset },
		atEnd: reserved >= 0 || bytes.byteLength === 0,
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

/** Whether `record` holds this finished unit's own exit, or keeps it as a leftover. */
function recordsExit(
	record: SoftwareUpdateAttempt | null,
	unit: FinishedState,
	leftover = false,
): boolean {
	const exit = leftover
		? record?.leftover
		: record?.phase === "launched"
			? record
			: undefined;
	return (
		exit?.exitCode === unit.exitCode && exit?.invocation === unit.invocation
	);
}

async function retireDetachedAptUnit(
	state: FinishedState,
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps,
): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await deps.cleanup(state);
			return;
		} catch (error) {
			if (attempt === RETIRE_ATTEMPTS)
				throw new DetachedAptServiceCleanupError(state.exitCode, error);
			reportObserverError(handlers, error);
			await deps.sleep(OUTPUT_POLL_INTERVAL_MS);
		}
	}
}

export type ObserveOptions = {
	/**
	 * Who may retire the finished unit: this observer (true, the default),
	 * nobody (false), or this observer once startup grants it ownership.
	 */
	readonly retire?: boolean | Promise<boolean>;
};

/** Runs `retire` now, once ownership is granted, or never; a deferred failure is reported. */
async function whenOwned(
	retire: ObserveOptions["retire"],
	handlers: SoftwareUpdateOutputHandlers,
	run: () => Promise<void>,
): Promise<void> {
	if (retire === undefined || retire === true) return run();
	if (retire === false) return;
	void retire
		.then((owned) => (owned ? run() : undefined))
		.catch((error: unknown) => reportObserverError(handlers, error));
}

async function observeDetachedAptUpgrade(
	initialState: Exclude<DetachedAptServiceState, { readonly kind: "absent" }>,
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps,
	attempt: string,
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
	const finished = state;

	let finalDrainFailures = 0;
	let caughtUp = false;
	let transcriptRead = true;
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
		if (drained.failed && ++finalDrainFailures >= FINAL_DRAIN_MAX_FAILURES) {
			transcriptRead = false;
			break;
		}
		await deps.sleep(OUTPUT_POLL_INTERVAL_MS);
	}
	for (const cursor of cursors) {
		const tail = cursor.decoder.decode();
		if (tail.length > 0) cursor.emit(tail);
	}
	handlers.onDrained?.(caughtUp);
	// APT has exited, so this read was complete. The exit is returned either
	// way; only a durable record of it lets the unit go or CeraUI restart.
	let recorded = false;
	for (let tries = 1; tries <= RECORD_ATTEMPTS && !recorded; tries++) {
		try {
			deps.writeAttempt({
				schema: 2,
				attempt,
				phase: "launched",
				uptimeMs: softwareUpdateUptimeMs(deps),
				...(finished.invocation ? { invocation: finished.invocation } : {}),
				exitCode: finished.exitCode,
			});
			recorded = true;
		} catch (error) {
			reportObserverError(handlers, error);
			if (tries < RECORD_ATTEMPTS) await deps.sleep(OUTPUT_POLL_INTERVAL_MS);
		}
	}
	handlers.onOutcomeRecorded?.(recorded);
	// Unrecorded, or with an unread transcript, the unit stays as the evidence.
	if (recorded && transcriptRead)
		await whenOwned(options.retire, handlers, () =>
			retireDetachedAptUnit(finished, handlers, deps),
		);
	return finished.exitCode;
}

async function launchDetachedAptUnit(
	command: (aptStatus: boolean) => readonly string[],
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps,
): Promise<number> {
	const existing = await deps.inspect();
	if (existing.kind === "running")
		throw new DetachedAptServiceAlreadyExistsError();
	const record = readAttempt(deps, handlers);
	if (existing.kind === "finished") {
		// Only a leftover whose exit is durably recorded; only its retirement failed.
		if (!recordsExit(record, existing) && !recordsExit(record, existing, true))
			throw new DetachedAptServiceAlreadyExistsError();
		await retireDetachedAptUnit(existing, handlers, deps).catch(() => {
			throw new DetachedAptServiceAlreadyExistsError();
		});
		if ((await deps.inspect()).kind !== "absent")
			throw new DetachedAptServiceAlreadyExistsError();
	}
	const aptStatus = (await deps.prepareOutput())?.status !== false;
	// The admitted attempt's id, or a new one for a caller that launches directly.
	const attempt = record?.phase === "accepted" ? record.attempt : randomUUID();
	// Before the unit exists, so a later lifetime that finds it knows whose it is.
	deps.writeAttempt({
		schema: 2,
		attempt,
		phase: "launched",
		uptimeMs: softwareUpdateUptimeMs(deps),
	});
	await deps.start(command(aptStatus));
	if (!aptStatus) handlers.onStatusLost?.();
	return observeDetachedAptUpgrade(
		aptStatus ? { kind: "running", aptStatus } : { kind: "running" },
		handlers,
		deps,
		attempt,
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

/**
 * Running: observed. Finished: its recorded exit is told and never adopted
 * again; otherwise observed and recorded. Gone: only the current attempt's
 * own fresh exit is told; an attempt with no recorded exit tells nothing.
 */
export async function recoverDetachedAptUpgrade(
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps = defaultDetachedAptServiceDeps(),
	options: ObserveOptions = {},
): Promise<RecoveredDetachedAptUpgrade | null> {
	const state = await deps.inspect();
	const record = readAttempt(deps, handlers);
	if (state.kind === "absent") {
		if (record?.phase !== "launched" || record.exitCode === undefined)
			return null;
		const age = softwareUpdateUptimeMs(deps) - record.uptimeMs;
		return age >= 0 && age < RECORDED_OUTCOME_REPLAY_MS
			? { recorded: { exitCode: record.exitCode }, unit: "absent" }
			: null;
	}
	if (state.kind === "finished") {
		const own = recordsExit(record, state);
		if (own || recordsExit(record, state, true)) {
			await whenOwned(options.retire, handlers, () =>
				deps
					.cleanup(state)
					.catch((error: unknown) => reportObserverError(handlers, error)),
			);
			// An older attempt's leftover tells the current attempt nothing.
			return own
				? { recorded: { exitCode: state.exitCode }, unit: "finished" }
				: null;
		}
	}
	// This attempt's own launched unit keeps its id; any other gets a new one.
	const attempt =
		record?.phase === "launched" && record.exitCode === undefined
			? record.attempt
			: randomUUID();
	handlers.onAttached?.(state.aptStatus === true);
	return {
		completion: observeDetachedAptUpgrade(
			state,
			handlers,
			deps,
			attempt,
			options,
		),
		wasAlreadyFinished: state.kind === "finished",
	};
}
