import { afterEach, describe, expect, it } from "bun:test";
import { StatusSchema } from "../modules/remote-control/protocol.ts";
import {
	type ControlChannel,
	isRelayable,
	RELAYABLE_TYPES,
	relayStatusToGateway,
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
import { broadcastMsg, broadcastMsgLocal } from "../rpc/compat.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";

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

/** A fake authenticated local client that records the raw messages it receives. */
function makeClient(sent: string[]): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: 0 },
		send: (msg: string) => {
			sent.push(msg);
		},
	} as unknown as AppWebSocket;
}

afterEach(() => {
	resetStatusRelay();
});

describe("relayStatusToGateway", () => {
	it("emits a spec-valid kind:status frame with correct type, payload, and seq", () => {
		const channel = makeChannel();
		setControlChannel(channel);

		broadcastMsg("status", { is_streaming: true });

		expect(channel.frames).toHaveLength(1);
		const frame = channel.frames[0];

		// The frame must parse as a spec §8 status frame.
		const parsed = StatusSchema.parse(frame);
		expect(parsed.kind).toBe("status");
		expect(parsed.type).toBe("status");
		expect(parsed.payload).toEqual({ is_streaming: true });
		expect(parsed.seq).toBeGreaterThanOrEqual(0);
		expect(Number.isInteger(parsed.seq)).toBe(true);
		expect(parsed.v).toBe(1);
	});

	it("stamps an independently increasing seq per status type", () => {
		const channel = makeChannel();
		setControlChannel(channel);

		broadcastMsg("status", { a: 1 });
		broadcastMsg("status", { a: 2 });
		broadcastMsg("config", { b: 1 });

		const first = StatusSchema.parse(channel.frames[0]);
		const second = StatusSchema.parse(channel.frames[1]);
		const configFrame = StatusSchema.parse(channel.frames[2]);

		expect(second.seq).toBe(first.seq + 1);
		// config has its own counter, independent of status
		expect(configFrame.type).toBe("config");
		expect(configFrame.seq).toBe(first.seq);
	});

	it("does NOT relay when the channel reports disconnected", () => {
		const channel = makeChannel(false);
		setControlChannel(channel);

		broadcastMsg("status", { is_streaming: true });

		expect(channel.frames).toHaveLength(0);
	});

	it("is a safe no-op when no control channel is wired (Task 13 pending)", () => {
		// No setControlChannel call → channel is null.
		expect(() => broadcastMsg("status", { is_streaming: true })).not.toThrow();
	});

	it("does NOT relay a non-relayable broadcast type", () => {
		const channel = makeChannel();
		setControlChannel(channel);

		broadcastMsg("wifi", { ssid: "x" });
		broadcastMsg("relays", { list: [] });
		broadcastMsg("ping", { t: 1 });

		expect(channel.frames).toHaveLength(0);
	});

	it("relayStatusToGateway can be called directly with an explicit seq", () => {
		const channel = makeChannel();
		setControlChannel(channel);

		relayStatusToGateway("netif", { eth0: { up: true } }, 7);

		const parsed = StatusSchema.parse(channel.frames[0]);
		expect(parsed.type).toBe("netif");
		expect(parsed.seq).toBe(7);
		expect(parsed.payload).toEqual({ eth0: { up: true } });
	});
});

describe("dual delivery (local + relay)", () => {
	it("a relayed status still reaches local clients unchanged", () => {
		const channel = makeChannel();
		setControlChannel(channel);

		const sent: string[] = [];
		const client = makeClient(sent);
		addClient(client);
		try {
			broadcastMsg("status", { is_streaming: true });
		} finally {
			removeClient(client);
		}

		// Local delivery: the client received the same payload under the type key.
		expect(sent).toHaveLength(1);
		const localMsg = JSON.parse(sent[0] as string);
		expect(localMsg.status).toEqual({ is_streaming: true });
		expect(typeof localMsg.seq).toBe("number");

		// Relay delivery: the control channel got the kind:status frame.
		expect(channel.frames).toHaveLength(1);
		const relayed = StatusSchema.parse(channel.frames[0]);
		expect(relayed.payload).toEqual({ is_streaming: true });
	});
});

describe("broadcastMsgLocal is local-only", () => {
	it("does NOT relay to the control channel", () => {
		const channel = makeChannel();
		setControlChannel(channel);

		const sent: string[] = [];
		const client = makeClient(sent);
		addClient(client);
		try {
			broadcastMsgLocal("status", { is_streaming: true });
		} finally {
			removeClient(client);
		}

		// Local clients still receive it...
		expect(sent).toHaveLength(1);
		// ...but nothing was relayed to the gateway.
		expect(channel.frames).toHaveLength(0);
	});
});

describe("no-secrets contract", () => {
	it("RELAYABLE_TYPES is exactly the closed v2.0 status set (spec §8)", () => {
		expect([...RELAYABLE_TYPES]).toEqual([
			"status",
			"config",
			"sensors",
			"netif",
			"modems",
			"device-stats",
			"notifications",
			"device.activeProfile",
		]);
	});

	it("carries no secret-bearing or local-only types", () => {
		const forbidden = [
			"auth",
			"auth.login",
			"auth.setPassword",
			"token",
			"password",
			"secret",
			"paseto",
			"pin",
			"remote_key",
		];
		for (const type of forbidden) {
			expect(isRelayable(type)).toBe(false);
		}

		// Defensive: no relayable type name contains a secret-shaped substring.
		const secretLike = /auth|token|password|secret|paseto|pin|key/i;
		for (const type of RELAYABLE_TYPES) {
			expect(secretLike.test(type)).toBe(false);
		}
	});
});
