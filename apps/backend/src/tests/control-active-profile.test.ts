import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import {
	type ActiveProfileReport,
	configureActiveProfileReporter,
	reportActiveProfile,
	resetActiveProfileReporter,
} from "../modules/remote-control/active-profile-reporter.ts";
import {
	ACTIVE_PROFILE_STATUS,
	STATUS_TYPES,
	StatusSchema,
} from "../modules/remote-control/protocol.ts";
import {
	type ControlChannel,
	isRelayable,
	RELAYABLE_TYPES,
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
import { broadcastMsg } from "../rpc/compat.ts";

const BALANCED: ActiveProfileReport = {
	presetId: "balanced",
	latencyMs: 2000,
	fecEnabled: false,
	recoveryMode: "standard",
};

/**
 * The platform's authoritative `device.activeProfile` payload shape mirrored
 * locally (Rule D: no cross-repo import). Kept field-for-field in sync with
 * ceralive-platform `ActiveProfilePayloadSchema` / `StreamConfigSchema` — the
 * config NESTS under a `config` key with exactly presetId/latencyMs/fecEnabled/
 * recoveryMode. A bare-config payload or `profileId` field must NOT satisfy it.
 */
const platformActiveProfilePayloadSchema = z.object({
	config: z.object({
		presetId: z.string().min(1),
		latencyMs: z.number().int().nonnegative(),
		fecEnabled: z.boolean(),
		recoveryMode: z.enum(["standard", "bandwidth-saver"]),
	}),
});

/** A fake control channel that records every frame it is asked to send. */
function makeChannel(connected = true): ControlChannel & { frames: unknown[] } {
	const frames: unknown[] = [];
	return {
		frames,
		isConnected: () => connected,
		sendFrame: (frame: unknown) => {
			frames.push(frame);
		},
	};
}

beforeEach(() => {
	resetActiveProfileReporter();
	resetStatusRelay();
});

afterEach(() => {
	resetActiveProfileReporter();
	resetStatusRelay();
});

describe("device.activeProfile — registry membership", () => {
	test("is an advertised status + relayable type", () => {
		expect([...STATUS_TYPES]).toContain("device.activeProfile");
		expect([...RELAYABLE_TYPES]).toContain("device.activeProfile");
		expect(isRelayable(ACTIVE_PROFILE_STATUS)).toBe(true);
		expect(ACTIVE_PROFILE_STATUS).toBe("device.activeProfile");
	});
});

describe("reportActiveProfile — emitted payload shape", () => {
	test("emits the config NESTED under payload.config with the four StreamConfig fields", () => {
		const captured: { type: string; data: unknown }[] = [];
		configureActiveProfileReporter({
			readActiveProfile: () => BALANCED,
			broadcast: (type, data) => captured.push({ type, data }),
		});

		const emitted = reportActiveProfile();

		expect(emitted).toBe(true);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.type).toBe("device.activeProfile");
		expect(captured[0]?.data).toEqual({
			config: {
				presetId: "balanced",
				latencyMs: 2000,
				fecEnabled: false,
				recoveryMode: "standard",
			},
		});
	});

	test("the emitted full relay frame parses as a spec §8 status frame nested under config", () => {
		configureActiveProfileReporter({
			readActiveProfile: () => BALANCED,
			broadcast: broadcastMsg,
		});
		const channel = makeChannel();
		setControlChannel(channel);

		reportActiveProfile();

		expect(channel.frames).toHaveLength(1);
		const frame = StatusSchema.parse(channel.frames[0]);
		expect(frame.v).toBe(1);
		expect(frame.kind).toBe("status");
		expect(frame.type).toBe("device.activeProfile");
		expect(typeof frame.cid).toBe("string");
		expect(Number.isInteger(frame.seq)).toBe(true);
		expect(frame.seq).toBeGreaterThanOrEqual(0);
		expect(frame.payload).toEqual({
			config: {
				presetId: "balanced",
				latencyMs: 2000,
				fecEnabled: false,
				recoveryMode: "standard",
			},
		});
		// The exact platform shape accepts the emitter's payload.
		expect(
			platformActiveProfilePayloadSchema.safeParse(frame.payload).success,
		).toBe(true);
	});
});

describe("reportActiveProfile — no-change de-dup (no spam)", () => {
	test("a second report with an unchanged config emits nothing", () => {
		const captured: unknown[] = [];
		configureActiveProfileReporter({
			readActiveProfile: () => BALANCED,
			broadcast: (_type, data) => captured.push(data),
		});

		expect(reportActiveProfile()).toBe(true);
		expect(reportActiveProfile()).toBe(false);
		expect(captured).toHaveLength(1);
	});

	test("a changed config emits again", () => {
		const captured: unknown[] = [];
		let current: ActiveProfileReport = BALANCED;
		configureActiveProfileReporter({
			readActiveProfile: () => current,
			broadcast: (_type, data) => captured.push(data),
		});

		expect(reportActiveProfile()).toBe(true);
		current = { ...BALANCED, presetId: "low-latency", latencyMs: 500 };
		expect(reportActiveProfile()).toBe(true);
		expect(captured).toHaveLength(2);
	});
});

describe("reportActiveProfile — reconnect force re-emit", () => {
	test("force re-emits an unchanged config (hub lost the snapshot on disconnect)", () => {
		const captured: unknown[] = [];
		configureActiveProfileReporter({
			readActiveProfile: () => BALANCED,
			broadcast: (_type, data) => captured.push(data),
		});

		expect(reportActiveProfile()).toBe(true);
		// Same config, but a (re)connect must re-seed the hub.
		expect(reportActiveProfile({ force: true })).toBe(true);
		expect(captured).toHaveLength(2);
	});
});

describe("device.activeProfile — negative shape guards", () => {
	test("a bare-config payload (no `config` nesting) FAILS the platform shape", () => {
		// The exact fields, but NOT nested under `config` — the platform silently
		// ignores this (drift never fires), so the emitter must never produce it.
		const bare = {
			presetId: "balanced",
			latencyMs: 2000,
			fecEnabled: false,
			recoveryMode: "standard",
		};
		expect(platformActiveProfilePayloadSchema.safeParse(bare).success).toBe(
			false,
		);
	});

	test("`profileId` instead of `presetId` FAILS the platform shape", () => {
		const wrongField = {
			config: {
				profileId: "balanced",
				latencyMs: 2000,
				fecEnabled: false,
				recoveryMode: "standard",
			},
		};
		expect(
			platformActiveProfilePayloadSchema.safeParse(wrongField).success,
		).toBe(false);
	});

	test("a status frame missing `seq` FAILS StatusSchema.parse", () => {
		const noSeq = {
			v: 1,
			kind: "status",
			type: "device.activeProfile",
			cid: "11111111-1111-4111-8111-111111111111",
			payload: { config: BALANCED },
		};
		expect(StatusSchema.safeParse(noSeq).success).toBe(false);
	});
});
