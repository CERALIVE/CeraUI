/**
 * Device-side frame-exchange contract test (mirror of ceralive-platform's hub-side
 * frame-exchange suite — coherence-contract-pass todo 7).
 *
 * This proves the DEVICE half of the shared-package contract: the device's
 * TOLERANT parser (`tolerantParse*`, re-exported from `./protocol.ts`) accepts
 * every frame shape the HUB's STRICT parser emits — the §14 conformance vectors
 * shipped by `@ceralive/control-protocol/fixtures`. The two consumers exchange
 * these exact vectors, so a device that tolerantly parses all of them can never
 * reject a well-formed hub frame.
 *
 * The three invariants under test (the same the package's own skew-policy suite
 * enforces, checked here against the DEVICE re-export surface):
 *
 *   1. tolerant accepts every hub-strict-emitted §14 frame fixture;
 *   2. v1-minimal — a frame carrying ONLY the required envelope fields (and no
 *      post-v1 optional field) is accepted by the tolerant parser AND is never
 *      rejected by the strict parser;
 *   3. unknown-field tolerance — unknown top-level keys are stripped, unknown
 *      payload keys are preserved, and an additively-extended hub (a NEW command
 *      `type`) is accepted by the device even though the strict hub parser rejects
 *      it (the deliberate strict/tolerant asymmetry).
 */

import { describe, expect, it } from "bun:test";

import {
	FIXTURE_14_1,
	FIXTURE_14_5,
	FRAME_FIXTURES,
} from "@ceralive/control-protocol/fixtures";
// The hub/STRICT reference parser — used ONLY to demonstrate the v1-minimal +
// asymmetry invariants against the device's tolerant lane. The device itself never
// imports the strict parser (it has no strict posture); it lives in the package.
import { strictParseFrame } from "@ceralive/control-protocol/parse";

// The DEVICE's tolerant parsers, exactly as the device code imports them.
import {
	tolerantParseCommand,
	tolerantParseFrame,
	tolerantParseFrameSafe,
} from "./protocol.ts";

describe("device frame exchange — tolerant parser accepts hub-strict-emitted fixtures", () => {
	it("accepts every §14 frame fixture the hub emits through the tolerant parser", () => {
		const entries = Object.entries(FRAME_FIXTURES);
		expect(entries.length).toBeGreaterThanOrEqual(20);
		for (const [id, fixture] of entries) {
			expect(
				tolerantParseFrameSafe(fixture).success,
				`tolerant parser must accept hub fixture ${id}`,
			).toBe(true);
		}
	});
});

describe("device frame exchange — v1-minimal", () => {
	it("v1-minimal frame (required envelope fields only) is accepted by the tolerant parser", () => {
		// §14.1 is the canonical v1-minimal command: {v, kind, type, cid} with NO
		// post-v1 optional field (no payload/role/seq/self_fencing).
		expect(() => tolerantParseFrame(FIXTURE_14_1)).not.toThrow();
	});

	it("v1-minimal frame is never rejected by the strict parser (additive-optional-forever invariant)", () => {
		// The strict (hub) parser adds closed enums + closed sub-shapes, but MUST
		// NOT require a field the tolerant parser treats as optional — so the same
		// v1-minimal vector both sides exchange parses under BOTH postures.
		expect(() => strictParseFrame(FIXTURE_14_1)).not.toThrow();

		const handBuiltMinimal = {
			v: 1,
			kind: "command",
			type: "streaming.getConfig",
			cid: crypto.randomUUID(),
		};
		expect(tolerantParseFrameSafe(handBuiltMinimal).success).toBe(true);
		expect(() => strictParseFrame(handBuiltMinimal)).not.toThrow();
	});
});

describe("device frame exchange — unknown-field tolerance", () => {
	it("unknown-field tolerance: unknown top-level keys are stripped, unknown payload keys preserved", () => {
		const withUnknown = {
			...FIXTURE_14_5,
			futureTopLevelField: "ignore-me",
			payload: { ...FIXTURE_14_5.payload, futurePayloadField: 123 },
		};

		const parsed = tolerantParseCommand(withUnknown);
		// Unknown TOP-LEVEL keys are stripped by the envelope object (forward compat).
		expect(
			(parsed as Record<string, unknown>).futureTopLevelField,
		).toBeUndefined();
		// Unknown PAYLOAD keys survive (payload is an open record — forward compat).
		expect(parsed.payload?.futurePayloadField).toBe(123);
		// The whole-frame tolerant parse also accepts the extended frame.
		expect(tolerantParseFrameSafe(withUnknown).success).toBe(true);
	});

	it("unknown-field tolerance: an additively-extended hub (a new command `type`) is accepted by the device but rejected by the strict hub parser", () => {
		// A future hub adds a command `type` this device firmware does not yet know.
		// The device tolerates it (routes by `kind` only); the strict hub parser
		// closes `type` to the registry and rejects it. This is the deliberate,
		// contract-preserved strict/tolerant asymmetry.
		const futureCommand = {
			v: 1,
			kind: "command",
			type: "streaming.futureCommand",
			cid: crypto.randomUUID(),
			payload: {},
		};
		expect(tolerantParseFrameSafe(futureCommand).success).toBe(true);
		expect(() => tolerantParseCommand(futureCommand)).not.toThrow();
		expect(() => strictParseFrame(futureCommand)).toThrow();
	});
});
