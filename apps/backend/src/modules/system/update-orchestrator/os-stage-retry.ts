/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * OS staging recovery policy, pure: which round a failed attempt was, when an
 * automatic retry is due, and whether the device positively proves a failed
 * stage left nothing behind. Effects live in runtime.ts.
 */

import type { OsStageRecovery } from "@ceraui/rpc/schemas";
import { sha256Hex } from "../../../helpers/crypto.ts";
import type { OsChannelManifest } from "./os-manifest.ts";
import type { RootSlotStatus } from "./slot-status.ts";

export const OS_STAGE_AUTOMATIC_ROUNDS = 3;
export const OS_STAGE_FIRST_RETRY_DELAY_MS = 15 * 60_000;
export const OS_STAGE_SECOND_RETRY_DELAY_MS = 30 * 60_000;

/** The exact candidate a budget belongs to; a new signed pointer is a new key. */
export function osStageCandidateKey(manifest: OsChannelManifest): string {
	return [
		manifest.version,
		String(manifest.serial),
		manifest.channel,
		manifest.board,
		manifest.compatible,
		manifest.bundle.url,
		manifest.bundle.sha256,
	].join("|");
}

export function osStageCandidateVersion(candidateKey: string): string {
	return candidateKey.split("|")[0] ?? "";
}

export function osStageNoticeId(candidateKey: string): string {
	return sha256Hex(candidateKey).slice(0, 16);
}

export function startOsStageAttempt(
	record: OsStageRecovery | undefined,
	candidateKey: string,
	attemptId: string,
): OsStageRecovery {
	if (record?.candidateKey !== candidateKey)
		return {
			candidateKey,
			activeAttemptId: attemptId,
			attemptId,
			failedRounds: 0,
			nextRetryAt: null,
			mode: "automatic",
			reason: null,
		};
	return {
		...record,
		activeAttemptId: attemptId,
		attemptId,
		nextRetryAt: null,
	};
}

/** Counts the settled attempt as ONE failed round and picks what follows it. */
export function settleFailedOsStageRound(
	record: OsStageRecovery,
	mode: OsStageRecovery["mode"],
	reason: string,
	now: number,
): OsStageRecovery {
	const failedRounds = record.failedRounds + 1;
	const settled = { ...record, activeAttemptId: null, failedRounds, reason };
	switch (mode) {
		case "automatic":
			if (failedRounds < OS_STAGE_AUTOMATIC_ROUNDS)
				return {
					...settled,
					mode: "automatic",
					nextRetryAt:
						now +
						(failedRounds === 1
							? OS_STAGE_FIRST_RETRY_DELAY_MS
							: OS_STAGE_SECOND_RETRY_DELAY_MS),
				};
			return { ...settled, mode: "operator", nextRetryAt: null };
		case "operator":
		case "unsafe":
			return { ...settled, mode, nextRetryAt: null };
		default: {
			const unreachable: never = mode;
			return unreachable;
		}
	}
}

export type OsStagePermission =
	| "fresh" // no failed round for this candidate: stage normally
	| "retry" // a failed round exists and a new round is permitted now
	| "wait" // an automatic retry is scheduled for later
	| "paused"; // only the operator may start another round

export function osStagePermission(
	record: OsStageRecovery | undefined,
	candidateKey: string,
	now: number,
	manual: boolean,
): OsStagePermission {
	if (!record || record.candidateKey !== candidateKey) return "fresh";
	switch (record.mode) {
		case "unsafe":
			return "paused";
		case "operator":
			return manual ? "retry" : "paused";
		case "automatic":
			if (manual) return record.failedRounds > 0 ? "retry" : "fresh";
			if (record.nextRetryAt !== null && now < record.nextRetryAt)
				return "wait";
			return record.failedRounds > 0 ? "retry" : "fresh";
		default: {
			const unreachable: never = record.mode;
			return unreachable;
		}
	}
}

export type OsStageSettlementEvidence = {
	readonly raucOperation: "idle" | "running";
	readonly writerQuiescent: boolean;
	readonly rootSlots: readonly RootSlotStatus[];
	readonly healthyBootId: string | null;
	readonly bootId: string;
	readonly stagedReceiptPresent: boolean;
	readonly activationArmed: boolean;
};

/**
 * True only when every reading positively says the failed stage is over and
 * changed nothing that matters: RAUC idle, no surviving writer, this boot's
 * slot booted and healthy, the one other rootfs inactive and marked bad, and
 * no staged receipt or armed activation that could make the outcome a stage.
 * A good inactive target is NOT safe: RAUC marks a target good when an install
 * completes, so it may be a staged image nobody recorded.
 */
export function osStageFailureSettledSafely(
	evidence: OsStageSettlementEvidence,
): boolean {
	const rootfs = evidence.rootSlots;
	const booted = rootfs.filter((slot) => slot.state === "booted");
	const others = rootfs.filter((slot) => slot.state !== "booted");
	return (
		evidence.raucOperation === "idle" &&
		evidence.writerQuiescent &&
		!evidence.stagedReceiptPresent &&
		!evidence.activationArmed &&
		evidence.healthyBootId !== null &&
		evidence.healthyBootId === evidence.bootId &&
		rootfs.length === 2 &&
		booted.length === 1 &&
		booted[0]?.bootStatus === "good" &&
		others.length === 1 &&
		others[0]?.state === "inactive" &&
		others[0]?.bootStatus === "bad"
	);
}
