import { expect, test } from "bun:test";
import {
	type MirrorTargetVerdict,
	slotSyncGate,
} from "../modules/system/update-orchestrator/slot-sync-gate.ts";
import type { OrchestratorPhase } from "../modules/system/update-orchestrator/types.ts";
import { evidence, statusSha256 } from "./helpers/slot-sync-runtime-harness.ts";

function gate(phase: OrchestratorPhase, mirrorTarget: MirrorTargetVerdict) {
	return slotSyncGate({
		...evidence,
		receiptStateSha256: statusSha256,
		capabilities: { mode: "capable", features: ["slot-sync"] },
		phase,
		mirrorTarget,
	});
}

test("a bad inactive target invalidates a matching receipt for idle dispatch", () => {
	expect(gate("idle", "bad")).toEqual({ allowed: true });
});

test("a good inactive target keeps the matching receipt already-synced", () => {
	expect(gate("idle", "good")).toEqual({
		allowed: false,
		reason: "already-synced",
	});
});

for (const phase of [
	"os-staging",
	"os-staged",
	"os-activation-armed",
	"os-verifying",
] as const) {
	test(`a bad target never overrides pending OS phase ${phase}`, () => {
		expect(gate(phase, "bad")).toEqual({
			allowed: false,
			reason: "os-install-pending",
		});
	});
}

test("a bad target never overrides an already running mirror", () => {
	expect(gate("syncing", "bad")).toEqual({
		allowed: false,
		reason: "already-syncing",
	});
});

for (const verdict of ["not-target", "undecidable"] as const) {
	test(`a matching receipt with ${verdict} RAUC evidence refuses blind dispatch`, () => {
		expect(gate("idle", verdict)).toEqual({
			allowed: false,
			reason: "slot-identity-unknown",
		});
	});
}
