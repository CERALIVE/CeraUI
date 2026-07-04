import { describe, expect, test } from "bun:test";

import { call } from "@orpc/server";
import { getConfig } from "../modules/config.ts";
import { clampBitrate } from "../modules/streaming/encoder.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { configureNetworkInterfaceProcedure } from "../rpc/procedures/network.procedure.ts";
import {
	getConfigProcedure,
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

	test("floors a sub-2s srt_latency to the SRTLA minimum, persisting + echoing 2000 (T2)", async () => {
		const result = await call(
			setConfigProcedure,
			{ srt_latency: 100 },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied?.srt_latency).toBe(2000);
		expect(getConfig().srt_latency).toBe(2000);
	});

	test("leaves an at/above-floor srt_latency untouched", async () => {
		const result = await call(
			setConfigProcedure,
			{ srt_latency: 3000 },
			{ context: makeContext() },
		);

		expect(result.applied?.srt_latency).toBe(3000);
		expect(getConfig().srt_latency).toBe(3000);
	});

	test("persists + echoes fec_enabled and recovery_mode (Tasks 18/19)", async () => {
		const result = await call(
			setConfigProcedure,
			{ fec_enabled: true, recovery_mode: "bandwidth-saver" },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied?.fec_enabled).toBe(true);
		expect(result.applied?.recovery_mode).toBe("bandwidth-saver");
		expect(getConfig().fec_enabled).toBe(true);
		expect(getConfig().recovery_mode).toBe("bandwidth-saver");
	});

	test("persists + echoes selected_ingest_endpoint, and getConfig echoes it (Task 18)", async () => {
		const result = await call(
			setConfigProcedure,
			{
				selected_ingest_endpoint: "ep-1",
				srtla_addr: "ingest1.example",
				srtla_port: 5000,
			},
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied?.selected_ingest_endpoint).toBe("ep-1");
		expect(getConfig().selected_ingest_endpoint).toBe("ep-1");

		const echoed = await call(
			getConfigProcedure,
			{},
			{ context: makeContext() },
		);
		expect(echoed.selected_ingest_endpoint).toBe("ep-1");
	});

	test("persists + echoes video_codec and selected_video_input, and getConfig echoes them (Todo 19)", async () => {
		const result = await call(
			setConfigProcedure,
			{ video_codec: "h265", selected_video_input: "cam-0" },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied?.video_codec).toBe("h265");
		expect(result.applied?.selected_video_input).toBe("cam-0");
		expect(getConfig().video_codec).toBe("h265");
		expect(getConfig().selected_video_input).toBe("cam-0");

		const echoed = await call(
			getConfigProcedure,
			{},
			{ context: makeContext() },
		);
		expect(echoed.video_codec).toBe("h265");
		expect(echoed.selected_video_input).toBe("cam-0");
	});

	test("persists + echoes source_preference, and getConfig echoes it (config hydration on reload)", async () => {
		const order = ["cam-b", "cam-a"];
		const result = await call(
			setConfigProcedure,
			{ source_preference: order },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied?.source_preference).toEqual(order);
		expect(getConfig().source_preference).toEqual(order);

		const echoed = await call(
			getConfigProcedure,
			{},
			{ context: makeContext() },
		);
		expect(echoed.source_preference).toEqual(order);
	});

	test("getConfig echoes a persisted source + source_preference (F2 Bug 2)", async () => {
		const config = getConfig();
		config.source = "video0";
		config.source_preference = ["video0", "usb0"];

		const echoed = await call(
			getConfigProcedure,
			{},
			{ context: makeContext() },
		);
		expect(echoed.source).toBe("video0");
		expect(echoed.source_preference).toEqual(["video0", "usb0"]);

		config.source = undefined;
		config.source_preference = undefined;
	});

	test("clears a stale ingest slot on a non-slot save (round-3 mutual exclusion)", async () => {
		await call(
			setConfigProcedure,
			{
				selected_ingest_endpoint: "ep-1",
				srtla_addr: "ingest1.example",
				srtla_port: 5000,
			},
			{ context: makeContext() },
		);
		expect(getConfig().selected_ingest_endpoint).toBe("ep-1");

		// A managed-relay save sends selected_ingest_endpoint: "" → clears it.
		const result = await call(
			setConfigProcedure,
			{ relay_server: "srv-eu", selected_ingest_endpoint: "" },
			{ context: makeContext() },
		);
		expect(result.applied?.selected_ingest_endpoint).toBe("");
		expect(getConfig().selected_ingest_endpoint).toBeUndefined();
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
	test("resolves with success + the clamped applied bitrate when not streaming", async () => {
		const result = await call(
			setBitrateProcedure,
			{ max_br: OVER_HARDWARE_BITRATE },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied).toBe(clampBitrate(OVER_HARDWARE_BITRATE));
		expect(result.applied).toBeLessThan(OVER_HARDWARE_BITRATE);
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
