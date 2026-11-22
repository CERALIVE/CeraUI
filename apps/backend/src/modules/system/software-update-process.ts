/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import { logger } from "../../helpers/logger.ts";
import {
	adoptUnit,
	bindAttemptInvocation,
	type ClaimedOutcome,
	claimOutcome,
	currentAttempt,
	launchAttempt,
	RECORDED_OUTCOME_REPLAY_MS,
	recordAttemptExit,
	softwarePlanKey,
	softwareUpdateUptimeMs,
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
	/** A unit no record named became `attempt`; `planned`: bound once to the saved plan. */
	readonly onAdopted?: (attempt: string, planned: boolean) => void;
	/**
	 * After the exit: the claim taken before the unit was retired, the only
	 * authority for the attempt's own effects; each later use confirms it
	 * against the record (`confirm()`) rather than claiming again.
	 */
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
	  }
	/** A unit is there whose outcome this backend may not tell and must not watch. */
	| { readonly unknown: true };

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

/** Watched for display only: no record names this unit, so its exit is nobody's. */
export class DetachedAptServiceUnownedError extends Error {
	constructor() {
		super("the observed software-update unit belongs to no current attempt");
		this.name = "DetachedAptServiceUnownedError";
	}
}

/** The exit could not be recorded and claimed: it is no outcome, and the unit stays. */
export class DetachedAptServiceUnrecordedError extends Error {
	constructor() {
		super("the software-update exit could not be recorded and claimed");
		this.name = "DetachedAptServiceUnrecordedError";
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

// The single starter: CeraUI alone starts or retires the update unit, under
// its one fixed name, and every systemd probe that decides a start or a
// retirement runs under this lock together with that action. No start,
// retirement, recovery or claim can come between a probe and its action, so
// the probe is never stale.
let unitLock: Promise<unknown> = Promise.resolve();
function underUnitLock<T>(run: () => Promise<T>): Promise<T> {
	const next = unitLock.then(run, run);
	unitLock = next.catch(() => undefined);
	return next;
}

// A finished unit this process left in place (its outcome unclaimed or unread,
// or its retirement failed), since when (uptime ms). No start is admitted
// until it is settled; `settleKeptSoftwareUpdateUnit` does that first.
let kept: { readonly since: number } | undefined;
function keep(deps: DetachedAptUpgradeDeps): void {
	kept ??= { since: softwareUpdateUptimeMs(deps) };
}

/** Whether a finished unit is still in place: a start must settle it first. */
export function softwareUpdateUnitKept(): boolean {
	return kept !== undefined;
}

export function resetSoftwareUpdateUnitForTest(): void {
	kept = undefined;
	interruptedForStream = undefined;
	unitLock = Promise.resolve();
}

/**
 * Called with the lock held. Retires the finished unit only while systemd,
 * asked again right before every stop, still shows that same finished
 * invocation and exit, and only once `attempt`'s outcome is claimed for it
 * with its transcript read: an unclaimed or unread outcome keeps the unit as
 * the evidence. A gone unit is done, another invocation is left alone.
 * `once`: one try.
 */
async function retireClaimed(
	finished: FinishedState,
	attempt: string,
	report: (error: unknown) => void,
	deps: DetachedAptUpgradeDeps,
	{ once = false }: { readonly once?: boolean } = {},
): Promise<RetirementOutcome> {
	for (let tries = 1; ; tries++) {
		const last = once || tries === RETIRE_ATTEMPTS;
		try {
			const current = await deps.inspect();
			if (current.kind === "absent") {
				kept = undefined;
				return "absent";
			}
			if (
				current.kind !== "finished" ||
				current.invocation !== finished.invocation
			) {
				keep(deps);
				report(new DetachedAptServiceReplacedError());
				return "replaced";
			}
			const claim = await claimOutcome(deps, attempt, { unit: current });
			if (!claim?.drained) {
				keep(deps);
				return "kept";
			}
			await deps.cleanup(current);
			kept = undefined;
			return "retired";
		} catch (error) {
			if (last) {
				keep(deps);
				throw new DetachedAptServiceCleanupError(finished.exitCode, error);
			}
			report(error);
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
	/** The saved plan's key now: an adopted unit is bound to it, once. */
	readonly plan?: () => string | undefined;
};

/**
 * Retires now (the caller holds the lock), under the lock once ownership is
 * granted, or never; until then the unit is kept. A later failure is reported.
 */
function whenOwned(
	retire: ObserveOptions["retire"],
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps,
	run: () => Promise<RetirementOutcome>,
): Promise<RetirementOutcome> {
	if (retire === undefined || retire === true) return run();
	keep(deps);
	if (retire === false) return Promise.resolve("kept");
	return retire
		.then((owned) => (owned ? underUnitLock(run) : "kept"))
		.catch((error: unknown): RetirementOutcome => {
			reportObserverError(handlers, error);
			return "kept";
		});
}

/**
 * `attempt`: the record's attempt this unit is. Without one the unit is
 * watched for display only: nothing of it is recorded, claimed or retired.
 */
async function observeDetachedAptUpgrade(
	initialState: Exclude<DetachedAptServiceState, { readonly kind: "absent" }>,
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps,
	attempt: string | undefined,
	options: ObserveOptions = {},
): Promise<number> {
	let state: DetachedAptServiceState = initialState;
	let cursors = createOutputCursors(deps.outputPaths, handlers);
	let inspectRetryMs = 1_000;
	let lastInspectReportAt = -Infinity;
	let suppressedInspectErrors = 0;
	const bind = (seen: typeof initialState, bound: string | undefined) =>
		attempt === undefined
			? (seen.invocation ?? bound)
			: bindInvocation(seen, bound, attempt, deps, handlers);
	let invocation = bind(initialState, undefined);

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
		try {
			invocation = bind(state, invocation);
		} catch (error) {
			// Another invocation under the one name: not this observer's to touch.
			keep(deps);
			throw error;
		}
	}
	if (state.kind !== "finished") throw new DetachedAptServiceVanishedError();
	const finished = state;
	bind(finished, invocation);

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
	if (attempt === undefined) {
		keep(deps);
		throw new DetachedAptServiceUnownedError();
	}
	const own = attempt;
	// Recorded, claimed and only then retired, under the lock: no start,
	// recovery or other retirement can come between. Only a durable record of
	// the exit can be claimed, and each write compares again in the same step,
	// so a newer attempt's record is never overwritten, even after a retry wait.
	const settle = async (): Promise<RetirementOutcome> => {
		const transcript = await deps.transcript?.().catch(() => undefined);
		let recorded = false;
		let superseded = false;
		for (
			let tries = 1;
			tries <= RECORD_ATTEMPTS && !recorded && !superseded;
			tries++
		) {
			try {
				const written = recordAttemptExit(deps, own, {
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
		if (superseded) {
			keep(deps);
			throw new DetachedAptServiceReplacedError();
		}
		// Claimed before anything else: an exit nothing can claim is no
		// outcome, and its unit stays as the only evidence.
		const claim = recorded
			? await claimOutcome(deps, own, { unit: finished })
			: null;
		if (!claim) {
			keep(deps);
			throw new DetachedAptServiceUnrecordedError();
		}
		handlers.onOutcome?.(async () => (claim.confirm() ? claim : null));
		// With an unread transcript the unit stays as the evidence.
		const retirement = whenOwned(options.retire, handlers, deps, () =>
			retireClaimed(
				finished,
				own,
				(error) => reportObserverError(handlers, error),
				deps,
			),
		);
		handlers.onRetirement?.(retirement);
		return options.retire instanceof Promise ? "kept" : retirement;
	};
	await underUnitLock(settle);
	return finished.exitCode;
}

/**
 * Before a start is admitted: a finished unit this process left in place is
 * settled under the lock. Its outcome is claimed by the record's attempt and
 * only then is the unit retired; one that no attempt can claim, or whose
 * transcript was never read, is retired only once it has stayed for the replay
 * window, with the reason logged. True once no unit is in place.
 */
export function settleKeptSoftwareUpdateUnit(
	deps: DetachedAptUpgradeDeps = defaultDetachedAptServiceDeps(),
): Promise<boolean> {
	if (!kept) return Promise.resolve(true);
	return underUnitLock(async () => {
		const left = kept;
		if (!left) return true;
		const report = (error: unknown) =>
			logger.warn("Software update: settling the finished unit failed", {
				error,
			});
		try {
			const state = await deps.inspect();
			if (state.kind === "absent") {
				kept = undefined;
				return true;
			}
			if (state.kind === "running") return false;
			const current = currentAttempt(deps);
			const outcome = current
				? await retireClaimed(state, current.attempt, report, deps, {
						once: true,
					})
				: "kept";
			if (outcome === "retired" || outcome === "absent") return true;
			const stayedMs = softwareUpdateUptimeMs(deps) - left.since;
			if (outcome === "replaced" || stayedMs < RECORDED_OUTCOME_REPLAY_MS)
				return false;
			// Asked again right before the stop, as every retirement is.
			const now = await deps.inspect();
			if (now.kind !== "finished" || now.invocation !== state.invocation)
				return false;
			logger.warn(
				"Software update: abandoning a finished update unit whose outcome was never confirmed",
				{
					invocation: now.invocation,
					exit_code: now.exitCode,
					stayed_ms: stayedMs,
					reason: current
						? "outcome unclaimed or unread"
						: "no readable attempt record",
				},
			);
			await deps.cleanup(now);
			kept = undefined;
			return true;
		} catch (error) {
			report(error);
			return false;
		}
	});
}

// The invocation D8 signalled for a stream start: its exit is an interruption.
let interruptedForStream: string | undefined;

/** Whether this exit is of a run D8 interrupted for a stream start. */
export function interruptedForStreamStart(invocation: string): boolean {
	return interruptedForStream === invocation;
}

export type StreamStopDisposition =
	| "stopped"
	| "absent"
	| "finished"
	| "commit-stage"
	| "unknown";

/**
 * Go Live's stop, under the same lock as every start and retirement: only a
 * running unit is signalled, and only while the commit-stage probe, run in
 * this same step, still says it is downloading. It is signalled, never
 * stopped: systemd keeps the unit and its exit, so the observer records,
 * claims and retires it like every other exit. A unit that finished meanwhile
 * is left to that claim; a probe that fails is `unknown` and signals nothing.
 */
export function stopSoftwareUpdateUnitForStream(
	port: {
		readonly commitStage: () => Promise<boolean>;
		readonly signal: () => Promise<void>;
	},
	deps: DetachedAptUpgradeDeps = defaultDetachedAptServiceDeps(),
): Promise<StreamStopDisposition> {
	return underUnitLock(async (): Promise<StreamStopDisposition> => {
		try {
			const state = await deps.inspect();
			if (state.kind !== "running") return state.kind;
			if (await port.commitStage()) return "commit-stage";
			interruptedForStream = state.invocation;
			await port.signal();
			return "stopped";
		} catch (error) {
			logger.warn("Software update: the Go Live stop could not decide", {
				error,
			});
			return "unknown";
		}
	});
}

async function launchDetachedAptUnit(
	command: readonly string[],
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps,
	admitted?: string,
): Promise<number> {
	const attempt = await underUnitLock(async () => {
		// Only into an empty slot: a finished unit is settled (claimed, then
		// retired) before a start is admitted, never by the start itself.
		const existing = await deps.inspect();
		if (existing.kind !== "absent") {
			if (existing.kind === "finished") keep(deps);
			throw new DetachedAptServiceAlreadyExistsError();
		}
		// Before the unit or its fresh output files exist, so a later lifetime
		// that finds either knows whose they are.
		const launched = launchAttempt(deps, admitted);
		await deps.prepareOutput();
		await deps.start(command);
		return launched;
	});
	return observeDetachedAptUpgrade(
		{ kind: "running" },
		handlers,
		deps,
		attempt,
	);
}

/** `admitted`: the caller's admitted attempt; the launch is refused once it is not current. */
export async function runDetachedAptUpgrade(
	aptArgs: readonly string[],
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps = defaultDetachedAptServiceDeps(),
	admitted?: string,
): Promise<number> {
	return launchDetachedAptUnit(
		buildDetachedAptUpgradeCommand(aptArgs, deps.outputPaths),
		handlers,
		deps,
		admitted,
	);
}

export async function runDetachedAptAll(
	installArgs: readonly string[],
	verdict: "any" | "force_ipv4" | "force_ipv6",
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps = defaultDetachedAptServiceDeps(),
	admitted?: string,
): Promise<number> {
	return launchDetachedAptUnit(
		buildDetachedAptAllCommand(installArgs, verdict, deps.outputPaths),
		handlers,
		deps,
		admitted,
	);
}

/**
 * Under the lock, before any start is admitted. Running: observed. Finished:
 * the current attempt's recorded exit, claimed for this very invocation and
 * exit, is told and the unit never adopted again; it is retired only after
 * that claim. Finished with no recorded exit: observed, recorded and claimed.
 * Gone: only the current attempt's own fresh exit is told. A unit no record
 * names (an older release's) is adopted once, bound to its invocation.
 */
export function recoverDetachedAptUpgrade(
	handlers: SoftwareUpdateOutputHandlers,
	deps: DetachedAptUpgradeDeps = defaultDetachedAptServiceDeps(),
	options: ObserveOptions = {},
): Promise<RecoveredDetachedAptUpgrade | null> {
	return underUnitLock(async () => {
		const current = currentAttempt(deps);
		const state = await deps.inspect();
		if (state.kind === "absent") {
			kept = undefined;
			// Told only if, compared after the last await, it is still the current
			// attempt's fresh exit, read from the stdout file that is there now.
			const claim = current
				? await claimOutcome(deps, current.attempt, { fresh: true })
				: null;
			return claim ? { recorded: claim, unit: "absent" } : null;
		}
		if (state.kind === "finished") {
			keep(deps);
			const told = current
				? await claimOutcome(deps, current.attempt, { unit: state })
				: null;
			if (told) {
				// Its recorded exit is told and the unit is never adopted again;
				// retired once, now or once ownership is granted, after the claim.
				const retiring = whenOwned(options.retire, handlers, deps, () =>
					retireClaimed(
						state,
						told.attempt,
						(error) => reportObserverError(handlers, error),
						deps,
						{ once: true },
					).catch((error: unknown): RetirementOutcome => {
						reportObserverError(handlers, error);
						return "kept";
					}),
				);
				const retired =
					options.retire instanceof Promise ? "kept" : await retiring;
				if (retired === "replaced") return { unknown: true };
				// The claim taken before the retirement is the outcome, confirmed
				// against the record now, after the last await.
				return told.confirm()
					? { recorded: told, unit: "finished" }
					: { unknown: true };
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
				// Bound once, now, to its invocation, and to the saved plan only when
				// the unit installs exactly that plan's packages: its ExecStart is
				// the proof of what it was started for.
				const saved = options.plan?.();
				const plan =
					saved !== undefined && saved === softwarePlanKey(state.packages ?? [])
						? saved
						: undefined;
				attempt = adoptUnit(deps, state.invocation, { plan }) ?? undefined;
				if (attempt !== undefined)
					handlers.onAdopted?.(attempt, plan !== undefined);
			} catch (error) {
				reportObserverError(handlers, error);
			}
		}
		// Without an attempt it is watched for display only: its exit is nobody's.
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
	});
}
