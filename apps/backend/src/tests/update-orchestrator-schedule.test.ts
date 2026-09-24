/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import { describe, expect, test } from "bun:test";
import {
	applyJitter,
	autoPipelineEnabled,
	BACKOFF_BASE_MS,
	BACKOFF_BASE_RATE_LIMITED_MS,
	BACKOFF_MAX_MS,
	canStartManualCheck,
	canStartManualInstall,
	computeBackoffDelayMs,
	computeNextCheckDelayMs,
	decideCellularGate,
	OS_CHECK_INTERVAL_MS,
	OS_CHECK_JITTER_MS,
	PACKAGE_CHECK_INTERVAL_MS,
	PACKAGE_CHECK_JITTER_MS,
	shouldAttemptScheduledCheck,
} from "../modules/system/update-orchestrator/schedule.ts";
import { initialScheduleClock } from "../modules/system/update-orchestrator/types.ts";

describe("schedule.ts — jitter", () => {
	test("randomUnit=0.5 (midpoint) yields the exact base with no offset", () => {
		expect(applyJitter(1000, 100, 0.5)).toBe(1000);
	});
	test("randomUnit=0 yields base - jitter", () => {
		expect(applyJitter(1000, 100, 0)).toBe(900);
	});
	test("randomUnit=1 yields base + jitter", () => {
		expect(applyJitter(1000, 100, 1)).toBe(1100);
	});
	test("never returns negative even with an out-of-range randomUnit", () => {
		expect(applyJitter(10, 100, -5)).toBe(0);
	});
});

describe("schedule.ts — cadence constants match the plan exactly", () => {
	test("package check: 6h base, 30min jitter", () => {
		expect(PACKAGE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
		expect(PACKAGE_CHECK_JITTER_MS).toBe(30 * 60 * 1000);
	});
	test("os manifest check: 12h base, 1h jitter", () => {
		expect(OS_CHECK_INTERVAL_MS).toBe(12 * 60 * 60 * 1000);
		expect(OS_CHECK_JITTER_MS).toBe(60 * 60 * 1000);
	});
});

describe("schedule.ts — exponential backoff, capped at 24h", () => {
	test("first failure uses the base delay unshifted", () => {
		expect(computeBackoffDelayMs(1, false)).toBe(BACKOFF_BASE_MS);
	});
	test("doubles per consecutive failure", () => {
		expect(computeBackoffDelayMs(2, false)).toBe(BACKOFF_BASE_MS * 2);
		expect(computeBackoffDelayMs(3, false)).toBe(BACKOFF_BASE_MS * 4);
	});
	test("caps at 24h even with a huge failure count", () => {
		expect(computeBackoffDelayMs(999, false)).toBe(BACKOFF_MAX_MS);
	});
	test("429/5xx uses a separate, larger base (Cloudflare quota safety)", () => {
		expect(computeBackoffDelayMs(1, true)).toBe(BACKOFF_BASE_RATE_LIMITED_MS);
		expect(BACKOFF_BASE_RATE_LIMITED_MS).toBeGreaterThan(BACKOFF_BASE_MS);
	});
	test("rate-limited backoff also caps at 24h", () => {
		expect(computeBackoffDelayMs(999, true)).toBe(BACKOFF_MAX_MS);
	});
});

describe("schedule.ts — computeNextCheckDelayMs dispatches success vs failure correctly", () => {
	test("success uses the interval+jitter for the given kind", () => {
		const delay = computeNextCheckDelayMs({
			outcome: "success",
			consecutiveFailuresAfter: 0,
			rateLimited: false,
			kind: "packages",
			randomUnit: 0.5,
		});
		expect(delay).toBe(PACKAGE_CHECK_INTERVAL_MS);
	});
	test("failure uses backoff regardless of kind", () => {
		const delay = computeNextCheckDelayMs({
			outcome: "failure",
			consecutiveFailuresAfter: 1,
			rateLimited: false,
			kind: "os",
			randomUnit: 0.5,
		});
		expect(delay).toBe(BACKOFF_BASE_MS);
	});
});

describe("schedule.ts — D7 auto-pipeline toggle", () => {
	test("packagesAuto gates packages, systemAuto gates os, independently", () => {
		const settings = { packagesAuto: true, systemAuto: false };
		expect(autoPipelineEnabled("packages", settings)).toBe(true);
		expect(autoPipelineEnabled("os", settings)).toBe(false);
	});
});

describe("schedule.ts — shouldAttemptScheduledCheck", () => {
	const settings = { packagesAuto: true, systemAuto: true };

	test("refuses outside idle phase", () => {
		expect(
			shouldAttemptScheduledCheck({
				now: 1000,
				phase: "available",
				clock: initialScheduleClock(),
				kind: "packages",
				settings,
			}),
		).toBe(false);
	});

	test("refuses when the D7 toggle for that kind is off, even at idle and overdue", () => {
		expect(
			shouldAttemptScheduledCheck({
				now: 1000,
				phase: "idle",
				clock: { ...initialScheduleClock(), nextAttemptAt: 500 },
				kind: "packages",
				settings: { packagesAuto: false, systemAuto: true },
			}),
		).toBe(false);
	});

	test("allows a never-attempted clock (nextAttemptAt null) at idle with the toggle on", () => {
		expect(
			shouldAttemptScheduledCheck({
				now: 1000,
				phase: "idle",
				clock: initialScheduleClock(),
				kind: "packages",
				settings,
			}),
		).toBe(true);
	});

	test("refuses before the due time, allows at/after it", () => {
		const clock = { ...initialScheduleClock(), nextAttemptAt: 1000 };
		expect(
			shouldAttemptScheduledCheck({
				now: 999,
				phase: "idle",
				clock,
				kind: "packages",
				settings,
			}),
		).toBe(false);
		expect(
			shouldAttemptScheduledCheck({
				now: 1000,
				phase: "idle",
				clock,
				kind: "packages",
				settings,
			}),
		).toBe(true);
	});
});

describe("schedule.ts — manual-action structural gates", () => {
	test("canStartManualCheck allows idle/available/os-available only", () => {
		expect(canStartManualCheck("idle")).toBe(true);
		expect(canStartManualCheck("available")).toBe(true);
		expect(canStartManualCheck("os-available")).toBe(true);
		expect(canStartManualCheck("committing")).toBe(false);
		expect(canStartManualCheck("downloading")).toBe(false);
	});
	test("canStartManualInstall requires the matching kind's available phase", () => {
		expect(canStartManualInstall("available", "packages")).toBe(true);
		expect(canStartManualInstall("os-available", "packages")).toBe(false);
		expect(canStartManualInstall("os-available", "os")).toBe(true);
		expect(canStartManualInstall("idle", "packages")).toBe(false);
	});
});

describe("schedule.ts — D12 cellular gate", () => {
	const base = {
		onlyMeteredCandidateExists: true,
		allowPackagesOverCellular: true,
		allowSystemOverCellular: true,
		cellularOverrideId: null as string | null,
		candidateId: "manifest-v9",
	};

	test("never gated when a non-metered candidate exists, regardless of kind/stage/toggles", () => {
		expect(
			decideCellularGate({
				...base,
				onlyMeteredCandidateExists: false,
				kind: "os",
				stage: "install",
				allowSystemOverCellular: false,
			}),
		).toEqual({ allowed: true });
	});

	test("packages: gated purely on allowPackagesOverCellular, for BOTH stages", () => {
		for (const stage of ["check", "install"] as const) {
			expect(
				decideCellularGate({
					...base,
					kind: "packages",
					stage,
					allowPackagesOverCellular: true,
				}),
			).toEqual({ allowed: true });
			expect(
				decideCellularGate({
					...base,
					kind: "packages",
					stage,
					allowPackagesOverCellular: false,
				}),
			).toEqual({ allowed: false, needsOverride: false });
		}
	});

	test("os check: gated on allowSystemOverCellular alone", () => {
		expect(
			decideCellularGate({
				...base,
				kind: "os",
				stage: "check",
				allowSystemOverCellular: true,
			}),
		).toEqual({ allowed: true });
		expect(
			decideCellularGate({
				...base,
				kind: "os",
				stage: "check",
				allowSystemOverCellular: false,
			}),
		).toEqual({ allowed: false, needsOverride: false });
	});

	test("os install: ALWAYS held regardless of allowSystemOverCellular, unless the exact one-time override matches", () => {
		expect(
			decideCellularGate({
				...base,
				kind: "os",
				stage: "install",
				allowSystemOverCellular: true, // toggle is irrelevant here
				cellularOverrideId: null,
			}),
		).toEqual({ allowed: false, needsOverride: true });

		expect(
			decideCellularGate({
				...base,
				kind: "os",
				stage: "install",
				allowSystemOverCellular: false,
				cellularOverrideId: "manifest-v9",
			}),
		).toEqual({ allowed: true });

		// a stale override for a DIFFERENT candidate must not leak through
		expect(
			decideCellularGate({
				...base,
				kind: "os",
				stage: "install",
				cellularOverrideId: "manifest-v8",
			}),
		).toEqual({ allowed: false, needsOverride: true });
	});
});
