import { expect, spyOn, test } from "bun:test";
import { type WifiMessage, wifiMessageSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { initMockService } from "../mocks/mock-service.ts";
import { setMockWifiFaults } from "../mocks/providers/wifi.ts";
import { getMockWifiIncarnation } from "../mocks/providers/wifi-incarnation.ts";
import * as streaming from "../modules/streaming/streaming.ts";
import {
	getWifiState,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import {
	wifiAdapterLockKeyForDeviceId,
	withWifiAdapterLock,
} from "../modules/wifi/wifi-adapter-lock.ts";
import { defaultAdapterModeDeps } from "../modules/wifi/wifi-adapter-mode-transition.ts";
import { defaultHotspotStopDeps } from "../modules/wifi/wifi-hotspot-config.ts";
import type { HotspotOutcomePublisher } from "../modules/wifi/wifi-hotspot-outcome.ts";
import * as compat from "../rpc/compat.ts";
import { addClient, broadcast, removeClient } from "../rpc/events.ts";
import { setWifiAdapterModeProcedure } from "../rpc/procedures/wifi.procedure.ts";
import { fixture, request } from "./helpers/wifi-entry-fixture.ts";
import { wifiProtocolContext } from "./helpers/wifi-protocol-context.ts";

type ModeFrame = NonNullable<WifiMessage["adapter_mode"]>;

function collectModes(frames: ModeFrame[]) {
	return (raw: string) => {
		const mode = wifiMessageSchema.parse(JSON.parse(raw).wifi).adapter_mode;
		if (mode !== undefined) frames.push(mode);
	};
}

test("finding 13: a tokenless refusal cannot terminate another client's accepted mode transaction", async () => {
	const state = await fixture();
	state.row.conn = "station-uuid";
	state.row.activeMode = "infrastructure";
	spyOn(streaming, "getIsStreaming").mockReturnValue(false);
	let complete: HotspotOutcomePublisher | undefined;
	spyOn(defaultAdapterModeDeps, "startHotspot").mockImplementation(
		async (_device, publish) => {
			complete = publish;
			return { success: true };
		},
	);
	spyOn(defaultAdapterModeDeps, "armTerminalTimeout").mockImplementation(
		() => () => undefined,
	);
	const accepted: ModeFrame[] = [];
	const refused: ModeFrame[] = [];
	const clientA = wifiProtocolContext(collectModes(accepted));
	const clientB = wifiProtocolContext(collectModes(refused));
	addClient(clientA.ws);
	addClient(clientB.ws);
	spyOn(compat, "broadcastMsg").mockImplementation((type, data) =>
		broadcast(type, data),
	);
	try {
		const admitted = await call(
			setWifiAdapterModeProcedure,
			{ device: "0", mode: "hotspot", incarnation: state.before },
			{ context: clientA },
		);
		expect(admitted).toEqual({
			success: true,
			accepted: true,
			applied: "hotspot",
		});
		expect(await request("hotspot", clientB)).toEqual({
			success: false,
			error: "binding-required",
		});
		if (complete === undefined) throw new Error("missing mode confirmation");
		complete("start", 0, { success: true });
		expect(accepted).toEqual([
			{
				device: 0,
				mode: "hotspot",
				pending: true,
				incarnation: state.before,
			},
			{
				device: 0,
				mode: "hotspot",
				success: true,
				incarnation: state.before,
			},
		]);
		expect(refused).toEqual([
			{
				device: 0,
				mode: "hotspot",
				pending: true,
				incarnation: state.before,
			},
			{
				device: "0",
				error: "binding-required",
				incarnation: state.before,
			},
			{
				device: 0,
				mode: "hotspot",
				success: true,
				incarnation: state.before,
			},
		]);
	} finally {
		removeClient(clientA.ws);
		removeClient(clientB.ws);
		await state.restore();
	}
});

for (const mocked of [false, true]) {
	for (const kind of ["start", "configure", "hotspot"] as const) {
		for (const error of [
			"binding-required",
			"radio-changed",
			"DEVICE_BUSY",
		] as const) {
			test(`${mocked ? "mock" : "real"} ${kind} entry ${error} reaches only the requester`, async () => {
				const state = await fixture();
				if (mocked) {
					state.mocked(true);
					initMockService("multi-modem-wifi");
					if (error === "DEVICE_BUSY") setMockWifiFaults({ deviceBusy: true });
				}
				const current = mocked ? getMockWifiIncarnation("wlan0") : state.before;
				const observerFrames: string[] = [];
				const observer = wifiProtocolContext((raw) => observerFrames.push(raw));
				addClient(state.context.ws);
				addClient(observer.ws);
				spyOn(compat, "broadcastMsg").mockImplementation((type, data) =>
					broadcast(type, data),
				);
				const release = Promise.withResolvers<void>();
				const key = wifiAdapterLockKeyForDeviceId("0");
				if (key === undefined) throw new Error("missing fixture adapter lock");
				const held =
					!mocked && error === "DEVICE_BUSY"
						? withWifiAdapterLock(key, () => release.promise)
						: undefined;
				try {
					const incarnation =
						error === "binding-required"
							? undefined
							: error === "radio-changed"
								? "stale-entry-token"
								: current;
					expect(await request(kind, state.context, incarnation)).toEqual({
						success: false,
						error,
					});
					expect(observerFrames).toEqual([]);
					const outcome = {
						device: kind === "hotspot" ? "0" : 0,
						error,
						...(kind === "start"
							? {}
							: { incarnation: incarnation ?? current }),
					};
					expect(
						state.frames.map((raw) =>
							wifiMessageSchema.parse(JSON.parse(raw).wifi),
						),
					).toEqual([
						kind === "hotspot"
							? { adapter_mode: outcome }
							: {
									hotspot: { [kind === "start" ? "start" : "config"]: outcome },
								},
					]);
				} finally {
					release.resolve();
					await held;
					removeClient(state.context.ws);
					removeClient(observer.ws);
					await state.restore();
				}
			});
		}
	}
}

test("finding 14: streaming during hybrid AP teardown publishes the accepted transaction's busy terminal", async () => {
	const state = await fixture();
	const previousWifi = getWifiState();
	state.row.conn = "station-uuid";
	state.row.activeConn = "station-uuid";
	state.row.activeMode = "infrastructure";
	state.row.supportsApStaConcurrency = true;
	const hotspotConnection = state.row.hotspot.conn;
	if (hotspotConnection === undefined)
		throw new Error("missing fixture hotspot connection");
	state.row.concurrentHotspot = {
		ifname: "clap-wlan0",
		activeConn: hotspotConnection,
	};
	const streamingNow = spyOn(streaming, "getIsStreaming").mockReturnValue(
		false,
	);
	spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(async () => {
		await Promise.resolve();
		streamingNow.mockReturnValue(true);
		return true;
	});
	spyOn(defaultHotspotStopDeps, "releaseConcurrentInterface").mockResolvedValue(
		undefined,
	);
	try {
		expect(await request("hotspot", state.context, state.before)).toEqual({
			success: false,
			error: "DEVICE_BUSY",
		});
		const modes: ModeFrame[] = [];
		for (const raw of state.frames) collectModes(modes)(raw);
		expect(modes).toEqual([
			{
				device: 0,
				mode: "hotspot",
				pending: true,
				incarnation: state.before,
			},
			{ device: 0, error: "DEVICE_BUSY", incarnation: state.before },
		]);
	} finally {
		setWifiState(previousWifi);
		await state.restore();
	}
});
