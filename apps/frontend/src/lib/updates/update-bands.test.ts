import {
	ORCHESTRATOR_PHASES,
	type StartFailure,
	type UpdateDetails,
	type UpdateOrchestratorWireState,
	type UpdateTransportFinding,
	type UpdateTransportProbeState,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	goLiveUpdateRefusal,
	transportCredentialsRejected,
} from "./update-bands";
import { UPDATE_REFUSING_PHASES } from "./update-view";

function wire(
	phase: UpdateOrchestratorWireState["phase"],
	progress: UpdateOrchestratorWireState["progress"] = null,
): UpdateOrchestratorWireState {
	return {
		schema: 1,
		phase,
		progress,
		failure_reason: null,
		cellular_override_id: null,
	};
}

function refusal(overrides: Partial<StartFailure> = {}): StartFailure {
	return {
		attemptId: "a-1",
		phase: "params",
		class: "update_in_progress",
		retriable: false,
		...overrides,
	};
}

function details(states: UpdateDetails["transport"]): UpdateDetails {
	return {
		slots: null,
		os: { bootedVersion: null, staged: null, candidate: null },
		checks: {
			packages: {
				lastAttemptAt: null,
				lastSuccessAt: null,
				nextAttemptAt: null,
			},
			os: { lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null },
		},
		pendingCellular: null,
		transport: states,
	};
}

describe("goLiveUpdateRefusal — the live orchestrator state wins", () => {
	it("refuses exactly in the phases stream admission refuses in", () => {
		for (const phase of ORCHESTRATOR_PHASES) {
			const band = goLiveUpdateRefusal(wire(phase), undefined);
			expect(band !== undefined, phase).toBe(
				UPDATE_REFUSING_PHASES.includes(phase),
			);
		}
	});

	it("carries the live phase, a whole percent and whole minutes", () => {
		expect(
			goLiveUpdateRefusal(
				wire("committing", { percent: 41.6, etaSeconds: 130 }),
				undefined,
			),
		).toEqual({
			phase: "committing",
			percent: 42,
			etaMinutes: 3,
			source: "live",
		});
	});

	it("never renders a zero ETA as a promise", () => {
		const band = goLiveUpdateRefusal(
			wire("restarting-services", { percent: 90, etaSeconds: 0 }),
			undefined,
		);
		expect(band?.etaMinutes).toBeUndefined();
	});

	it("drops a stale refusal once the live state has moved on", () => {
		expect(
			goLiveUpdateRefusal(
				wire("settled"),
				refusal({ updatePhase: "committing" }),
			),
		).toBeUndefined();
	});
});

describe("goLiveUpdateRefusal — an older backend without the pushed state", () => {
	it("falls back to the refusal the last start carried", () => {
		expect(
			goLiveUpdateRefusal(
				undefined,
				refusal({
					updatePhase: "committing",
					updatePercent: 150,
					updateEtaSeconds: 59,
				}),
			),
		).toEqual({
			phase: "committing",
			percent: 100,
			etaMinutes: 1,
			source: "refusal",
		});
	});

	it("renders nothing for any other failure class", () => {
		expect(
			goLiveUpdateRefusal(undefined, refusal({ class: "engine_unavailable" })),
		).toBeUndefined();
		expect(goLiveUpdateRefusal(undefined, undefined)).toBeUndefined();
	});

	it("keeps a refusal that named no phase honest about it", () => {
		expect(goLiveUpdateRefusal(null, refusal())).toEqual({
			phase: undefined,
			percent: undefined,
			etaMinutes: undefined,
			source: "refusal",
		});
	});
});

describe("transportCredentialsRejected", () => {
	const finding = (
		states: UpdateTransportProbeState[],
	): UpdateTransportFinding => ({
		ifname: "eth0",
		kind: "ethernet",
		family: 4,
		metered: false,
		healthy: false,
		captive: false,
		states,
	});

	it("is true only when a probe reported the certificate as rejected", () => {
		const base = {
			profile: "apt" as const,
			checkedAt: 1,
			status: "none" as const,
			selected: null,
		};
		expect(
			transportCredentialsRejected(
				details({ ...base, findings: [finding(["credentials-invalid"])] }),
			),
		).toBe(true);
		expect(
			transportCredentialsRejected(
				details({ ...base, findings: [finding(["no-route"])] }),
			),
		).toBe(false);
	});

	it("claims nothing when no selection has been recorded", () => {
		expect(transportCredentialsRejected(details(null))).toBe(false);
		expect(transportCredentialsRejected(undefined)).toBe(false);
	});
});
