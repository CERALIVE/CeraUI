import { expect, test } from "bun:test";
import {
	decideDisruptiveAction,
	type StreamLiveness,
	updatePhaseBusyReasons,
} from "../modules/system/disruptive-action-gate.ts";
import type { OrchestratorPhase } from "../modules/system/update-orchestrator/types.ts";

const phaseContract = [
	["idle", false],
	["checking", false],
	["available", false],
	["downloading", true],
	["awaiting-idle", false],
	["committing", true],
	["restarting-services", true],
	["settled", false],
	["os-available", false],
	["os-staging", true],
	["os-staged", false],
	["os-activation-armed", false],
	["os-verifying", false],
	["sync-eligible", false],
	["syncing", true],
	["synced", false],
	["quarantined", false],
	["failed", false],
] as const satisfies readonly (readonly [OrchestratorPhase, boolean])[];

for (const stream of [
	"streaming",
	"idle",
	"unknown",
] satisfies StreamLiveness[]) {
	for (const [phase, busy] of phaseContract) {
		test(`gate matrix ${stream} / ${phase}`, () => {
			// Given an independent interruption table, not the production phase list.
			// When the real gate sees that phase's authoritative busy reasons.
			const result = decideDisruptiveAction({
				streamLiveness: stream,
				updateBusy: updatePhaseBusyReasons(phase),
			});
			// Then only confirmed idle without interruption risk is permitted.
			expect(result.allowed).toBe(stream === "idle" && !busy);
		});
	}
}

for (const reason of [
	"pending-success",
	"pending-durability",
	"os-activation",
	"maintenance",
	"update-recovery",
	"package-install",
] as const) {
	test(`gate refuses ${reason} even at idle`, () => {
		// Given an independent owner outside the phase projection.
		const evidence = { streamLiveness: "idle", updateBusy: [reason] } as const;
		// When an action asks for permission.
		const result = decideDisruptiveAction(evidence);
		// Then interruption is refused with the existing update token.
		expect(result).toEqual({ allowed: false, reason: "update_in_progress" });
	});
}
