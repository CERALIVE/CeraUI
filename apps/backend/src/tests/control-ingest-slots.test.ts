import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	type ControlChannelLogger,
	type ControlSocket,
	initControlChannel,
} from "../modules/remote-control/channel.ts";
import { resetSharedSeenCidStore } from "../modules/remote-control/command-idempotency.ts";
import { routeCommand } from "../modules/remote-control/command-router.ts";
import {
	configureIngestSlots,
	getManagedIngestAccounts,
	getSelectedIngestEndpoint,
	handleIngestSlots,
	onIngestSlotsChanged,
	resetIngestSlots,
	selectIngestSlot,
} from "../modules/remote-control/ingest-slots.ts";
import {
	type Command,
	type DeliveryAck,
	HandshakeDeviceSchema,
	HandshakeSchema,
	type Result,
} from "../modules/remote-control/protocol.ts";

const FIXED_CID = "11111111-1111-4111-8111-111111111111";

const silent: ControlChannelLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

let selectedStore: string | undefined;

beforeEach(() => {
	resetIngestSlots();
	resetSharedSeenCidStore();
	selectedStore = undefined;
	configureIngestSlots({
		readSelected: () => selectedStore,
		writeSelected: (endpointId) => {
			selectedStore = endpointId;
		},
	});
});

afterEach(async () => {
	resetIngestSlots();
	resetSharedSeenCidStore();
	// Gate the process-wide control-channel singleton back down so the open fake
	// socket from the hello test never leaks into a later case.
	await initControlChannel({ canDial: () => false, logger: silent });
});

function makeSlot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		endpointId: "ep-1",
		obsInstanceId: "obs-1",
		instanceLabel: "Main",
		region: "eu-west",
		state: "active",
		host: "ingest.example.com",
		port: 8890,
		protocol: "srtla",
		streamId: "stream-key-1",
		default: true,
		...overrides,
	};
}

function makeIngestCommand(
	payload: unknown,
	overrides: Partial<Command> = {},
): Command {
	return {
		v: 1,
		kind: "command",
		type: "ingest.slots",
		cid: FIXED_CID,
		payload: payload as Command["payload"],
		...overrides,
	};
}

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

describe("ingest.slots — device.hello advertisement", () => {
	test("device.hello advertises ingest.slots in supportedTypes", async () => {
		const fake = makeFakeSocket();
		await initControlChannel({
			canDial: () => true,
			resolveEndpoint: () => ({
				url: "wss://hub.example.test/ws",
				host: "hub.example.test",
				pinned: true,
			}),
			createSocket: () => fake.socket,
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

		fake.fireOpen();

		const frame = HandshakeSchema.parse(JSON.parse(fake.sent[0] ?? "{}"));
		const hello = HandshakeDeviceSchema.parse(frame.payload);
		expect(hello.supportedTypes).toContain("ingest.slots");
	});
});

describe("ingest.slots — slot → managed account mapping", () => {
	test("maps each slot to a managed account keyed by endpointId", () => {
		const accounts = handleIngestSlots({
			slots: [
				makeSlot(),
				makeSlot({ endpointId: "ep-2", host: "alt.example.com", port: 9000 }),
			],
		});

		expect(accounts).not.toBeNull();
		expect(getManagedIngestAccounts()).toHaveLength(2);

		const first = getManagedIngestAccounts()[0];
		expect(first).toEqual({
			endpointId: "ep-1",
			host: "ingest.example.com",
			port: 8890,
			protocol: "srtla",
			key: "stream-key-1",
			label: "Main",
			region: "eu-west",
			state: "active",
			default: true,
		});

		const byEndpoint = new Map(
			getManagedIngestAccounts().map((a) => [a.endpointId, a]),
		);
		expect(byEndpoint.get("ep-2")?.host).toBe("alt.example.com");
		expect(byEndpoint.get("ep-2")?.port).toBe(9000);
	});

	test("label falls back to endpointId when instanceLabel is absent", () => {
		handleIngestSlots({
			slots: [makeSlot({ endpointId: "ep-x", instanceLabel: undefined })],
		});

		expect(getManagedIngestAccounts()[0]?.label).toBe("ep-x");
	});

	test("tolerates a null obsInstanceId (device-lenient validator)", () => {
		const accounts = handleIngestSlots({
			slots: [makeSlot({ obsInstanceId: null })],
		});

		expect(accounts).not.toBeNull();
		expect(getManagedIngestAccounts()).toHaveLength(1);
	});

	test("a later push fully replaces the prior managed-account set", () => {
		handleIngestSlots({ slots: [makeSlot(), makeSlot({ endpointId: "ep-2" })] });
		expect(getManagedIngestAccounts()).toHaveLength(2);

		handleIngestSlots({ slots: [makeSlot({ endpointId: "ep-3" })] });
		expect(getManagedIngestAccounts().map((a) => a.endpointId)).toEqual([
			"ep-3",
		]);
	});

	test("notifies subscribers when the managed-account set changes", () => {
		let received: readonly { endpointId: string }[] | undefined;
		const unsubscribe = onIngestSlotsChanged((accounts) => {
			received = accounts;
		});

		handleIngestSlots({ slots: [makeSlot()] });
		expect(received).toHaveLength(1);

		unsubscribe();
		handleIngestSlots({ slots: [] });
		expect(received).toHaveLength(1);
	});
});

describe("ingest.slots — empty + malformed payloads", () => {
	test("no slots yields an empty managed-account set", () => {
		const accounts = handleIngestSlots({ slots: [] });

		expect(accounts).toEqual([]);
		expect(getManagedIngestAccounts()).toEqual([]);
	});

	test("a malformed payload is ignored and leaves the store unchanged", () => {
		handleIngestSlots({ slots: [makeSlot()] });
		expect(getManagedIngestAccounts()).toHaveLength(1);

		expect(handleIngestSlots({ slots: [{ endpointId: "x" }] })).toBeNull();
		expect(handleIngestSlots(undefined)).toBeNull();
		expect(handleIngestSlots({})).toBeNull();
		expect(handleIngestSlots({ slots: "nope" })).toBeNull();

		expect(getManagedIngestAccounts()).toHaveLength(1);
	});
});

describe("ingest.slots — selection persistence by endpointId", () => {
	test("selectIngestSlot persists the selected endpointId", () => {
		handleIngestSlots({ slots: [makeSlot(), makeSlot({ endpointId: "ep-2" })] });

		expect(selectIngestSlot("ep-2")).toBe(true);
		expect(selectedStore).toBe("ep-2");
		expect(getSelectedIngestEndpoint()).toBe("ep-2");
	});

	test("an unknown endpointId is not persisted", () => {
		handleIngestSlots({ slots: [makeSlot()] });

		expect(selectIngestSlot("ep-unknown")).toBe(false);
		expect(selectedStore).toBeUndefined();
		expect(getSelectedIngestEndpoint()).toBeUndefined();
	});

	test("selection follows endpointId across a host/port re-push (survives reconnect)", () => {
		handleIngestSlots({ slots: [makeSlot({ host: "host-a", port: 1111 })] });
		selectIngestSlot("ep-1");
		expect(getSelectedIngestEndpoint()).toBe("ep-1");

		handleIngestSlots({ slots: [makeSlot({ host: "host-b", port: 2222 })] });

		expect(getSelectedIngestEndpoint()).toBe("ep-1");
		expect(getManagedIngestAccounts()[0]?.host).toBe("host-b");
		expect(getManagedIngestAccounts()[0]?.port).toBe(2222);
	});
});

describe("ingest.slots — inbound command routing", () => {
	function capture(): {
		results: Result[];
		acks: DeliveryAck[];
		sendResult: (frame: Result) => boolean;
		sendDeliveryAck: (frame: DeliveryAck) => boolean;
	} {
		const results: Result[] = [];
		const acks: DeliveryAck[] = [];
		return {
			results,
			acks,
			sendResult: (frame) => {
				results.push(frame);
				return true;
			},
			sendDeliveryAck: (frame) => {
				acks.push(frame);
				return true;
			},
		};
	}

	test("an inbound ingest.slots command applies the slots and echoes an ok result", async () => {
		const cap = capture();

		await routeCommand(makeIngestCommand({ slots: [makeSlot()] }), {
			sendResult: cap.sendResult,
			sendDeliveryAck: cap.sendDeliveryAck,
		});

		expect(getManagedIngestAccounts()).toHaveLength(1);
		expect(getManagedIngestAccounts()[0]?.endpointId).toBe("ep-1");
		expect(cap.acks).toHaveLength(1);
		expect(cap.acks[0]?.type).toBe("ingest.slots");
		expect(cap.results).toHaveLength(1);
		expect(cap.results[0]?.type).toBe("ingest.slots");
		expect(cap.results[0]?.cid).toBe(FIXED_CID);
		expect(cap.results[0]?.payload.ok).toBe(true);
		expect(cap.results[0]?.payload.applied).toHaveLength(1);
	});

	test("a malformed inbound ingest.slots command is ignored with an ok:false result", async () => {
		const cap = capture();
		handleIngestSlots({ slots: [makeSlot()] });

		await routeCommand(
			makeIngestCommand({ slots: [{ endpointId: "x" }] }),
			{ sendResult: cap.sendResult, sendDeliveryAck: cap.sendDeliveryAck },
		);

		expect(getManagedIngestAccounts()).toHaveLength(1);
		expect(cap.results[0]?.payload).toEqual({
			ok: false,
			applied: null,
			error: "invalid_ingest_slots",
		});
	});
});
