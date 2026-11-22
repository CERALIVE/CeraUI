/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * The one owner of the update attempt record. Nothing else reads or writes
 * it: admission, launch, invocation binding, the exit, and adoption are the
 * only writes, and a recorded exit is used only through `claimOutcome` (for
 * the attempt's own effects, and for the orchestrator's plan when the plan
 * admitted it) and `claimRetirement` (for retiring a finished unit). Each claim
 * compares everything in one synchronous step after its last await.
 */

import { createHash, randomUUID } from "node:crypto";
import { uptime } from "node:os";
import type { SoftwareUpdateAttempt } from "./software-update-output.ts";
import type { DetachedAptServiceDeps } from "./software-update-service.ts";
import {
	SOFTWARE_UPDATE_UNIT,
	softwareUpdateUnitFor,
} from "./software-update-service-contract.ts";

/** How long a gone unit's recorded exit is told to reconnecting tabs. */
export const RECORDED_OUTCOME_REPLAY_MS = 30 * 60_000;

export type AttemptDeps = Pick<
	DetachedAptServiceDeps,
	"readAttempt" | "updateAttempt" | "transcript" | "uptimeMs"
>;

/** Boot-relative, so a wall-clock correction never makes a record look fresh or stale. */
export function softwareUpdateUptimeMs(
	deps: Pick<DetachedAptServiceDeps, "uptimeMs">,
): number {
	return deps.uptimeMs?.() ?? Math.round(uptime() * 1000);
}

/** The attempt the record names now. Never its exit: only a claim reads that. */
export type CurrentAttempt = {
	readonly attempt: string;
	readonly launched: boolean;
	readonly finished: boolean;
	readonly invocation?: string;
};

/** A recorded exit, claimed by the attempt it belongs to. */
export type ClaimedOutcome = {
	readonly attempt: string;
	readonly invocation: string;
	readonly exitCode: number;
	/** The unit's transcript was read to its end. */
	readonly drained: boolean;
	/** The key of the orchestrator's saved plan that admitted it. */
	readonly plan?: string;
	/**
	 * At the point of use: the record, read again in the same synchronous
	 * step, still holds exactly this claim. Anything else means unknown.
	 */
	readonly confirm: () => boolean;
};

/** The saved plan's identity: its exact package list, as every release writes it. */
export function softwarePlanKey(
	packages: readonly {
		readonly name: string;
		readonly version?: string | undefined;
	}[],
): string | undefined {
	if (packages.length === 0) return undefined;
	const canonical = packages
		.map(({ name, version }) => `${name}=${version ?? ""}`)
		.sort()
		.join("\n");
	return createHash("sha256").update(canonical).digest("hex");
}

/** The units the record names: this attempt's (once launched) and the earlier attempt's. */
export function recordedUnits(deps: AttemptDeps): {
	readonly own?: string;
	readonly leftover?: string;
} {
	const record = readRecord(deps);
	return {
		...(record?.phase === "launched"
			? { own: softwareUpdateUnitFor(record.attempt) }
			: {}),
		...(record?.leftover
			? { leftover: softwareUpdateUnitFor(record.leftover.attempt) }
			: {}),
	};
}

/** The unit an in-flight update runs in: this attempt's, else an older release's fixed one. */
export function inFlightUnit(deps: AttemptDeps): string {
	const record = readRecord(deps);
	return record?.phase === "launched" && record.exitCode === undefined
		? softwareUpdateUnitFor(record.attempt)
		: SOFTWARE_UPDATE_UNIT;
}

function readRecord(deps: AttemptDeps): SoftwareUpdateAttempt | null {
	try {
		return deps.readAttempt();
	} catch {
		return null;
	}
}

/** null: no record, or one that cannot be read (which grants nothing). */
export function currentAttempt(deps: AttemptDeps): CurrentAttempt | null {
	const record = readRecord(deps);
	return (
		record && {
			attempt: record.attempt,
			launched: record.phase === "launched",
			finished: record.exitCode !== undefined,
			...(record.invocation ? { invocation: record.invocation } : {}),
		}
	);
}

/**
 * A new attempt, written before anything is published or started. An older
 * attempt's recorded exit stays only as a `leftover` a launch may retire.
 * Throws when it cannot be written; an unreadable record is replaced.
 */
export function admitAttempt(
	deps: AttemptDeps,
	{ plan }: { readonly plan?: string | undefined },
): string {
	const attempt = randomUUID();
	deps.updateAttempt(
		(previous) => {
			const leftover =
				previous?.exitCode !== undefined && previous.invocation !== undefined
					? {
							attempt: previous.attempt,
							invocation: previous.invocation,
							exitCode: previous.exitCode,
							drained: previous.drained === true,
						}
					: previous?.leftover;
			return {
				schema: 2,
				attempt,
				phase: "accepted",
				uptimeMs: softwareUpdateUptimeMs(deps),
				...(plan ? { plan } : {}),
				...(leftover ? { leftover } : {}),
			};
		},
		{ replaceUnreadable: true },
	);
	return attempt;
}

/** This launch is not the admitted attempt's: another admission replaced it. */
export class SoftwareUpdateAttemptSupersededError extends Error {
	constructor() {
		super("the admitted software-update attempt is no longer the current one");
		this.name = "SoftwareUpdateAttemptSupersededError";
	}
}

/**
 * Before the unit or its output files exist. `admitted`: the caller's own
 * attempt, which must still be the accepted one (its id and plan are kept);
 * otherwise nothing is written and the launch is refused. Without it (a unit
 * started outside admission, as tests do) a new id is used.
 */
export function launchAttempt(deps: AttemptDeps, admitted?: string): string {
	const launched = deps.updateAttempt((current) =>
		admitted !== undefined &&
		!(current?.phase === "accepted" && current.attempt === admitted)
			? null
			: {
					schema: 2,
					attempt:
						admitted ??
						(current?.phase === "accepted" ? current.attempt : randomUUID()),
					phase: "launched",
					uptimeMs: softwareUpdateUptimeMs(deps),
					...(current?.phase === "accepted" && current.plan
						? { plan: current.plan }
						: {}),
					...(current?.leftover ? { leftover: current.leftover } : {}),
				},
	);
	if (admitted !== undefined && launched?.attempt !== admitted)
		throw new SoftwareUpdateAttemptSupersededError();
	// A test unit that keeps no record still needs an id to observe under.
	return launched?.attempt ?? randomUUID();
}

/** The first invocation systemd shows is this launched attempt's identity. */
export function bindAttemptInvocation(
	deps: AttemptDeps,
	attempt: string,
	invocation: string,
): void {
	deps.updateAttempt((current) =>
		current?.attempt === attempt &&
		current.phase === "launched" &&
		current.exitCode === undefined &&
		current.invocation === undefined
			? { ...current, invocation }
			: null,
	);
}

/**
 * Writes the exit only into this attempt's own launched record, from its
 * bound invocation (or none yet), with no exit or this same exit (a later
 * read of a transcript that was not read); or when no record exists.
 * `superseded`: another attempt owns the record. Throws on a write error.
 */
export function recordAttemptExit(
	deps: AttemptDeps,
	attempt: string,
	exit: {
		readonly invocation?: string;
		readonly exitCode: number;
		readonly drained: boolean;
		readonly transcript?: string;
	},
): "recorded" | "superseded" {
	let outcome: "recorded" | "superseded" = "superseded";
	deps.updateAttempt((current) => {
		const own =
			current === null ||
			(current.attempt === attempt &&
				current.phase === "launched" &&
				(current.invocation === undefined ||
					current.invocation === exit.invocation) &&
				(current.exitCode === undefined || current.exitCode === exit.exitCode));
		if (!own) return null;
		outcome = "recorded";
		return {
			schema: 2,
			attempt,
			phase: "launched",
			uptimeMs: softwareUpdateUptimeMs(deps),
			...(current?.plan ? { plan: current.plan } : {}),
			...(current?.leftover ? { leftover: current.leftover } : {}),
			...(exit.invocation ? { invocation: exit.invocation } : {}),
			exitCode: exit.exitCode,
			drained: exit.drained,
			...(exit.transcript ? { transcript: exit.transcript } : {}),
		};
	});
	return outcome;
}

/**
 * A unit no record names (one an older release started) becomes an attempt
 * only when no other attempt is pending: no record, or the recorded one
 * finished with another invocation, which this unit replaced. Otherwise it is
 * watched for display only (null) and its exit is nobody's outcome.
 */
export function adoptUnit(
	deps: AttemptDeps,
	invocation: string | undefined,
	{ plan }: { readonly plan?: string | undefined },
): string | null {
	if (invocation === undefined) return null;
	const attempt = randomUUID();
	const adopted = deps.updateAttempt((current) =>
		current === null ||
		(current.exitCode !== undefined &&
			current.invocation !== undefined &&
			current.invocation !== invocation)
			? {
					schema: 2,
					attempt,
					phase: "launched",
					uptimeMs: softwareUpdateUptimeMs(deps),
					invocation,
					...(plan ? { plan } : {}),
				}
			: null,
	);
	return adopted ? attempt : null;
}

/**
 * The only way to use a recorded exit. It is returned only while the record
 * is still `attempt`'s, launched, with an exit from its bound invocation (and
 * `invocation` when given), read from the stdout file that is there now, and,
 * with `fresh`, recorded within the replay window. All of it is compared in
 * one synchronous step after the last await, so an admission meanwhile wins.
 */
export async function claimOutcome(
	deps: AttemptDeps,
	attempt: string,
	{
		invocation,
		fresh = false,
	}: {
		readonly invocation?: string | undefined;
		readonly fresh?: boolean;
	} = {},
): Promise<ClaimedOutcome | null> {
	const transcript = await deps.transcript?.().catch(() => undefined);
	const record = readRecord(deps);
	if (
		record?.attempt !== attempt ||
		record.phase !== "launched" ||
		record.exitCode === undefined ||
		record.invocation === undefined ||
		(invocation !== undefined && record.invocation !== invocation)
	)
		return null;
	// Any later run, an older release's included, makes a new stdout file.
	if (
		deps.transcript &&
		(record.transcript === undefined || record.transcript !== transcript)
	)
		return null;
	if (fresh) {
		const age = softwareUpdateUptimeMs(deps) - record.uptimeMs;
		if (!(age >= 0 && age < RECORDED_OUTCOME_REPLAY_MS)) return null;
	}
	const claimed = record;
	return {
		attempt,
		invocation: record.invocation,
		exitCode: record.exitCode,
		drained: record.drained === true,
		...(record.plan ? { plan: record.plan } : {}),
		confirm: () => {
			const now = readRecord(deps);
			return (
				now?.attempt === claimed.attempt &&
				now.phase === "launched" &&
				now.invocation === claimed.invocation &&
				now.exitCode === claimed.exitCode &&
				now.drained === claimed.drained &&
				now.transcript === claimed.transcript &&
				now.plan === claimed.plan
			);
		},
	};
}

/**
 * Whether the finished unit `invocation` may be retired now: its exit is
 * recorded and its transcript was read, as the current attempt's own exit or
 * an older attempt's leftover. An unread transcript keeps the unit.
 */
export function claimRetirement(
	deps: AttemptDeps,
	invocation: string | undefined,
): boolean {
	if (invocation === undefined) return false;
	const record = readRecord(deps);
	const own =
		record?.phase === "launched" &&
		record.exitCode !== undefined &&
		record.invocation === invocation &&
		record.drained === true;
	const leftover =
		record?.leftover?.invocation === invocation &&
		record.leftover.drained === true;
	return own || leftover;
}
