/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
  THE TYPED-DISPOSITION PRODUCER BOUNDARY.

  A bond is either mapped or it is degraded, and the operator must be told which
  in EVERY case. The sender reports its own verdict as typed telemetry (todo 8's
  `bind_map_status` + `disposition`) — but there are two launch paths the sender
  structurally CANNOT report:

    1. the installed binary has no `--bind-map` at all, so it is never given one
       and has nothing to say about a contract it does not implement; and
    2. the writer could not put a usable mapping on disk, so `--bind-map` was
       withheld and, again, the sender only ever sees a legacy invocation.

  In both cases CeraUI knows EXACTLY what it published and exactly which rows
  collide, so it SYNTHESIZES the same typed values the sender would have used.
  Sender-reported telemetry REPLACES the synthesized value the moment it arrives.
  The UI therefore consumes ONE normalized stream and never infers a degradation
  from the absence of a field — inference is how "two modems, one link, no
  explanation" happened in the first place.

  THE VALUE NAMES ARE TODO 8'S, VERBATIM. There is no second vocabulary here: a
  parallel classification would let a log line, a band, and the sender disagree
  about the same bond.
*/

import {
	type BondEntry,
	type CollisionGroup,
	collisionGroups,
} from "./bind-map.ts";

export type BindMapState = "active" | "absent" | "degraded";

/** The seven ADR-003 §6.4 reasons, spelled exactly as the sender spells them. */
export type BindMapDegradedReason =
	| "hash_mismatch"
	| "malformed"
	| "unknown_iface"
	| "retry_exhausted"
	| "missing_file"
	| "unreadable"
	| "unsupported";

export type BindMapDispositionState =
	| "mapped"
	| "retained_last_valid"
	| "legacy_unique_only"
	| "startup_collision_excluded";

export interface BindMapStatus {
	readonly state: BindMapState;
	readonly reason?: BindMapDegradedReason;
}

export interface BindMapDisposition {
	readonly state: BindMapDispositionState;
	readonly collisions?: readonly CollisionGroup[];
}

/** The ONE shape every consumer reads, whoever produced it. */
export interface NormalizedBindMapReport {
	readonly status: BindMapStatus;
	readonly disposition: BindMapDisposition;
	/** Which half of the boundary produced this. Diagnostic, never a gate. */
	readonly source: "sender" | "writer";
}

/** Why the writer is speaking for the sender on this launch. */
export type WriterDispositionCause =
	| "bind-map-passed"
	| "capability-unsupported"
	| "mapping-write-failed";

/**
 * The verdict the writer synthesizes for a launch path the sender cannot report.
 *
 * The disposition arm is decided by what was actually published, not by the
 * cause: a legacy launch with NO same-IP group really is `legacy_unique_only`
 * (every link runs, nothing is lost), while one WITH a group is
 * `startup_collision_excluded` — the sender keeps the first occurrence in file
 * order and drops the rest, so the operator is told the group exists and that
 * one representative is carrying it. Legacy mode cannot know WHICH physical twin
 * that representative is, and the copy must not pretend otherwise.
 */
export function synthesizeWriterReport(
	cause: WriterDispositionCause,
	entries: readonly BondEntry[],
): NormalizedBindMapReport {
	if (cause === "bind-map-passed") {
		return {
			status: { state: "active" },
			disposition: { state: "mapped" },
			source: "writer",
		};
	}

	const collisions = collisionGroups(entries);
	const status: BindMapStatus =
		cause === "capability-unsupported"
			? { state: "degraded", reason: "unsupported" }
			: { state: "degraded", reason: "missing_file" };

	return {
		status,
		disposition:
			collisions.length > 0
				? { state: "startup_collision_excluded", collisions }
				: { state: "legacy_unique_only" },
		source: "writer",
	};
}

let writerReport: NormalizedBindMapReport | undefined;
let senderReport: NormalizedBindMapReport | undefined;
const listeners = new Set<
	(report: NormalizedBindMapReport | undefined) => void
>();

function notify(): void {
	const report = getNormalizedBindMapReport();
	for (const listener of listeners) {
		try {
			listener(report);
		} catch {
			// A consumer that throws must not stop the next one from being told.
		}
	}
}

/**
 * Record the writer's own verdict for this launch.
 *
 * It is recorded even on the mapped path, so a session always has a value before
 * the sender's first telemetry frame arrives — a blank band during the first
 * second of a degraded bond is the same silence this boundary exists to remove.
 */
export function noteWriterBindMapReport(
	cause: WriterDispositionCause,
	entries: readonly BondEntry[],
): void {
	writerReport = synthesizeWriterReport(cause, entries);
	senderReport = undefined;
	notify();
}

/**
 * Record the sender's own typed verdict; it OUTRANKS the synthesized one.
 *
 * The sender observes what actually happened at read time (a hash mismatch, a
 * degraded reload that retained the last valid pool), which the writer cannot
 * know. Passing `undefined` retires the sender's claim and falls back to the
 * writer's — used when telemetry stops rather than when it reports health.
 */
export function noteSenderBindMapReport(
	report:
		| { status: BindMapStatus; disposition: BindMapDisposition }
		| undefined,
): void {
	senderReport =
		report === undefined
			? undefined
			: {
					status: report.status,
					disposition: report.disposition,
					source: "sender",
				};
	notify();
}

/** The ONE normalized disposition stream. Sender-reported wins when present. */
export function getNormalizedBindMapReport():
	| NormalizedBindMapReport
	| undefined {
	return senderReport ?? writerReport;
}

/** Subscribe to normalized-report changes. Returns the unsubscribe handle. */
export function onBindMapReportChange(
	listener: (report: NormalizedBindMapReport | undefined) => void,
): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Retire both halves — a stopped session makes no claim about a bond. */
export function clearBindMapReport(): void {
	writerReport = undefined;
	senderReport = undefined;
	notify();
}

/** Drop listeners as well (test isolation). Never call from production code. */
export function resetBindMapReportListeners(): void {
	listeners.clear();
}

/**
 * Is this report a degradation an operator must SEE?
 *
 * Every state except `mapped` is: `retained_last_valid` means both twins are
 * still running on an older mapping, `startup_collision_excluded` means a group
 * is down to one representative, and `legacy_unique_only` means the unique links
 * are normal while a collision group would be absent. Only a fully mapped bond
 * is silent.
 */
export function isOperatorVisibleDegradation(
	report: NormalizedBindMapReport | undefined,
): boolean {
	if (report === undefined) return false;
	return report.disposition.state !== "mapped";
}
