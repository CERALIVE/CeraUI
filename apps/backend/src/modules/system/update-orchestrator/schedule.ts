/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Keep the top-level update cadence separate from the legacy refresh retry loop.
 */

import type { OrchestratorPhase, OrchestratorScheduleClock } from "./types.ts";

export const PACKAGE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const PACKAGE_CHECK_JITTER_MS = 30 * 60 * 1000;
export const OS_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const OS_CHECK_JITTER_MS = 60 * 60 * 1000;

export const BACKOFF_BASE_MS = 60 * 1000;
// Give a throttled or overloaded origin more room before retrying.
export const BACKOFF_BASE_RATE_LIMITED_MS = 5 * 60 * 1000;
export const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/** `randomUnit` is expected in [0, 1); the caller supplies the RNG. */
export function applyJitter(
	baseMs: number,
	jitterMs: number,
	randomUnit: number,
): number {
	const clampedUnit = Math.min(Math.max(randomUnit, 0), 1);
	const offset = (clampedUnit * 2 - 1) * jitterMs;
	return Math.max(0, Math.round(baseMs + offset));
}

/**
 * `consecutiveFailures` is the count AFTER this failure (1 on the first
 * failure), so the first retry uses the base delay unshifted.
 */
export function computeBackoffDelayMs(
	consecutiveFailures: number,
	rateLimited: boolean,
): number {
	const base = rateLimited ? BACKOFF_BASE_RATE_LIMITED_MS : BACKOFF_BASE_MS;
	const exponent = Math.max(0, consecutiveFailures - 1);
	const raw = base * 2 ** exponent;
	return Math.min(raw, BACKOFF_MAX_MS);
}

export type CheckKind = "packages" | "os";

export function computeNextCheckDelayMs(input: {
	readonly outcome: "success" | "failure";
	// The clock's consecutiveFailures value AFTER this outcome (0 on success).
	readonly consecutiveFailuresAfter: number;
	readonly rateLimited: boolean;
	readonly kind: CheckKind;
	readonly randomUnit: number;
}): number {
	if (input.outcome === "success") {
		const interval =
			input.kind === "packages"
				? PACKAGE_CHECK_INTERVAL_MS
				: OS_CHECK_INTERVAL_MS;
		const jitter =
			input.kind === "packages" ? PACKAGE_CHECK_JITTER_MS : OS_CHECK_JITTER_MS;
		return applyJitter(interval, jitter, input.randomUnit);
	}
	return computeBackoffDelayMs(
		input.consecutiveFailuresAfter,
		input.rateLimited,
	);
}

// ─── D7 — update-settings toggles ──────────────────────────────────────────
export function autoPipelineEnabled(
	kind: CheckKind,
	settings: { readonly packagesAuto: boolean; readonly systemAuto: boolean },
): boolean {
	return kind === "packages" ? settings.packagesAuto : settings.systemAuto;
}

export function scheduledCheckDue(input: {
	readonly now: number;
	readonly clock: OrchestratorScheduleClock;
	readonly kind: CheckKind;
	readonly settings: {
		readonly packagesAuto: boolean;
		readonly systemAuto: boolean;
	};
}): boolean {
	if (!autoPipelineEnabled(input.kind, input.settings)) return false;
	if (input.clock.nextAttemptAt === null) return true;
	return input.now >= input.clock.nextAttemptAt;
}

export function shouldAttemptScheduledCheck(input: {
	readonly now: number;
	readonly phase: OrchestratorPhase;
	readonly clock: OrchestratorScheduleClock;
	readonly kind: CheckKind;
	readonly settings: {
		readonly packagesAuto: boolean;
		readonly systemAuto: boolean;
	};
}): boolean {
	if (input.phase !== "idle") return false;
	return scheduledCheckDue(input);
}

export function canStartManualCheck(phase: OrchestratorPhase): boolean {
	return phase === "idle" || phase === "available" || phase === "os-available";
}

export function canStartManualInstall(
	phase: OrchestratorPhase,
	kind: CheckKind,
): boolean {
	return kind === "packages"
		? phase === "available" || phase === "awaiting-idle"
		: phase === "os-available";
}

// ─── D12 — cellular policy ──────────────────────────────────────────────────

export type CellularGateResult =
	| { readonly allowed: true }
	| { readonly allowed: false; readonly needsOverride: boolean };

/**
 * A cheap OS check and a large bundle stage have different billing consequences;
 * staging requires candidate-specific approval on a metered-only path.
 */
export function decideCellularGate(input: {
	readonly onlyMeteredCandidateExists: boolean;
	readonly kind: CheckKind;
	readonly stage: "check" | "install";
	readonly allowPackagesOverCellular: boolean;
	readonly allowSystemOverCellular: boolean;
	readonly cellularOverrideId: string | null;
	readonly candidateId: string;
}): CellularGateResult {
	if (!input.onlyMeteredCandidateExists) return { allowed: true };
	if (input.kind === "packages") {
		return input.allowPackagesOverCellular
			? { allowed: true }
			: { allowed: false, needsOverride: false };
	}
	if (input.stage === "check") {
		return input.allowSystemOverCellular
			? { allowed: true }
			: { allowed: false, needsOverride: false };
	}
	if (input.cellularOverrideId === input.candidateId) return { allowed: true };
	return { allowed: false, needsOverride: true };
}
