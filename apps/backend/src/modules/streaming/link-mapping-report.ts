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
  THE SENDER-REPORTED HALF OF THE DISPOSITION, AND ITS TRIP TO THE UI.

  Todo 11 built the typed-disposition producer boundary and deliberately left
  three seams unwired: `noteSenderBindMapReport` (the sender's own verdict
  REPLACES the writer's synthesized one), `onBindMapReportChange` (the band
  follows the stream) and `getNormalizedBindMapReport` (the single read). This
  module is the consumer that wires all three, and it is the ONLY place the raw
  telemetry document is read for a disposition — nothing downstream infers one.

  The parse is DEFENSIVE for the same reason `bytes_sent_total` is: the pinned
  `@ceralive/srtla-send` build predates todo 8's additive fields and its Zod
  reader strips unknown keys, so today these read as absent on every tick. An
  ABSENT field leaves the writer's synthesized verdict standing rather than
  retracting it — "this sender build does not report it" and "the sender
  withdrew its claim" are different facts, and only the second is a retraction.
*/

import type { BondMapping } from "@ceraui/rpc/schemas";
import {
	BIND_MAP_DEGRADED_REASONS,
	BIND_MAP_STATES,
	BOND_MAPPING_DISPOSITIONS,
} from "@ceraui/rpc/schemas";
import type { CollisionGroup } from "./bind-map.ts";
import type {
	BindMapDegradedReason,
	BindMapDisposition,
	BindMapDispositionState,
	BindMapState,
	BindMapStatus,
} from "./bind-map-disposition.ts";
import {
	getNormalizedBindMapReport,
	noteSenderBindMapReport,
} from "./bind-map-disposition.ts";

export interface SenderBindMapReport {
	readonly status: BindMapStatus;
	readonly disposition: BindMapDisposition;
}

function readRecord(
	source: unknown,
	key: string,
): Record<string, unknown> | undefined {
	const value = (source as Record<string, unknown> | null | undefined)?.[key];
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function readMember<T extends string>(
	source: Record<string, unknown> | undefined,
	key: string,
	allowed: readonly T[],
): T | undefined {
	const value = source?.[key];
	return typeof value === "string" &&
		(allowed as readonly string[]).includes(value)
		? (value as T)
		: undefined;
}

function readCollisions(
	source: Record<string, unknown> | undefined,
): CollisionGroup[] | undefined {
	const raw = source?.collisions;
	if (!Array.isArray(raw)) return undefined;
	const groups: CollisionGroup[] = [];
	for (const item of raw) {
		const group = item as Record<string, unknown> | null;
		const ip = group?.ip;
		const effective = group?.effective_index;
		const excluded = group?.excluded_indices;
		if (typeof ip !== "string" || !Number.isInteger(effective)) continue;
		groups.push({
			ip,
			effective_index: effective as number,
			excluded_indices: Array.isArray(excluded)
				? excluded.filter((index): index is number => Number.isInteger(index))
				: [],
		});
	}
	return groups;
}

/**
 * Todo 8's `bind_map_status` + `disposition`, or `undefined` when this sender
 * build reports neither. BOTH halves are required: a status with no disposition
 * cannot be completed without guessing which links are actually carrying.
 */
export function readSenderBindMapReport(
	snapshot: unknown,
): SenderBindMapReport | undefined {
	const statusRaw = readRecord(snapshot, "bind_map_status");
	const dispositionRaw = readRecord(snapshot, "disposition");

	const state = readMember<BindMapState>(statusRaw, "state", BIND_MAP_STATES);
	const dispositionState = readMember<BindMapDispositionState>(
		dispositionRaw,
		"state",
		BOND_MAPPING_DISPOSITIONS,
	);
	if (state === undefined || dispositionState === undefined) return undefined;

	const reason = readMember<BindMapDegradedReason>(
		statusRaw,
		"reason",
		BIND_MAP_DEGRADED_REASONS,
	);
	const collisions = readCollisions(dispositionRaw);

	return {
		status: { state, ...(reason !== undefined ? { reason } : {}) },
		disposition: {
			state: dispositionState,
			...(collisions !== undefined && collisions.length > 0
				? { collisions }
				: {}),
		},
	};
}

let lastSenderReportJson: string | undefined;

/**
 * Hand a fresh snapshot's verdict to the producer boundary, on CHANGE only.
 *
 * The boundary notifies its listeners on every write, so re-asserting an
 * unchanged verdict at the telemetry cadence would re-broadcast the operator
 * band once a second for a bond whose state never moved.
 */
export function ingestSenderBindMapReport(snapshot: unknown): void {
	const report = readSenderBindMapReport(snapshot);
	if (report === undefined) return;

	const json = JSON.stringify(report);
	if (json === lastSenderReportJson) return;
	lastSenderReportJson = json;
	noteSenderBindMapReport(report);
}

/** Forget the last sender verdict — a new session makes no claim from an old one. */
export function resetSenderBindMapReport(): void {
	lastSenderReportJson = undefined;
}

/** Is the (ip,iface) mapping actually in force right now? */
export function isBondMappingActive(): boolean {
	return getNormalizedBindMapReport()?.status.state === "active";
}

/**
 * THE MAPPING STATE IS A TRI-STATE, AND THE BOOLEAN ABOVE CANNOT EXPRESS IT.
 *
 * `isBondMappingActive()` answers `false` for TWO facts that call for opposite
 * operator copy: no bond has been described at all (an IDLE device — nothing has
 * launched, so nothing is excluded), and a described mapping that is degraded (a
 * launch really did collapse the twins). Reading that one bit told an idle
 * operator with two perfectly mappable twins that "only one of them can carry
 * bonded traffic" — a claim about a bond that does not exist.
 *
 * `absent` folds into `degraded` deliberately: both mean a DESCRIBED bond whose
 * mapping is not in force, which is the only distinction a consumer of this
 * function may act on; the precise reason still rides `status.reason`. This is
 * ADDITIVE — `isBondMappingActive()` keeps its exact meaning, so the telemetry
 * rung-3 gate that reads it is untouched.
 */
export type BondMappingState = "none" | "active" | "degraded";

export function getBondMappingState(): BondMappingState {
	const state = getNormalizedBindMapReport()?.status.state;
	if (state === undefined) return "none";
	return state === "active" ? "active" : "degraded";
}

/**
 * The normalized report as the UI reads it — `null` when no bond is described.
 *
 * Emitted as an explicit value on every status frame rather than only when
 * degraded: the frontend status merge preserves an omitted field, so a
 * raise-only band could be raised and never lowered.
 */
export function buildBondMapping(): BondMapping | null {
	const report = getNormalizedBindMapReport();
	if (report === undefined) return null;
	return {
		state: report.status.state,
		...(report.status.reason !== undefined
			? { reason: report.status.reason }
			: {}),
		disposition: report.disposition.state,
		...(report.disposition.collisions !== undefined &&
		report.disposition.collisions.length > 0
			? {
					collisions: report.disposition.collisions.map((group) => ({
						...group,
						excluded_indices: [...group.excluded_indices],
					})),
				}
			: {}),
		source: report.source,
	};
}
