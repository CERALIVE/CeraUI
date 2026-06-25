import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	type ControlChannelLogger,
	type ControlSocket,
	initControlChannel,
} from "../modules/remote-control/channel.ts";
import { resetSharedSeenCidStore } from "../modules/remote-control/command-idempotency.ts";
import { routeCommand } from "../modules/remote-control/command-router.ts";
import {
	COMMAND_REGISTRY,
	type Command,
	HandshakeDeviceSchema,
	HandshakeSchema,
	type Result,
} from "../modules/remote-control/protocol.ts";
import {
	configureSetProfile,
	handleSetProfile,
	type ResolvedProfileConfig,
	resetSetProfile,
	type SetProfileCaps,
} from "../modules/remote-control/set-profile.ts";

const FIXED_CID = "11111111-1111-4111-8111-111111111111";

const silent: ControlChannelLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

const FULL_CAPS: SetProfileCaps = {
	supportedProfiles: [
		"balanced",
		"low-latency",
		"resilient",
		"classic",
		"low-latency-fec",
	],
	supportsFec: true,
	latencyRange: { min: 100, max: 5000 },
};

interface Harness {
	persisted: ResolvedProfileConfig[];
	reconnects: number;
	streaming: boolean;
}

function wireHarness(
	overrides: Partial<{
		caps: SetProfileCaps;
		active: { profile: ResolvedProfileConfig["presetId"]; latencyMs: number };
		streaming: boolean;
	}> = {},
): Harness {
	const h: Harness = { persisted: [], reconnects: 0, streaming: false };
	const streaming = overrides.streaming ?? false;
	h.streaming = streaming;
	configureSetProfile({
		getCaps: () => overrides.caps ?? FULL_CAPS,
		readActive: () =>
			overrides.active ?? { profile: "balanced", latencyMs: 1500 },
		persist: (config) => {
			h.persisted.push(config);
		},
		isStreaming: () => h.streaming,
		reconnect: () => {
			h.reconnects += 1;
			h.streaming = false;
		},
	});
	return h;
}

function makeConfig(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		presetId: "balanced",
		latencyMs: 1500,
		fecEnabled: false,
		recoveryMode: "standard",
		...overrides,
	};
}

function makePayload(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		commandId: FIXED_CID,
		config: makeConfig(),
		...overrides,
	};
}

beforeEach(() => {
	resetSetProfile();
	resetSharedSeenCidStore();
});

afterEach(async () => {
	resetSetProfile();
	resetSharedSeenCidStore();
	await initControlChannel({ canDial: () => false, logger: silent });
});

describe("device.setProfile — command registry", () => {
	test("device.setProfile is an advertised supportedType", async () => {
		const sent: string[] = [];
		const socket: ControlSocket = {
			send: (data) => sent.push(data),
			ping: () => {},
			close: () => {},
			onOpen: (l) => {
				queueMicrotask(l);
			},
			onClose: () => {},
			onMessage: () => {},
			onError: () => {},
		};
		await initControlChannel({
			canDial: () => true,
			resolveEndpoint: () => ({
				url: "wss://hub.example.test/ws",
				host: "hub.example.test",
				pinned: true,
			}),
			createSocket: () => socket,
			getControlToken: () => undefined,
			verifyToken: () => null,
			logger: silent,
			random: () => 1,
			setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
			clearTimer: () => {},
			setKeepalive: () => 0 as unknown as ReturnType<typeof setInterval>,
			clearKeepalive: () => {},
			uuid: () => FIXED_CID,
		});

		await Promise.resolve();
		const frame = HandshakeSchema.parse(JSON.parse(sent[0] ?? "{}"));
		const hello = HandshakeDeviceSchema.parse(frame.payload);
		expect(hello.supportedTypes).toContain("device.setProfile");
		expect([...COMMAND_REGISTRY]).toContain("device.setProfile");
	});
});

describe("handleSetProfile — apply path", () => {
	test("persists the config and acks applied with effective values", async () => {
		const h = wireHarness();
		const ack = await handleSetProfile(makePayload());

		expect(ack).not.toBeNull();
		expect(ack?.status).toBe("applied");
		expect(ack?.commandId).toBe(FIXED_CID);
		expect(ack?.effectiveActiveProfile).toBe("balanced");
		expect(ack?.effectiveLatencyMs).toBe(1500);
		expect(ack?.reason).toBeUndefined();
		expect(h.persisted).toEqual([
			{
				presetId: "balanced",
				latencyMs: 1500,
				fecEnabled: false,
				recoveryMode: "standard",
			},
		]);
	});

	test("does NOT reconnect when idle (persisted config applies on next start)", async () => {
		const h = wireHarness({ streaming: false });
		await handleSetProfile(makePayload());
		expect(h.reconnects).toBe(0);
	});

	test("reconnects (stop→start) when a stream is active", async () => {
		const h = wireHarness({ streaming: true });
		await handleSetProfile(
			makePayload({
				config: makeConfig({ presetId: "low-latency", latencyMs: 500 }),
			}),
		);
		expect(h.reconnects).toBe(1);
		expect(h.persisted[0]?.presetId).toBe("low-latency");
	});
});

describe("handleSetProfile — caps intersection (reject, never apply)", () => {
	test("rejects an unsupported preset without persisting", async () => {
		const h = wireHarness({
			caps: { ...FULL_CAPS, supportedProfiles: ["classic"] },
		});
		const ack = await handleSetProfile(
			makePayload({ config: makeConfig({ presetId: "resilient" }) }),
		);

		expect(ack?.status).toBe("rejected");
		expect(ack?.reason).toBe("profile_unsupported");
		expect(ack?.effectiveActiveProfile).toBe("balanced");
		expect(ack?.effectiveLatencyMs).toBe(1500);
		expect(h.persisted).toHaveLength(0);
		expect(h.reconnects).toBe(0);
	});

	test("rejects FEC when the engine cannot honour it", async () => {
		const h = wireHarness({ caps: { ...FULL_CAPS, supportsFec: false } });
		const ack = await handleSetProfile(
			makePayload({
				config: makeConfig({ presetId: "low-latency-fec", fecEnabled: true }),
			}),
		);

		expect(ack?.status).toBe("rejected");
		expect(ack?.reason).toBe("fec_unsupported");
		expect(h.persisted).toHaveLength(0);
	});

	test("clamps latency to the receiver window and still applies", async () => {
		const h = wireHarness();
		const ack = await handleSetProfile(
			makePayload({ config: makeConfig({ latencyMs: 99999 }) }),
		);

		expect(ack?.status).toBe("applied");
		expect(ack?.reason).toBe("latency_clamped");
		expect(ack?.effectiveLatencyMs).toBe(5000);
		expect(h.persisted[0]?.latencyMs).toBe(5000);
	});

	test("does NOT gate the preset when caps advertise no profile list", async () => {
		const h = wireHarness({
			caps: {
				supportedProfiles: undefined,
				supportsFec: true,
				latencyRange: undefined,
			},
		});
		const ack = await handleSetProfile(
			makePayload({ config: makeConfig({ presetId: "resilient" }) }),
		);

		expect(ack?.status).toBe("applied");
		expect(h.persisted[0]?.presetId).toBe("resilient");
	});
});

describe("handleSetProfile — idempotency", () => {
	test("re-applying the same commandId is a no-op returning the cached ack", async () => {
		const h = wireHarness();
		const first = await handleSetProfile(makePayload());
		const second = await handleSetProfile(makePayload());

		expect(second).toEqual(first);
		expect(h.persisted).toHaveLength(1);
		expect(h.reconnects).toBe(0);
	});

	test("a new commandId applies again", async () => {
		const h = wireHarness();
		await handleSetProfile(makePayload());
		const other = "22222222-2222-4222-8222-222222222222";
		await handleSetProfile(makePayload({ commandId: other }));
		expect(h.persisted).toHaveLength(2);
	});
});

describe("handleSetProfile — malformed payload", () => {
	test("returns null on a malformed payload (no commandId/config)", async () => {
		wireHarness();
		expect(await handleSetProfile({ commandId: FIXED_CID })).toBeNull();
		expect(await handleSetProfile({ foo: "bar" })).toBeNull();
	});
});

describe("routeCommand — device.setProfile result frame", () => {
	function makeCommand(payload: unknown): Command {
		return {
			v: 1,
			kind: "command",
			type: "device.setProfile",
			cid: FIXED_CID,
			payload: payload as Command["payload"],
		};
	}

	test("internal command applies BEFORE the owner gate (no role on frame)", async () => {
		wireHarness();
		const results: Result[] = [];
		await routeCommand(makeCommand(makePayload()), {
			sendResult: (frame) => {
				results.push(frame);
				return true;
			},
			sendDeliveryAck: () => true,
		});

		expect(results).toHaveLength(1);
		expect(results[0]?.type).toBe("device.setProfile");
		expect(results[0]?.cid).toBe(FIXED_CID);
		expect(results[0]?.payload.ok).toBe(true);
		expect(results[0]?.payload.applied).toMatchObject({
			status: "applied",
			effectiveActiveProfile: "balanced",
			effectiveLatencyMs: 1500,
		});
	});

	test("emits a delivery.ack before applying", async () => {
		wireHarness();
		const acks: { type: string; cid: string }[] = [];
		await routeCommand(makeCommand(makePayload()), {
			sendResult: () => true,
			sendDeliveryAck: (frame) => {
				acks.push({ type: frame.type, cid: frame.cid });
				return true;
			},
		});
		expect(acks).toEqual([{ type: "device.setProfile", cid: FIXED_CID }]);
	});

	test("a rejected profile surfaces ok:false + the reason on error", async () => {
		wireHarness({ caps: { ...FULL_CAPS, supportsFec: false } });
		const results: Result[] = [];
		await routeCommand(
			makeCommand(
				makePayload({
					config: makeConfig({ presetId: "low-latency-fec", fecEnabled: true }),
				}),
			),
			{
				sendResult: (frame) => {
					results.push(frame);
					return true;
				},
				sendDeliveryAck: () => true,
			},
		);

		expect(results[0]?.payload.ok).toBe(false);
		expect(results[0]?.payload.error).toBe("fec_unsupported");
		expect(results[0]?.payload.applied).toMatchObject({ status: "rejected" });
	});

	test("a malformed payload yields ok:false invalid_set_profile", async () => {
		wireHarness();
		const results: Result[] = [];
		await routeCommand(makeCommand({ commandId: FIXED_CID }), {
			sendResult: (frame) => {
				results.push(frame);
				return true;
			},
			sendDeliveryAck: () => true,
		});

		expect(results[0]?.payload.ok).toBe(false);
		expect(results[0]?.payload.error).toBe("invalid_set_profile");
	});
});
