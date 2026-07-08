/**
 * Contract test for the Remote Control Plane v2.0 wire envelope (device side).
 *
 * The conformance vectors are now sourced from the canonical
 * `@ceralive/control-protocol` package (`/fixtures` — the §14 JSON vectors,
 * verbatim, with the two documented spec.md defects corrected). CeraUI consumes
 * the package as a pinned CalVer registry dependency, so these vectors resolve
 * standalone in CI without needing the `ceralive/` workspace parent or `openspec/`
 * checked out (Rule-D-compatible — a registry dep, not a `../` path reference).
 *
 * The SCHEMAS under test are the device's own re-exports from `./protocol.ts` —
 * the DEVICE-TOLERANT variants of the shared package. Each fixture is asserted to
 * parse with its matching device schema; invalid frames (missing `v`, unknown
 * `kind`) are asserted to reject with a ZodError.
 */

import { describe, expect, it } from "bun:test";
import {
	FIXTURE_14_1,
	FIXTURE_14_2,
	FIXTURE_14_3,
	FIXTURE_14_4,
	FIXTURE_14_5,
	FIXTURE_14_6,
	FIXTURE_14_7,
	FIXTURE_14_8,
	FIXTURE_14_9,
	FIXTURE_14_10,
	FIXTURE_14_11,
	FIXTURE_14_12,
	FIXTURE_14_13,
	FIXTURE_14_14,
	FIXTURE_14_17,
} from "@ceralive/control-protocol/fixtures";
import { ZodError } from "zod";

import {
	AckSchema,
	CommandSchema,
	DeliveryAckSchema,
	EnvelopeSchema,
	FrameSchema,
	HandshakeDeviceSchema,
	HandshakeHubSchema,
	HandshakeSchema,
	ResultSchema,
	StatusSchema,
} from "./protocol.ts";

// ── Device-specific safe-rollout variant (NOT a §14 package fixture) ───────────

/** §14.2 variant — a not-yet-updated device omits the version caps (safe-rollout tolerance). */
const FIXTURE_14_2_NO_VERSION = {
	v: 1,
	kind: "handshake",
	type: "device.hello",
	cid: "1a4d8f02-7c3e-4b1a-9e2d-5f6a7b8c9d0e",
	payload: {
		v: 1,
		supportedTypes: ["streaming.start", "streaming.stop"],
		deviceCaps: {
			engine: "cerastream",
		},
	},
} as const;

describe("control-plane protocol — §14 wire fixtures parse", () => {
	it("§14.1 minimal valid envelope parses as base Envelope and Command", () => {
		expect(EnvelopeSchema.parse(FIXTURE_14_1)).toMatchObject({
			v: 1,
			kind: "command",
		});
		expect(CommandSchema.parse(FIXTURE_14_1).type).toBe("streaming.getConfig");
	});

	it("§14.2 device hello parses as Handshake frame + HandshakeDevice body", () => {
		const frame = HandshakeSchema.parse(FIXTURE_14_2);
		expect(frame.type).toBe("device.hello");
		const body = HandshakeDeviceSchema.parse(frame.payload);
		expect(body.v).toBe(1);
		expect(body.supportedTypes).toContain("self_fencing.confirm");
		expect(body.deviceCaps.engine).toBe("cerastream");
		expect(body.deviceCaps.ceraui_version).toBe("2026.6.1");
		expect(body.deviceCaps.config_schema_version).toBe(3);
	});

	it("§4.1 device hello tolerates a hello omitting the version caps (safe rollout)", () => {
		const body = HandshakeDeviceSchema.parse(FIXTURE_14_2_NO_VERSION.payload);
		expect(body.deviceCaps.ceraui_version).toBeUndefined();
		expect(body.deviceCaps.config_schema_version).toBeUndefined();
		expect(body.deviceCaps.engine).toBe("cerastream");
	});

	it("§4.1 device hello rejects a non-integer config_schema_version", () => {
		const bad = {
			...FIXTURE_14_2.payload,
			deviceCaps: {
				...FIXTURE_14_2.payload.deviceCaps,
				config_schema_version: 1.5,
			},
		};
		expect(HandshakeDeviceSchema.safeParse(bad).success).toBe(false);
	});

	it("§14.3 hub hello parses as Handshake frame + HandshakeHub body", () => {
		const frame = HandshakeSchema.parse(FIXTURE_14_3);
		const body = HandshakeHubSchema.parse(frame.payload);
		expect(body.role).toBe("owner");
	});

	it("§14.4 version.mismatch parses as Ack", () => {
		expect(AckSchema.parse(FIXTURE_14_4).type).toBe("version.mismatch");
	});

	it("§14.5 streaming.getConfig command parses (empty payload)", () => {
		expect(CommandSchema.parse(FIXTURE_14_5).payload).toEqual({});
	});

	it("§14.6 streaming.setBitrate command parses", () => {
		const cmd = CommandSchema.parse(FIXTURE_14_6);
		expect(cmd.payload?.bitrate_bps).toBe(6000000);
	});

	it("§14.7 success result parses with applied object", () => {
		const res = ResultSchema.parse(FIXTURE_14_7);
		expect(res.payload.ok).toBe(true);
		expect(res.payload.applied).toMatchObject({ max_br: 8000 });
	});

	it("§14.8 error result parses with applied:null + error code", () => {
		const res = ResultSchema.parse(FIXTURE_14_8);
		expect(res.payload.ok).toBe(false);
		expect(res.payload.applied).toBeNull();
		expect(res.payload.error).toBe("not_streaming");
	});

	it("§14.9 self_fencing command reads self_fencing off the top level", () => {
		const cmd = CommandSchema.parse(FIXTURE_14_9);
		expect(cmd.self_fencing).toBe(true);
		expect(cmd.type).toBe("network.reconfig");
	});

	it("§14.10 self_fencing.confirm command parses with no payload", () => {
		const cmd = CommandSchema.parse(FIXTURE_14_10);
		expect(cmd.type).toBe("self_fencing.confirm");
		expect(cmd.payload).toBeUndefined();
	});

	it("§14.11 auto-reverted result carries reverted:true", () => {
		const res = ResultSchema.parse(FIXTURE_14_11);
		expect(res.payload.reverted).toBe(true);
	});

	it("§14.12 non-revertible self_fencing command parses with no payload", () => {
		const cmd = CommandSchema.parse(FIXTURE_14_12);
		expect(cmd.self_fencing).toBe(true);
		expect(cmd.payload).toBeUndefined();
	});

	it("§14.13 status frame requires and parses seq", () => {
		const status = StatusSchema.parse(FIXTURE_14_13);
		expect(status.seq).toBe(42);
	});

	it("§14.14 forbidden command ack parses", () => {
		const ack = AckSchema.parse(FIXTURE_14_14);
		expect(ack.type).toBe("command.forbidden");
	});

	it("§14.17 delivery ack parses and echoes the command type + cid", () => {
		const ack = DeliveryAckSchema.parse(FIXTURE_14_17);
		expect(ack.kind).toBe("delivery.ack");
		expect(ack.type).toBe("streaming.setConfig");
		expect(ack.cid).toBe("9b2c5e7a-1f3d-4a8b-bc6e-2d4f6a8c0e12");
	});

	it("every frame fixture routes through the FrameSchema discriminated union", () => {
		const frameFixtures = [
			FIXTURE_14_1,
			FIXTURE_14_2,
			FIXTURE_14_3,
			FIXTURE_14_4,
			FIXTURE_14_5,
			FIXTURE_14_6,
			FIXTURE_14_7,
			FIXTURE_14_8,
			FIXTURE_14_9,
			FIXTURE_14_10,
			FIXTURE_14_11,
			FIXTURE_14_12,
			FIXTURE_14_13,
			FIXTURE_14_14,
			FIXTURE_14_17,
		];
		for (const fixture of frameFixtures) {
			expect(() => FrameSchema.parse(fixture)).not.toThrow();
		}
	});
});

describe("control-plane protocol — invalid frames reject", () => {
	it("rejects an envelope missing `v`", () => {
		const { v: _omitted, ...missingV } = FIXTURE_14_1;
		const result = EnvelopeSchema.safeParse(missingV);
		expect(result.success).toBe(false);
		expect(() => EnvelopeSchema.parse(missingV)).toThrow(ZodError);
	});

	it("rejects an unknown `kind`", () => {
		const badKind = { ...FIXTURE_14_1, kind: "frobnicate" };
		expect(EnvelopeSchema.safeParse(badKind).success).toBe(false);
		expect(() => FrameSchema.parse(badKind)).toThrow(ZodError);
	});

	it("rejects a wrong protocol version `v`", () => {
		const badVersion = { ...FIXTURE_14_1, v: 2 };
		expect(EnvelopeSchema.safeParse(badVersion).success).toBe(false);
	});

	it("rejects a non-UUID cid", () => {
		const badCid = { ...FIXTURE_14_1, cid: "not-a-uuid" };
		expect(EnvelopeSchema.safeParse(badCid).success).toBe(false);
	});

	it("rejects a status frame missing seq", () => {
		const { seq: _omitted, ...missingSeq } = FIXTURE_14_13;
		expect(StatusSchema.safeParse(missingSeq).success).toBe(false);
	});

	it("rejects a result frame missing the required ok flag", () => {
		const badResult = {
			...FIXTURE_14_7,
			payload: { applied: null },
		};
		expect(ResultSchema.safeParse(badResult).success).toBe(false);
	});
});
