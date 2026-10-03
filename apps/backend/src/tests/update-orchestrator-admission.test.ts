/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Exhaustive D8 admission table (Todo 36) — the single most safety-critical
 * property this task delivers. Every one of the 18 orchestrator phases is
 * covered explicitly, not just the plan's three named examples.
 */

import { describe, expect, test } from "bun:test";
import {
	admitStreamStart,
	onStreamStart,
	STREAM_REFUSING_PHASES,
} from "../modules/system/update-orchestrator/admission.ts";
import {
	initialOrchestratorState,
	ORCHESTRATOR_PHASES,
	type OrchestratorPhase,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";

function stateAt(
	phase: OrchestratorPhase,
	progress: { percent: number; etaSeconds: number } | null = null,
): OrchestratorState {
	return { ...initialOrchestratorState(0), phase, progress };
}

// The exact D8 verdict per phase, per the plan text verbatim:
//   committing / restarting-services -> refuse
//   downloading / os-staging -> allowed + abort-network
//   syncing -> allowed + continue-local
//   every other phase -> allowed + none
const EXPECTED: Record<
	OrchestratorPhase,
	{ allowed: boolean; action: "abort-network" | "continue-local" | "none" }
> = {
	idle: { allowed: true, action: "none" },
	checking: { allowed: true, action: "none" },
	available: { allowed: true, action: "none" },
	downloading: { allowed: true, action: "abort-network" },
	"awaiting-idle": { allowed: true, action: "none" },
	committing: { allowed: false, action: "none" },
	"restarting-services": { allowed: false, action: "none" },
	settled: { allowed: true, action: "none" },
	"os-available": { allowed: true, action: "none" },
	"os-staging": { allowed: true, action: "abort-network" },
	"os-staged": { allowed: true, action: "none" },
	"os-activation-armed": { allowed: true, action: "none" },
	"os-verifying": { allowed: true, action: "none" },
	"sync-eligible": { allowed: true, action: "none" },
	syncing: { allowed: true, action: "continue-local" },
	synced: { allowed: true, action: "none" },
	quarantined: { allowed: true, action: "none" },
	failed: { allowed: true, action: "none" },
};

describe("D8 admission matrix — exhaustive over every phase", () => {
	// Sanity: the fixture table itself must cover every phase the reducer
	// knows about, or this suite silently stops being exhaustive the moment a
	// new phase is added to ORCHESTRATOR_PHASES.
	test("EXPECTED table covers every ORCHESTRATOR_PHASES entry, exactly once", () => {
		expect(Object.keys(EXPECTED).sort()).toEqual(
			[...ORCHESTRATOR_PHASES].sort(),
		);
	});

	for (const phase of ORCHESTRATOR_PHASES) {
		const expected = EXPECTED[phase];
		test(`admitStreamStart(${phase}) -> allowed=${expected.allowed}`, () => {
			const state = stateAt(phase, { percent: 42, etaSeconds: 99 });
			const result = admitStreamStart(state);
			if (expected.allowed) {
				expect(result).toEqual({ allowed: true });
			} else {
				expect(result).toEqual({
					allowed: false,
					reason: "update_in_progress",
					phase,
					percent: 42,
					etaSeconds: 99,
				});
			}
		});

		test(`onStreamStart(${phase}) -> ${expected.action}`, () => {
			const state = stateAt(phase, { percent: 10, etaSeconds: 5 });
			expect(onStreamStart(state)).toBe(expected.action);
		});
	}

	test("a refusal with no progress data reports 0/0, never throws", () => {
		const result = admitStreamStart(stateAt("committing", null));
		expect(result).toEqual({
			allowed: false,
			reason: "update_in_progress",
			phase: "committing",
			percent: 0,
			etaSeconds: 0,
		});
	});

	test("STREAM_REFUSING_PHASES is exactly {committing, restarting-services} — no more, no less", () => {
		expect([...STREAM_REFUSING_PHASES].sort()).toEqual(
			["committing", "restarting-services"].sort(),
		);
	});

	test("every refusing phase is refused and every non-refusing phase is allowed (cross-check against EXPECTED)", () => {
		for (const phase of ORCHESTRATOR_PHASES) {
			const isRefusing = STREAM_REFUSING_PHASES.includes(phase);
			expect(EXPECTED[phase].allowed).toBe(!isRefusing);
		}
	});

	test("admitStreamStart and onStreamStart are pure — same input, same output, no state mutation", () => {
		const state = stateAt("downloading", { percent: 5, etaSeconds: 1 });
		const frozen = Object.freeze({ ...state });
		const a1 = admitStreamStart(frozen as OrchestratorState);
		const a2 = admitStreamStart(frozen as OrchestratorState);
		expect(a1).toEqual(a2);
		const b1 = onStreamStart(frozen as OrchestratorState);
		const b2 = onStreamStart(frozen as OrchestratorState);
		expect(b1).toBe(b2);
	});
});
