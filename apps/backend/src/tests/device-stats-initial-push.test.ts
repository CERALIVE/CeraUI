import { afterEach, describe, expect, test } from "bun:test";
import { os } from "@orpc/server";
import { z } from "zod";

import { getMockDeviceStatsDeps } from "../mocks/providers/device-stats.ts";
import {
	collectDeviceStats,
	createDeviceStatsState,
} from "../modules/system/device-stats.ts";
import {
	getDeviceStatsSnapshot,
	recordDeviceStatsSnapshot,
} from "../modules/system/device-stats-snapshot.ts";
import { handleORPCMessage } from "../rpc/adapter.ts";
import { initSocketData } from "../rpc/context.ts";
import type { RPCContext, SocketData } from "../rpc/types.ts";

const frameSchema = z.record(z.string(), z.unknown());
const loginRouter = {
	auth: {
		login: os.$context<RPCContext>().handler(({ context }) => {
			context.authenticate();
			return { success: true };
		}),
	},
};

/** Finish on an ordered marker, never by waiting for a sampling timer. */
async function loginFrames(): Promise<Record<string, unknown>[]> {
	const frames: Record<string, unknown>[] = [];
	const received = Promise.withResolvers<void>();
	const server = Bun.serve<SocketData>({
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request, { data: initSocketData() })) return;
			return new Response(null, { status: 400 });
		},
		websocket: {
			async message(ws) {
				await handleORPCMessage(
					ws,
					{ id: "login", path: ["auth", "login"] },
					loginRouter,
				);
				ws.send(JSON.stringify({ complete: true }));
			},
		},
	});
	const socket = new WebSocket(`ws://localhost:${server.port}`);
	socket.onopen = () => socket.send("login");
	socket.onerror = received.reject;
	socket.onmessage = ({ data }) => {
		const frame = frameSchema.parse(JSON.parse(String(data)));
		if (frame.complete === true) received.resolve();
		else frames.push(frame);
	};
	try {
		await received.promise;
		return frames;
	} finally {
		socket.close();
		await server.stop(true);
	}
}

afterEach(() => recordDeviceStatsSnapshot(undefined));

describe("Device Health telemetry at authentication", () => {
	test("a client joining after a sample gets it without another collector tick", async () => {
		const sample = await collectDeviceStats(
			getMockDeviceStatsDeps(),
			createDeviceStatsState(),
		);
		expect(sample.memUsedPercent).toBe(25);
		expect(sample.gpu?.loadPercent).toBe(61);
		expect(sample.ddr?.loadPercent).toBe(37);
		recordDeviceStatsSnapshot(sample);

		const frames = await loginFrames();

		expect(frames.filter((frame) => "device-stats" in frame)).toEqual([
			{ "device-stats": sample },
		]);
	});

	test("before sampling, authentication never invents a telemetry reading", async () => {
		expect(getDeviceStatsSnapshot()).toBeUndefined();

		const frames = await loginFrames();

		expect(frames.some((frame) => "device-stats" in frame)).toBe(false);
	});

	test("a later unavailable sample retires previously measured optional fields", () => {
		recordDeviceStatsSnapshot({
			disk: null,
			cpuLoad1: 1,
			socTemp: null,
			ifaceRxTx: null,
			raucSlot: "unavailable",
			memUsedPercent: 25,
		});
		const unavailable = {
			disk: null,
			cpuLoad1: null,
			socTemp: null,
			ifaceRxTx: null,
			raucSlot: "unavailable",
		};

		recordDeviceStatsSnapshot(unavailable);

		expect(getDeviceStatsSnapshot()).toEqual(unavailable);
	});
});
