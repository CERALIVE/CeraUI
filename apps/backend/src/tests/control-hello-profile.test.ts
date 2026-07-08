/**
 * device.hello profile advertisement — `deviceCaps.preferred_profile` +
 * `deviceCaps.profile_catalog_version` (coherence-contract-pass, todo 10).
 *
 * The device advertises its persisted `stream_profile` (as `preferred_profile`)
 * and the engine's advertised `profile_catalog_version` in the hello's
 * `deviceCaps`, so the hub can seed SRT-receive-profile reconciliation (spec
 * §4.3). Both are ADDITIVE-OPTIONAL: emitted only when their underlying value is
 * known, OMITTED (never null-filled) otherwise. Schema truth is the
 * `@ceralive/control-protocol` package; this suite proves the emitted frame is
 * accepted by the hub's own `strictParseFrame` in BOTH variants.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { strictParseFrame } from "@ceralive/control-protocol/parse";

import {
	type ControlChannelDeps,
	type ControlChannelLogger,
	type ControlSocket,
	initControlChannel,
} from "../modules/remote-control/channel.ts";
import {
	HandshakeDeviceSchema,
	HandshakeSchema,
} from "../modules/remote-control/protocol.ts";

const HUB_URL = "wss://hub.example.test/ws/control";
const HUB_HOST = "hub.example.test";
// A conformant UUID v4 (version nibble 4, variant nibble 8): the hub's strict
// envelope validates `cid` with `z.uuidv4()`, so the emitted hello must carry a
// real v4 for the round-trip assertion below.
const FIXED_CID = "11111111-1111-4111-8111-111111111111";

const silent: ControlChannelLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

interface FakeSocket {
	socket: ControlSocket;
	sent: string[];
	fireOpen: () => void;
}

function makeFakeSocket(): FakeSocket {
	const openListeners: Array<() => void> = [];
	const sent: string[] = [];
	const socket: ControlSocket = {
		send: (data) => sent.push(data),
		ping: () => {},
		close: () => {},
		onOpen: (listener) => openListeners.push(listener),
		onClose: () => {},
		onMessage: () => {},
		onError: () => {},
	};
	return {
		socket,
		sent,
		fireOpen: () => {
			for (const listener of openListeners) listener();
		},
	};
}

function harness(overrides: Partial<ControlChannelDeps> = {}): {
	deps: Partial<ControlChannelDeps>;
	sockets: FakeSocket[];
} {
	const sockets: FakeSocket[] = [];
	const deps: Partial<ControlChannelDeps> = {
		canDial: () => true,
		resolveEndpoint: () => ({ url: HUB_URL, host: HUB_HOST, pinned: true }),
		createSocket: () => {
			const fake = makeFakeSocket();
			sockets.push(fake);
			return fake.socket;
		},
		getControlToken: () => undefined,
		verifyToken: () => null,
		getConfig: () => ({}) as ReturnType<ControlChannelDeps["getConfig"]>,
		getProfileCatalogVersion: () => undefined,
		logger: silent,
		random: () => 1,
		setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
		clearTimer: () => {},
		setKeepalive: () => 0 as unknown as ReturnType<typeof setInterval>,
		clearKeepalive: () => {},
		uuid: () => FIXED_CID,
		...overrides,
	};
	return { deps, sockets };
}

/** Drive the channel to open and return the parsed hello frame it emitted. */
async function emitHello(
	overrides: Partial<ControlChannelDeps>,
): Promise<{ deviceCaps: Record<string, unknown>; raw: unknown }> {
	const h = harness(overrides);
	await initControlChannel(h.deps);
	h.sockets[0]?.fireOpen();
	const raw = JSON.parse(h.sockets[0]?.sent[0] ?? "{}");
	const frame = HandshakeSchema.parse(raw);
	const hello = HandshakeDeviceSchema.parse(frame.payload);
	return { deviceCaps: hello.deviceCaps, raw };
}

// The channel is a process-wide singleton; reset to the gated floor before each
// case so a paired socket never leaks between tests.
beforeEach(async () => {
	await initControlChannel({ canDial: () => false, logger: silent });
});

describe("device.hello profile advertisement", () => {
	test("carries BOTH preferred_profile and profile_catalog_version when config + caps provide them", async () => {
		const { deviceCaps } = await emitHello({
			getConfig: () =>
				({ stream_profile: "low-latency" }) as ReturnType<
					ControlChannelDeps["getConfig"]
				>,
			getProfileCatalogVersion: () => "1.0.0",
		});

		expect(deviceCaps.preferred_profile).toBe("low-latency");
		expect(deviceCaps.profile_catalog_version).toBe("1.0.0");
	});

	test("OMITS both fields when config has no stream_profile and no catalog version is known", async () => {
		const { deviceCaps } = await emitHello({
			getConfig: () => ({}) as ReturnType<ControlChannelDeps["getConfig"]>,
			getProfileCatalogVersion: () => undefined,
		});

		expect("preferred_profile" in deviceCaps).toBe(false);
		expect("profile_catalog_version" in deviceCaps).toBe(false);
		expect(deviceCaps).toEqual({});
	});

	test("emits each field independently (preferred_profile without a catalog version)", async () => {
		const { deviceCaps } = await emitHello({
			getConfig: () =>
				({ stream_profile: "resilient" }) as ReturnType<
					ControlChannelDeps["getConfig"]
				>,
			getProfileCatalogVersion: () => undefined,
		});

		expect(deviceCaps.preferred_profile).toBe("resilient");
		expect("profile_catalog_version" in deviceCaps).toBe(false);
	});

	test("coexists with receiverKind (media destination + both profile facts)", async () => {
		const { deviceCaps } = await emitHello({
			getConfig: () =>
				({
					remote_provider: "ceralive",
					relay_server: "ceralive:0",
					stream_profile: "balanced",
				}) as ReturnType<ControlChannelDeps["getConfig"]>,
			getProfileCatalogVersion: () => "2.1.0",
		});

		expect(deviceCaps.receiverKind).toBe("ceralive");
		expect(deviceCaps.preferred_profile).toBe("balanced");
		expect(deviceCaps.profile_catalog_version).toBe("2.1.0");
	});
});

describe("hub strictParseFrame accepts the emitted hello (round-trip)", () => {
	test("accepts a hello carrying both preferred_profile and profile_catalog_version", async () => {
		const { raw } = await emitHello({
			getConfig: () =>
				({ stream_profile: "low-latency" }) as ReturnType<
					ControlChannelDeps["getConfig"]
				>,
			getProfileCatalogVersion: () => "1.0.0",
		});

		const strict = strictParseFrame(raw);
		expect(strict.kind).toBe("handshake");
		expect(strict.type).toBe("device.hello");
	});

	test("accepts a hello that omits both fields (additive-optional — never required)", async () => {
		const { raw } = await emitHello({
			getConfig: () => ({}) as ReturnType<ControlChannelDeps["getConfig"]>,
			getProfileCatalogVersion: () => undefined,
		});

		expect(() => strictParseFrame(raw)).not.toThrow();
	});
});
