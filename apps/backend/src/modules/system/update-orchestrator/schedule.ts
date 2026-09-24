/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Pure scheduling decisions (Todo 36): jitter/backoff cadence, and the D7/D12
 * gates that decide whether an automatic check/install attempt may run right
 * now. This EXTENDS the existing `software-updates.ts::computeNextCheckDelay`
 * PATTERN (a pure `(outcome, failures) -> delayMs` function driving a
 * self-rescheduling timer) rather than reusing that exact function: that
 * function is the LEGACY internal `apt-get update` retry sub-loop (hourly on
 * success, 10s/12-retry-then-1-minute on failure) — a different cadence for a
 * different, narrower purpose. The orchestrator owns a NEW top-level cadence
 * (6h/12h with jitter, exponential backoff capped at 24h) as the plan
 * specifies, and this module is that cadence's pure decision surface.
 *
 * No I/O, no Date.now(), no Math.random() — every "now" and every random unit
 * interval [0, 1) is supplied by the caller (the effects layer in
 * `runtime.ts`), so every decision here is exhaustively testable with fixed
 * inputs.
 */

import type { OrchestratorPhase, OrchestratorScheduleClock } from "./types.ts";

export const PACKAGE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const PACKAGE_CHECK_JITTER_MS = 30 * 60 * 1000;
export const OS_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const OS_CHECK_JITTER_MS = 60 * 60 * 1000;

// Transient-failure backoff base. Doubles per consecutive failure, capped at
// BACKOFF_MAX_MS.
export const BACKOFF_BASE_MS = 60 * 1000;
// A SEPARATE, more conservative base for HTTP 429/5xx specifically — named
// apart in the plan as "Cloudflare Free-plan quota safety, a real operational
// concern, not decorative": apt.ceralive.tv is Cloudflare-fronted, and a tight
// retry loop against a rate-limited or overloaded origin is exactly the
// traffic pattern that burns a free-tier quota fastest. Both share the same
// 24h ceiling and the same doubling curve; only the starting point differs.
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
// `packagesAuto`/`systemAuto` gate the entire AUTOMATIC pipeline (scheduled
// check through install) for their respective update kind. A manual RPC call
// (system.checkUpdatesNow / installUpdatesNow) is a deliberate operator
// override and is NEVER subject to this gate — only the schedule's own timer
// is. This mirrors ordinary "automatic updates on/off" UX: off means "I will
// drive this myself", not "hide the feature".
export function autoPipelineEnabled(
	kind: CheckKind,
	settings: { readonly packagesAuto: boolean; readonly systemAuto: boolean },
): boolean {
	return kind === "packages" ? settings.packagesAuto : settings.systemAuto;
}

// A scheduled (non-manual) check may start only when the clock says it is due
// AND the phase is quiescent (idle) AND the D7 toggle for this kind is on.
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
	if (!autoPipelineEnabled(input.kind, input.settings)) return false;
	if (input.clock.nextAttemptAt === null) return true;
	return input.now >= input.clock.nextAttemptAt;
}

// A manual check (system.checkUpdatesNow) bypasses the schedule's due-time and
// the D7 toggle, but it can never run out of a phase that is already doing
// something else — that guard is structural (the reducer's PACKAGE_CHECK_STARTED
// only transitions from idle/available/settled-once-acked), and this function
// mirrors it explicitly so the effects layer has one place to ask "can a
// manual check start right now" without re-deriving the reducer's own rule.
export function canStartManualCheck(phase: OrchestratorPhase): boolean {
	return phase === "idle" || phase === "available" || phase === "os-available";
}

// A manual install (system.installUpdatesNow) bypasses idle (Todo 32) but MUST
// still hold: (a) an update is actually known available for the requested
// kind, and (b) the stream-admission block is untouched — that is enforced
// separately by admission.ts / the future Todo-37 wiring, never here.
export function canStartManualInstall(
	phase: OrchestratorPhase,
	kind: CheckKind,
): boolean {
	return kind === "packages" ? phase === "available" : phase === "os-available";
}

// ─── D12 — cellular policy ──────────────────────────────────────────────────

export type CellularGateResult =
	| { readonly allowed: true }
	| { readonly allowed: false; readonly needsOverride: boolean };

/**
 * `onlyMeteredCandidateExists`: true iff every currently reachable uplink
 * candidate (from `update-transport/core.ts::discoverCandidates`) is metered —
 * i.e. there is no unmetered path available at all, not merely "a metered link
 * exists among others".
 *
 * Packages: gated on `allowPackagesOverCellular` alone, for both the check and
 * the install — package deltas are small and the existing legacy path already
 * treats them this way.
 *
 * OS CHECK (small manifest fetch): gated on `allowSystemOverCellular` — this is
 * the toggle's role for the OS kind. If false, the orchestrator does not even
 * spend metered bytes finding out whether an OS update exists.
 *
 * OS STAGING (the actual multi-hundred-MB bundle download): per the plan,
 * ALWAYS held on a metered-only uplink regardless of `allowSystemOverCellular`
 * — the toggle does not reach this decision at all. The only way past it is
 * `system.allowCellularOnce(id)` matching the exact candidate id, consumed on
 * use. This asymmetry (toggle gates the cheap check, never the expensive
 * stage) is what makes both `allowSystemOverCellular` and the one-time
 * override meaningful at once, rather than one making the other redundant.
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
