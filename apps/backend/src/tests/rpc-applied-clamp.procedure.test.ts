import { describe, expect, test } from "bun:test";

import { call } from "@orpc/server";
import { getConfig } from "../modules/config.ts";
import { clampBitrate } from "../modules/streaming/encoder.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { configureNetworkInterfaceProcedure } from "../rpc/procedures/network.procedure.ts";
import {
	setBitrateProcedure,
	setConfigProcedure,
} from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

// A bitrate inside the zod validation window (500–50000) but above the encoder
// hardware ceiling, so the handler must clamp it down to clampBitrate's max.
const OVER_HARDWARE_BITRATE = 40000;

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

function captureClient(sink: string[]): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: (message: string) => sink.push(message),
	} as unknown as AppWebSocket;
}

describe("streaming.setConfig — applied (post-clamp) state", () => {
	test("clamps an over-ceiling max_br and resolves with the applied value", async () => {
		const result = await call(
			setConfigProcedure,
			{ max_br: OVER_HARDWARE_BITRATE },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied?.max_br).toBe(clampBitrate(OVER_HARDWARE_BITRATE));
		expect(result.applied?.max_br).toBeLessThan(OVER_HARDWARE_BITRATE);
		expect(getConfig().max_br).toBe(clampBitrate(OVER_HARDWARE_BITRATE));
	});

	test("still fires the config broadcast as an additional side-effect", async () => {
		const received: string[] = [];
		const client = captureClient(received);
		addClient(client);

		try {
			await call(
				setConfigProcedure,
				{ max_br: OVER_HARDWARE_BITRATE },
				{ context: makeContext() },
			);

			const configPayloads = received
				.map((raw) => JSON.parse(raw))
				.filter(
					(obj): obj is { config: { max_br?: number } } =>
						!!obj && typeof obj === "object" && "config" in obj,
				)
				.map((obj) => obj.config);

			expect(configPayloads.length).toBeGreaterThan(0);
			expect(configPayloads[configPayloads.length - 1].max_br).toBe(
				clampBitrate(OVER_HARDWARE_BITRATE),
			);
		} finally {
			removeClient(client);
		}
	});

	test("rejects invalid input without a partial write", async () => {
		await call(
			setConfigProcedure,
			{ max_br: 3000 },
			{ context: makeContext() },
		);
		expect(getConfig().max_br).toBe(3000);

		const promise = call(
			setConfigProcedure,
			// max_br above the zod ceiling (50000) — must reject before any write.
			{ max_br: 999999 },
			{ context: makeContext() },
		);
		await expect(promise).rejects.toThrow();

		expect(getConfig().max_br).toBe(3000);
	});
});

describe("streaming.setBitrate — applied (post-clamp) state", () => {
	test("resolves with the clamped max_br when not streaming", async () => {
		const result = await call(
			setBitrateProcedure,
			{ max_br: OVER_HARDWARE_BITRATE },
			{ context: makeContext() },
		);

		expect(result.max_br).toBe(clampBitrate(OVER_HARDWARE_BITRATE));
		expect(result.max_br).toBeLessThan(OVER_HARDWARE_BITRATE);
	});
});

describe("network.configure — applied state", () => {
	test("resolves with the applied interface config it wrote", async () => {
		const result = await call(
			configureNetworkInterfaceProcedure,
			{ name: "eth-test-missing", enabled: true },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied).toEqual({
			name: "eth-test-missing",
			ip: undefined,
			enabled: true,
		});
	});
});
