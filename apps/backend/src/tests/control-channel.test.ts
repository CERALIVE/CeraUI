import { beforeEach, describe, expect, test } from "bun:test";

import {
	backoffDelay,
	type ControlChannelDeps,
	type ControlChannelLogger,
	type ControlSocket,
	deriveReceiverKind,
	initControlChannel,
	isConnected,
	RECONNECT_BASE_MS,
	RECONNECT_MAX_MS,
	sendFrame,
} from "../modules/remote-control/channel.ts";
import {
	COMMAND_REGISTRY,
	type Frame,
	HandshakeDeviceSchema,
	HandshakeSchema,
} from "../modules/remote-control/protocol.ts";

const HUB_URL = "wss://hub.example.test/ws/control";
const HUB_HOST = "hub.example.test";
const FIXED_CID = "11111111-1111-4111-8111-111111111111";

const silent: ControlChannelLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

interface FakeSocket {
	socket: ControlSocket;
	url: string;
	authToken: string | undefined;
	sent: string[];
	fireOpen: () => void;
	fireClose: () => void;
}

function makeFakeSocket(
	url: string,
	authToken: string | undefined,
): FakeSocket {
	const openListeners: Array<() => void> = [];
	const closeListeners: Array<() => void> = [];
	const sent: string[] = [];
	const socket: ControlSocket = {
		send: (data) => sent.push(data),
		ping: () => {},
		close: () => {},
		onOpen: (listener) => openListeners.push(listener),
		onClose: (listener) => closeListeners.push(listener),
		onMessage: () => {},
		onError: () => {},
	};
	return {
		socket,
		url,
		authToken,
		sent,
		fireOpen: () => {
			for (const listener of openListeners) listener();
		},
		fireClose: () => {
			for (const listener of closeListeners) listener();
		},
	};
}

interface CapturedTimer {
	fn: () => void;
	ms: number;
}

interface Harness {
	deps: Partial<ControlChannelDeps>;
	sockets: FakeSocket[];
	timers: CapturedTimer[];
}

function harness(overrides: Partial<ControlChannelDeps> = {}): Harness {
	const sockets: FakeSocket[] = [];
	const timers: CapturedTimer[] = [];
	let timerId = 0;
	let keepaliveId = 0;

	const deps: Partial<ControlChannelDeps> = {
		canDial: () => true,
		resolveEndpoint: () => ({ url: HUB_URL, host: HUB_HOST, pinned: true }),
		createSocket: (url, authToken) => {
			const fake = makeFakeSocket(url, authToken);
			sockets.push(fake);
			return fake.socket;
		},
		getControlToken: () => undefined,
		verifyToken: () => null,
		getConfig: () => ({}),
		logger: silent,
		// random=1 makes the equal-jitter backoff land at its upper bound (= cap)
		// so the per-attempt delay is deterministic for assertions.
		random: () => 1,
		setTimer: (fn, ms) => {
			timers.push({ fn, ms });
			timerId += 1;
			return timerId as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: () => {},
		setKeepalive: () => {
			keepaliveId += 1;
			return keepaliveId as unknown as ReturnType<typeof setInterval>;
		},
		clearKeepalive: () => {},
		uuid: () => FIXED_CID,
		...overrides,
	};

	return { deps, sockets, timers };
}

// The channel is a process-wide singleton; tear it down to the gated floor
// before each case so a paired socket never leaks into the next test.
beforeEach(async () => {
	await initControlChannel({ canDial: () => false, logger: silent });
});

describe("control channel gating", () => {
	test("unpaired device does not dial (gated)", async () => {
		const h = harness({ canDial: () => false });
		await initControlChannel(h.deps);

		expect(h.sockets.length).toBe(0);
		expect(isConnected()).toBe(false);
	});
});

describe("control channel when paired", () => {
	test("dials the pinned hub url from resolveControlChannelEndpoint", async () => {
		const h = harness();
		await initControlChannel(h.deps);

		expect(h.sockets.length).toBe(1);
		expect(h.sockets[0]?.url).toBe(HUB_URL);
	});

	test("sends the device.hello handshake on connect", async () => {
		const h = harness();
		await initControlChannel(h.deps);
		const socket = h.sockets[0];
		expect(socket).toBeDefined();
		expect(socket?.sent.length).toBe(0);

		socket?.fireOpen();

		expect(socket?.sent.length).toBe(1);
		const frame = HandshakeSchema.parse(JSON.parse(socket?.sent[0] ?? "{}"));
		expect(frame.kind).toBe("handshake");
		expect(frame.type).toBe("device.hello");

		const hello = HandshakeDeviceSchema.parse(frame.payload);
		expect(hello.supportedTypes).toEqual([...COMMAND_REGISTRY]);
		expect(hello.deviceCaps).toEqual({});
		expect(isConnected()).toBe(true);
	});

	test("reconnects with exponential backoff on disconnect", async () => {
		const h = harness();
		await initControlChannel(h.deps);
		expect(h.sockets.length).toBe(1);

		h.sockets[0]?.fireClose();
		expect(h.timers.length).toBe(1);
		const firstDelay = h.timers[0]?.ms ?? 0;
		expect(firstDelay).toBeGreaterThanOrEqual(RECONNECT_BASE_MS / 2);
		expect(firstDelay).toBeLessThanOrEqual(RECONNECT_MAX_MS);

		h.timers[0]?.fn();
		expect(h.sockets.length).toBe(2);

		h.sockets[1]?.fireClose();
		expect(h.timers.length).toBe(2);
		expect(h.timers[1]?.ms ?? 0).toBeGreaterThan(firstDelay);
	});

	test("sendFrame is a no-op before connect and after disconnect", async () => {
		const h = harness();
		await initControlChannel(h.deps);
		const frame: Frame = {
			v: 1,
			kind: "status",
			type: "status",
			cid: FIXED_CID,
			seq: 0,
			payload: {},
		};

		expect(sendFrame(frame)).toBe(false);

		h.sockets[0]?.fireOpen();
		expect(sendFrame(frame)).toBe(true);

		h.sockets[0]?.fireClose();
		expect(sendFrame(frame)).toBe(false);
	});
});

describe("deriveReceiverKind (media-destination derivation)", () => {
	test("relay_server present + remote_provider=ceralive → 'ceralive'", () => {
		expect(
			deriveReceiverKind({
				remote_provider: "ceralive",
				relay_server: "ceralive:0",
			}),
		).toBe("ceralive");
	});

	test("selected_ingest_endpoint present + remote_provider=belabox → 'belabox'", () => {
		expect(
			deriveReceiverKind({
				remote_provider: "belabox",
				selected_ingest_endpoint: "ep-123",
			}),
		).toBe("belabox");
	});

	test("srtla_addr present (no relay/ingest) → 'custom'", () => {
		expect(deriveReceiverKind({ srtla_addr: "203.0.113.7" })).toBe("custom");
	});

	test("nothing set → undefined (omitted)", () => {
		expect(deriveReceiverKind({})).toBeUndefined();
	});

	// Round-3 fix: a CeraLive-paired device streaming media to a manual custom
	// endpoint must report 'custom', not 'ceralive', or the platform would push
	// it FEC/L1 for a receiver that is actually custom.
	test("remote_provider=ceralive + srtla_addr only → 'custom'", () => {
		expect(
			deriveReceiverKind({
				remote_provider: "ceralive",
				srtla_addr: "203.0.113.7",
			}),
		).toBe("custom");
	});
});

describe("device.hello receiverKind emission", () => {
	test("emits deviceCaps.receiverKind from the media destination", async () => {
		const h = harness({
			getConfig: () => ({
				remote_provider: "ceralive",
				relay_server: "ceralive:0",
			}),
		});
		await initControlChannel(h.deps);
		h.sockets[0]?.fireOpen();

		const frame = HandshakeSchema.parse(
			JSON.parse(h.sockets[0]?.sent[0] ?? "{}"),
		);
		const hello = HandshakeDeviceSchema.parse(frame.payload);
		expect(hello.deviceCaps.receiverKind).toBe("ceralive");
	});

	test("omits receiverKind when not derivable", async () => {
		const h = harness({ getConfig: () => ({}) });
		await initControlChannel(h.deps);
		h.sockets[0]?.fireOpen();

		const frame = HandshakeSchema.parse(
			JSON.parse(h.sockets[0]?.sent[0] ?? "{}"),
		);
		const hello = HandshakeDeviceSchema.parse(frame.payload);
		expect(hello.deviceCaps).toEqual({});
		expect("receiverKind" in hello.deviceCaps).toBe(false);
	});
});

describe("backoff", () => {
	test("grows exponentially and is capped at the max", () => {
		const upper = () => 1;
		expect(backoffDelay(0, upper)).toBe(RECONNECT_BASE_MS);
		expect(backoffDelay(1, upper)).toBe(2 * RECONNECT_BASE_MS);
		expect(backoffDelay(100, upper)).toBe(RECONNECT_MAX_MS);
		expect(backoffDelay(0, () => 0)).toBe(RECONNECT_BASE_MS / 2);
	});
});
