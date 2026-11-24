import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ListDevicesResult } from "@ceralive/cerastream";
import { AUDIO_SOURCE_AUTO } from "@ceraui/rpc/schemas";
import { getConfig } from "../modules/config.ts";
import * as audio from "../modules/streaming/audio.ts";
import {
	broadcastAudioSources,
	getAudioDevices,
	reresolveAudioForEngineChange,
} from "../modules/streaming/audio.ts";
import { setAutoAudioBroadcaster } from "../modules/streaming/auto-audio.ts";
import {
	getBluetoothAudioSources,
	refreshBluetoothAudioSources,
	resetBluetoothAudioForTest,
	setBluetoothAudioDepsForTest,
} from "../modules/streaming/bluetooth-audio.ts";
import {
	refreshAndBroadcastSources,
	resetEngineDeviceCache,
	setEngineAudioChangeHandler,
} from "../modules/streaming/sources.ts";
import * as websocket from "../modules/ui/websocket-server.ts";

// A heal that commits a CHANGED engine audio list queues an async audio
// re-resolve. That work must honour the heal's teardown guard like the device
// commit itself: once the reconnect loop is gone it commits no audio cache and
// publishes no `status.audio_sources`.

const audioCard = (card: string) =>
	({
		input_id: `audio:${card}`,
		device_path: `alsa:${card}`,
		display_name: card,
		media_class: "audio",
		kind: "audio",
		alsa_card_id: card,
	}) as ListDevicesResult["devices"][number];

function audioStatusSends(
	spy: ReturnType<typeof spyOn<typeof websocket, "broadcastMsg">>,
): number {
	return spy.mock.calls.filter(
		([type, data]) =>
			type === "status" &&
			typeof data === "object" &&
			data !== null &&
			"audio_sources" in data,
	).length;
}

afterEach(() => {
	setEngineAudioChangeHandler(undefined);
	resetEngineDeviceCache();
	resetBluetoothAudioForTest();
});

describe("audio re-resolve after a heal is torn down", () => {
	test("the default lazy audio worker does not publish after its heal is revoked", async () => {
		const called = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const done = Promise.withResolvers<void>();
		const realResolve = audio.reresolveAudioForEngineChange;
		const worker = spyOn(
			audio,
			"reresolveAudioForEngineChange",
		).mockImplementation(async (current) => {
			called.resolve();
			await resume.promise;
			await realResolve(current);
			done.resolve();
		});
		const sent = spyOn(websocket, "broadcastMsg");
		let alive = true;
		try {
			await refreshAndBroadcastSources(
				{
					fetchEngineDevices: async () => ({
						devices: [audioCard("usbaudio")],
					}),
				},
				() => alive,
			);
			await called.promise;
			alive = false;
			resume.resolve();
			await done.promise;
			expect(audioStatusSends(sent)).toBe(0);
		} finally {
			resume.resolve();
			worker.mockRestore();
			sent.mockRestore();
		}
	});

	test("held across teardown, the queued re-resolve publishes nothing", async () => {
		let alive = true;
		let queued: (() => boolean) | undefined;
		setEngineAudioChangeHandler((current) => {
			queued = current; // held: runs only after the teardown below
		});
		await refreshAndBroadcastSources(
			{
				fetchEngineDevices: async () => ({
					devices: [audioCard("usbaudio2")],
				}),
			},
			() => alive,
		);
		expect(queued).toBeDefined();
		alive = false; // stopEngineReconnect()
		const sent = spyOn(websocket, "broadcastMsg");
		try {
			await reresolveAudioForEngineChange(queued);
			expect(audioStatusSends(sent)).toBe(0);
		} finally {
			sent.mockRestore();
		}
	});

	test("a teardown at any later step stops the remaining commits and sends", async () => {
		const sent = spyOn(websocket, "broadcastMsg");
		try {
			// Alive for the first check only: torn down during the Bluetooth refresh.
			let checks = 0;
			await reresolveAudioForEngineChange(() => checks++ < 1);
			expect(audioStatusSends(sent)).toBe(0);

			// Torn down while broadcastAudioSources resolved the display names.
			await broadcastAudioSources(() => false);
			expect(audioStatusSends(sent)).toBe(0);

			// Control: an alive caller publishes.
			await broadcastAudioSources(() => true);
			expect(audioStatusSends(sent)).toBe(1);
		} finally {
			sent.mockRestore();
		}
	});

	function useBluealsaHeadset(): void {
		const address = "AA:BB:CC:11:22:33";
		setBluetoothAudioDepsForTest({
			readEnumeratedPcms: async () => [
				{
					path: "/org/bluealsa/hci0/dev_AA_BB_CC_11_22_33/sco/source",
					address,
					codec: "mSBC",
					sampleRateHz: 16_000,
					channels: 1,
				},
			],
			readRegistryDevices: () => [
				{
					address,
					alias: "Headset",
					name: "Headset",
					connected: true,
					scoCapable: true,
				},
			],
			engineSupportsPcmSpec: () => true,
			engineSupportsPipewireCapture: () => false,
			readEngineAudioDevices: () => [],
			readAudioProvider: async () => "bluealsa",
			readAudioBackend: () => undefined,
		});
	}

	test("torn down after the Bluetooth step, the audio list is not recomposed", async () => {
		useBluealsaHeadset();
		// The Bluetooth cache gains a row; only a recompose puts it in the list.
		expect(await refreshBluetoothAudioSources(() => true)).toBe(true);
		const [row] = getBluetoothAudioSources();
		if (!row) throw new Error("expected a Bluetooth row");
		expect(Object.keys(getAudioDevices())).not.toContain(row.id);
		await reresolveAudioForEngineChange(() => false);
		expect(Object.keys(getAudioDevices())).not.toContain(row.id);
		// Control: an alive re-resolve recomposes it in.
		await reresolveAudioForEngineChange(() => true);
		expect(Object.keys(getAudioDevices())).toContain(row.id);
	});

	test("torn down after the audio broadcast, the Auto preview is not refreshed", async () => {
		const config = getConfig();
		const savedAsrc = config.asrc;
		config.asrc = AUDIO_SOURCE_AUTO;
		const previews: unknown[] = [];
		setAutoAudioBroadcaster((payload) => {
			previews.push(payload);
		});
		try {
			// Alive through the audio broadcast, torn down right after it.
			let checks = 0;
			await reresolveAudioForEngineChange(() => checks++ < 2);
			expect(previews).toEqual([]);
			// Control: alive throughout, the preview is refreshed.
			await reresolveAudioForEngineChange(() => true);
			expect(previews).toHaveLength(1);
		} finally {
			setAutoAudioBroadcaster(undefined);
			if (savedAsrc === undefined) delete config.asrc;
			else config.asrc = savedAsrc;
		}
	});

	test("the Bluetooth refresh commits no sources once torn down", async () => {
		useBluealsaHeadset();
		expect(await refreshBluetoothAudioSources(() => false)).toBe(false);
		expect(getBluetoothAudioSources()).toEqual([]);
		// Control: alive, the same refresh commits the row.
		expect(await refreshBluetoothAudioSources(() => true)).toBe(true);
		expect(getBluetoothAudioSources()).toHaveLength(1);
	});
});
