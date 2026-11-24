import { expect, test } from "./fixtures/index.js";

/**
 * What the mock engine was asked to start, read over the worker backend's
 * private child channel. The params a Start hands the engine never cross the
 * page's socket, so specs read them here instead of through a product endpoint.
 */

test.use({ backendScenario: "caps-full" });

const MAIN = "RØDE AI-Micro";
const SECOND = "Elgato Wave:3";
const entry = (id: string, tracks: number[]) => ({ id, tracks, gain_db: 0, mute: false, delay_ms: 0 });

test("the mock engine's last start request carries the saved mix, and stopping keeps it", async ({
	backendRpc,
	workerBackend,
}) => {
	expect((await workerBackend.mockEngine()).lastStartParams).toBeNull();
	await backendRpc.call(["streaming", "setConfig"], {
		asrc: MAIN,
		source: "usb",
		srtla_addr: "127.0.0.1",
		srtla_port: 5000,
		srt_streamid: "e2e",
		audio_inputs: [entry(MAIN, [1]), entry(SECOND, [2])],
	});
	expect(await backendRpc.call(["streaming", "start"], { source: "usb" })).toMatchObject({ success: true });

	const started = (await workerBackend.mockEngine()).lastStartParams;
	expect(started).toMatchObject({ srt: { host: "127.0.0.1", port: 9000 } });
	const inputs = (started?.audio as { inputs?: Array<{ tracks: number[] }> } | undefined)?.inputs;
	expect(inputs?.map((input) => input.tracks)).toEqual([[1], [2]]);

	await backendRpc.call(["streaming", "stop"], {});
	expect((await workerBackend.mockEngine()).lastStartParams).toEqual(started);
});
