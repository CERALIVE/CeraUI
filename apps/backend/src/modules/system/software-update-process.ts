/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import { randomUUID } from "node:crypto";
import {
	adoptUnit,
	bindAttemptInvocation,
	type ClaimedOutcome,
	claimOutcome,
	claimRetirement,
	currentAttempt,
	launchAttempt,
	recordAttemptExit,
} from "./software-update-attempt.ts";
import {
	buildDetachedAptAllCommand,
	buildDetachedAptUpgradeCommand,
	type DetachedAptServiceDeps,
	type DetachedAptServiceState,
	defaultDetachedAptServiceDeps,
	type SoftwareUpdateOutputPaths,
} from "./software-update-service.ts";

export {
	RECORDED_OUTCOME_REPLAY_MS,
	softwareUpdateUptimeMs,
} from "./software-update-attempt.ts";
export type { SoftwareUpdateOutputPaths } from "./software-update-service.ts";
export { buildDetachedAptUpgradeCommand } from "./software-update-service.ts";

const OUTPUT_POLL_INTERVAL_MS = 250;
const FINAL_DRAIN_MAX_FAILURES = 20;
const RETIRE_ATTEMPTS = 5;
const RECORD_ATTEMPTS = 5;
// 16 MiB per file per poll; a backlog beyond that is caught up on later polls.
const MAX_READS_PER_DRAIN = 256;
const INSPECT_RETRY_MAX_MS = 30_000;
// An older release's unit adopted while its plan has no attempt of this one.
const ADOPTED_UNIT_SETTLES_PLAN = true;

export type SoftwareUpdateOutputHandlers = {
	readonly onStdout: (chunk: string) => void;
	readonly onStderr: (chunk: string) => void;
	/**
	 * Runs after every poll's reads and once after the final drain.
	 * `caughtUp`: every file was read to its end without an error;
	 * `failed`: a file could not be read at all.
	 */
	readonly onDrained?: (caughtUp: boolean, failed: boolean) => void;
	readonly onAttached?: () => void;
	/** A unit no record named became `attempt`; `plan`: bound once to the saved plan. */
	readonly onAdopted?: (attempt: string, plan: boolean) => void;
	/** After the exit: the claim that alone may authorize the attempt's own effects. */
	readonly onOutcome?: (claim: () => Promise<ClaimedOutcome | null>) => void;
	/** What retiring the finished unit came to; settles later while ownership is pending. */
	readonly onRetirement?: (outcome: Promise<RetirementOutcome>) => void;
	readonly onObserverError?: (
		error: unknown,
		suppressedRetries?: number,
	) => void;
};

export type DetachedAptUpgradeDeps = DetachedAptServiceDeps;

/** `kept`: not this observer's to retire (no claim: unrecorded or unread; not owned; or it failed). */
export type RetirementOutcome = "retired" | "absent" | "replaced" | "kept";

export type RecoveredDetachedAptUpgrade =
	| AttachedDetachedAptUpgrade
	| {
			/**
			 * The current attempt's exit, which an earlier lifetime recorded: the
			 * unit is gone, or it is a finished unit never adopted again.
			 */
			readonly recorded: ClaimedOutcome;
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
};

/** The observed unit is gone before it finished: its outcome is unknown. */
export class DetachedAptServiceVanishedError extends Error {
	constructor() {
		super("software-update transient service vanished after launch");
		this.name = "DetachedAptServiceVanishedError";
	}
}

/** systemd now shows another invocation of the fixed unit than the one observed. */
export class DetachedAptServiceReplacedError extends Error {
	constructor() {
		super("the software-update unit is no longer the invocation observed");
		this.name = "DetachedAptServiceReplacedError";
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
	for (const start of cursors) {
		let cursor = start;
		for (let reads = 0; ; reads++) {
			if (reads === MAX_READS_PER_DRAIN) {
				caughtUp = false;
				break;
			}
			try {
				const next = await drainOutputCursor(cursor, readOutput);
				cursor = next.cursor;
				if (next.atEnd) break;
			} catch (error) {
				reportObserverError(handlers, error);
				caughtUp = false;
				failed = true;
				break;
			}
		}
		drained.push(cursor);
	}
	return { cursors: drained, caughtUp, failed };
}

function createOutputCursors(
	paths: SoftwareUpdateOutputPaths,
	handlers: SoftwareUpdateOutputHandlers,
): readonly OutputCursor[] {
	const cursor = (
		path: string,
		emit: (chunk: string) => void,
	): OutputCursor => ({ path, offset: 0, decoder: new TextDecoder(), emit });
	return [
		cursor(paths.stdout, handlers.onStdout),
		cursor(paths.stderr, handlers.onStderr),
	];
}

type FinishedState = Extract<
	DetachedAptServiceState,
	{ readonly kind: "finished" }
>;

/**
 * Retires `state` only while systemd, asked again right before every stop,
 * still shows that same finished invocation, and only while the record, read
 * in the same step, holds that invocation's exit with its transcript read
 * (`claimRetirement`): an unread transcript keeps the unit as the evidence.
 * A gone unit is done, a replaced one is left alone. `once`: one try.
 */
async function retireDetachedAptUnit(
	state: FinishedState,
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps,
	{ once = false }: { readonly once?: boolean } = {},
): Promise<RetirementOutcome> {
	for (let attempt = 1; ; attempt++) {
		const last = once || attempt === RETIRE_ATTEMPTS;
		try {
			const current = await deps.inspect();
			if (current.kind === "absent") return "absent";
			if (
				current.kind !== "finished" ||
				current.invocation !== state.invocation
			) {
				reportObserverError(handlers, new DetachedAptServiceReplacedError());
				return "replaced";
			}
			if (!claimRetirement(deps, current.invocation)) return "kept";
			await deps.cleanup(current);
			return "retired";
		} catch (error) {
			if (last) throw new DetachedAptServiceCleanupError(state.exitCode, error);
			reportObserverError(handlers, error);
			await deps.sleep(OUTPUT_POLL_INTERVAL_MS);
		}
	}
}

/** The first invocation seen is this attempt's, and is recorded; another one is a replaced unit. */
function bindInvocation(
	state: Exclude<DetachedAptServiceState, { readonly kind: "absent" }>,
	bound: string | undefined,
	attempt: string,
	deps: DetachedAptUpgradeDeps,
	handlers: SoftwareUpdateOutputHandlers,
): string | undefined {
	const invocation = state.invocation;
	if (invocation === undefined) return bound;
	if (bound !== undefined) {
		if (invocation !== bound) throw new DetachedAptServiceReplacedError();
		return bound;
	}
	try {
		// Display continues either way; only the exit write grants authority.
		bindAttemptInvocation(deps, attempt, invocation);
	} catch (error) {
		reportObserverError(handlers, error);
	}
	return invocation;
}

export type ObserveOptions = {
	/**
	 * Who may retire the finished unit: this observer (true, the default),
	 * nobody (false), or this observer once startup grants it ownership.
	 */
	readonly retire?: boolean | Promise<boolean>;
};

/** Runs `retire` now, once ownership is granted, or never; a later failure is reported. */
function whenOwned(
	retire: ObserveOptions["retire"],
	handlers: SoftwareUpdateOutputHandlers,
	run: () => Promise<RetirementOutcome>,
): Promise<RetirementOutcome> {
	if (retire === undefined || retire === true) return run();
	if (retire === false) return Promise.resolve("kept");
	return retire
		.then((owned) => (owned ? run() : "kept"))
		.catch((error: unknown): RetirementOutcome => {
			reportObserverError(handlers, error);
			return "kept";
		});
}

async function observeDetachedAptUpgrade(
	initialState: Exclude<DetachedAptServiceState, { readonly kind: "absent" }>,
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps,
	attempt: string,
	options: ObserveOptions = {},
): Promise<number> {
	let state: DetachedAptServiceState = initialState;
	let cursors = createOutputCursors(deps.outputPaths, handlers);
	let inspectRetryMs = 1_000;
	let lastInspectReportAt = -Infinity;
	let suppressedInspectErrors = 0;
	let invocation = bindInvocation(
		initialState,
		undefined,
		attempt,
		deps,
		handlers,
	);

	while (state.kind === "running") {
		const drained = await drainAvailableOutput(
			cursors,
			handlers,
			deps.readOutput,
		);
		cursors = drained.cursors;
		handlers.onDrained?.(drained.caughtUp, drained.failed);
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
		invocation = bindInvocation(state, invocation, attempt, deps, handlers);
	}
	if (state.kind !== "finished") throw new DetachedAptServiceVanishedError();
	const finished = state;
	bindInvocation(finished, invocation, attempt, deps, handlers);

	// APT (the files' only writer besides dpkg under it) has exited, so a read
	// to the end is complete; one that keeps failing ends after a bounded
	// number of tries, and the record says so (`drained: false`).
	let finalDrainFailures = 0;
	let caughtUp = false;
	let drainedAll = true;
	for (;;) {
		const drained = await drainAvailableOutput(
			cursors,
			handlers,
			deps.readOutput,
		);
		cursors = drained.cursors;
		caughtUp = drained.caughtUp;
		if (caughtUp) break;
		if (drained.failed && ++finalDrainFailures >= FINAL_DRAIN_MAX_FAILURES) {
			drainedAll = false;
			break;
		}
		await deps.sleep(OUTPUT_POLL_INTERVAL_MS);
	}
	for (const cursor of cursors) {
		const tail = cursor.decoder.decode();
		if (tail.length > 0) cursor.emit(tail);
	}
	handlers.onDrained?.(caughtUp, !drainedAll);
	const transcript = await deps.transcript?.().catch(() => undefined);
	// Only a durable record of the exit can be claimed. Each try compares
	// again in the same step as its write, so a newer attempt's record is
	// never overwritten, even after a retry wait.
	let recorded = false;
	let superseded = false;
	for (
		let tries = 1;
		tries <= RECORD_ATTEMPTS && !recorded && !superseded;
		tries++
	) {
		try {
			const written = recordAttemptExit(deps, attempt, {
				...(finished.invocation ? { invocation: finished.invocation } : {}),
				exitCode: finished.exitCode,
				drained: drainedAll,
				...(transcript ? { transcript } : {}),
			});
			recorded = written === "recorded";
			superseded = written === "superseded";
		} catch (error) {
			reportObserverError(handlers, error);
			if (tries < RECORD_ATTEMPTS) await deps.sleep(OUTPUT_POLL_INTERVAL_MS);
		}
	}
	// A newer attempt owns the record: this exit is not that attempt's
	// outcome, and nothing of the unit is this observer's to touch.
	if (superseded) throw new DetachedAptServiceReplacedError();
	handlers.onOutcome?.(() =>
		claimOutcome(deps, attempt, { invocation: finished.invocation }),
	);
	// Unrecorded, or with an unread transcript, the unit stays as the evidence.
	const retirement = recorded
		? whenOwned(options.retire, handlers, () =>
				retireDetachedAptUnit(finished, handlers, deps),
			)
		: Promise.resolve<RetirementOutcome>("kept");
	handlers.onRetirement?.(retirement);
	// Owned now: retired before the exit is returned. Owned later: meanwhile.
	if (!(options.retire instanceof Promise)) await retirement;
	return finished.exitCode;
}

async function launchDetachedAptUnit(
	command: () => readonly string[],
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps,
): Promise<number> {
	const existing = await deps.inspect();
	if (existing.kind === "running")
		throw new DetachedAptServiceAlreadyExistsError();
	if (existing.kind === "finished") {
		// Only a finished unit whose exit is recorded and read (`claimRetirement`).
		await retireDetachedAptUnit(existing, handlers, deps).catch(() => {
			throw new DetachedAptServiceAlreadyExistsError();
		});
		if ((await deps.inspect()).kind !== "absent")
			throw new DetachedAptServiceAlreadyExistsError();
	}
	// Before the unit or its fresh output files exist, so a later lifetime
	// that finds either knows whose they are.
	const attempt = launchAttempt(deps);
	await deps.prepareOutput();
	await deps.start(command());
	return observeDetachedAptUpgrade(
		{ kind: "running" },
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
		() => buildDetachedAptUpgradeCommand(aptArgs, deps.outputPaths),
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
		() => buildDetachedAptAllCommand(installArgs, verdict, deps.outputPaths),
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
	const current = currentAttempt(deps);
	if (state.kind === "absent") {
		// Told only if, compared after the last await, it is still the current
		// attempt's fresh exit, read from the stdout file that is there now.
		const claim = current
			? await claimOutcome(deps, current.attempt, { fresh: true })
			: null;
		return claim ? { recorded: claim, unit: "absent" } : null;
	}
	if (state.kind === "finished") {
		const claim = current
			? await claimOutcome(deps, current.attempt, {
					invocation: state.invocation,
				})
			: null;
		const retireOnce = async () => {
			const retiring = whenOwned(options.retire, handlers, () =>
				retireDetachedAptUnit(state, handlers, deps, { once: true }).catch(
					(error: unknown): RetirementOutcome => {
						reportObserverError(handlers, error);
						return "kept";
					},
				),
			);
			if (!(options.retire instanceof Promise)) await retiring;
		};
		// Its recorded exit is told and the unit is never adopted again; it is
		// retired only once its transcript was read (otherwise it stays as the
		// evidence). An older attempt's read leftover is retired and tells nothing.
		if (claim) {
			if (claim.drained) await retireOnce();
			return { recorded: claim, unit: "finished" };
		}
		if (claimRetirement(deps, state.invocation)) {
			await retireOnce();
			return null;
		}
	}
	// This attempt's own launched unit keeps its id.
	let attempt =
		current?.launched &&
		!current.finished &&
		(current.invocation === undefined ||
			current.invocation === state.invocation)
			? current.attempt
			: undefined;
	if (attempt === undefined) {
		try {
			attempt =
				adoptUnit(deps, state.invocation, {
					plan: ADOPTED_UNIT_SETTLES_PLAN,
				}) ?? undefined;
			if (attempt !== undefined)
				handlers.onAdopted?.(attempt, ADOPTED_UNIT_SETTLES_PLAN);
		} catch (error) {
			reportObserverError(handlers, error);
		}
	}
	// Watched for display only: no record names it, so its exit is nobody's.
	attempt ??= randomUUID();
	handlers.onAttached?.();
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
