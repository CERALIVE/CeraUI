/*
 * `sharing_diag` reaching rendered frontend state.
 *
 * Driven through the REAL `subscriptions.svelte.ts` handler, not a hand-built
 * store write: `initSubscriptions` registers ONE `onMessage` consumer whose
 * switch silently drops an unregistered topic, so a schema, an event and a
 * post-login emission can all be in place while the payload never reaches a
 * getter. That gap is invisible to a producer-only test.
 *
 * Every payload here is first parsed by the SHARED `sharingDiagSchema`, so a
 * case cannot drift into a shape the device could never send.
 */
import { sharingDiagSchema } from "@ceraui/rpc/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";

let messageHandler:
	| ((type: string, data: unknown, seq?: number) => void)
	| undefined;

vi.mock("$lib/rpc/client", () => ({
	rpc: {},
	rpcClient: {
		onMessage: (
			handler: (type: string, data: unknown, seq?: number) => void,
		) => {
			messageHandler = handler;
		},
		onConnectionChange: () => undefined,
		connect: () => undefined,
		getSocket: () => undefined,
		sendLegacy: () => undefined,
	},
}));

import {
	getSharingDiag,
	initSubscriptions,
	resetState,
} from "$lib/rpc/subscriptions.svelte";

const HEALTHY = sharingDiagSchema.parse({
	state: "ok",
	checkedAt: 1_700_000_000_000,
	firewallBackend: { state: "ok" },
	steeringRules: { state: "ok" },
	sharedNat: { state: "ok" },
	foreignTables: { state: "ok" },
});

const SHADOWED = sharingDiagSchema.parse({
	state: "degraded",
	checkedAt: 1_700_000_030_000,
	firewallBackend: { state: "ok" },
	steeringRules: {
		state: "degraded",
		reason: "steering_rule_shadows_source_route",
		detail:
			"steering rules at priority 90 run at or before source routing (100)",
	},
	sharedNat: { state: "ok" },
	foreignTables: { state: "unknown" },
});

describe("sharing_diag broadcast ingestion", () => {
	beforeEach(() => {
		resetState();
		initSubscriptions();
	});

	it("is undefined until a snapshot arrives — absence is not a clean bill", () => {
		expect(getSharingDiag()).toBeUndefined();
	});

	it("reaches frontend state through the real subscription handler", () => {
		messageHandler?.("sharing_diag", HEALTHY);

		expect(getSharingDiag()?.state).toBe("ok");
		expect(getSharingDiag()?.steeringRules.state).toBe("ok");
	});

	it("surfaces a shadowed-rule device as degraded, with its typed reason", () => {
		messageHandler?.("sharing_diag", SHADOWED);

		const diag = getSharingDiag();
		expect(diag?.state).toBe("degraded");
		expect(diag?.steeringRules.reason).toBe(
			"steering_rule_shadows_source_route",
		);
		expect(diag?.foreignTables.state).toBe("unknown");
	});

	it("REPLACES the payload wholesale — a check can go back to ok", () => {
		// A field-preserving merge would latch `degraded` here, which is the
		// `policy_route_missing` defect this signal's explicit tri-states exist to
		// prevent.
		messageHandler?.("sharing_diag", SHADOWED);
		messageHandler?.("sharing_diag", HEALTHY);

		expect(getSharingDiag()?.state).toBe("ok");
		expect(getSharingDiag()?.steeringRules.reason).toBeUndefined();
		expect(getSharingDiag()?.foreignTables.state).toBe("ok");
	});

	it("is cleared by resetState so a logout leaves no stale verdict", () => {
		messageHandler?.("sharing_diag", HEALTHY);
		resetState();

		expect(getSharingDiag()).toBeUndefined();
	});
});
