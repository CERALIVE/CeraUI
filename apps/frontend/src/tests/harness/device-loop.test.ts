// @vitest-environment jsdom
/**
 * The closed-loop harness itself. `ingest` hands the REAL subscription handler
 * exactly what the socket delivers (the frame after the real JSON serializer,
 * stamped with the next `seq`), and `heldRpc` keeps every `rpc.streaming.*`
 * call pending until the test settles it, in the order the test chooses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Components read `rpc.streaming` at call time, so a test swaps in a held stub.
const rpcStub = vi.hoisted(() => ({ streaming: undefined as unknown }));
vi.mock("$lib/rpc", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	rpc: rpcStub,
}));

import { rpc } from "$lib/rpc";
import {
	getConfig,
	getStatus,
	resetState,
} from "$lib/rpc/subscriptions.svelte";
import { type HeldRpc, heldRpc, ingest } from "./device-loop";

const MIC = { id: "usb-a", tracks: [1], gain_db: 0, mute: false, delay_ms: 0 };

beforeEach(() => {
	resetState();
});

afterEach(() => {
	resetState();
});

describe("ingest: the real handler behind the real serializer", () => {
	it("an undefined field never reaches the handler: the key is gone, the handler still runs", () => {
		ingest("config", { asrc: "usb-a", audio_inputs: [MIC] });
		const before = getConfig();

		const delivered = ingest("config", { audio_inputs: undefined });

		expect(delivered).toEqual({});
		expect(Object.hasOwn(delivered as object, "audio_inputs")).toBe(false);
		// The handler took that frame: it published a new snapshot, and a field the
		// frame does not carry keeps its last value.
		expect(getConfig()).not.toBe(before);
		expect(getConfig()).toEqual({ asrc: "usb-a", audio_inputs: [MIC] });
	});

	it("an explicit null survives the serializer and reaches the handler as null", () => {
		ingest("config", { asrc: "usb-a", audio_inputs: [MIC] });

		const delivered = ingest("config", { audio_inputs: null });

		expect(delivered).toEqual({ audio_inputs: null });
		expect(getConfig()?.audio_inputs).toBeNull();
	});

	it("each frame carries the next seq, so the real drop-stale guard applies every frame in order", () => {
		ingest("config", { max_br: 1000 });
		ingest("config", { max_br: 2000 });
		ingest("config", { max_br: 3000 });

		expect(getConfig()?.max_br).toBe(3000);
	});

	it("a status frame reaches the status getters through the same handler", () => {
		const audioSources = [{ id: "usb-a", kind: "device", label: "USB mic" }];

		ingest("status", { asrcs: ["usb-a"], audio_sources: audioSources });

		expect(getStatus()?.asrcs).toEqual(["usb-a"]);
		expect(getStatus()?.audio_sources).toEqual(audioSources);
	});
});

describe("heldRpc: rpc.streaming calls the test settles in its chosen order", () => {
	let held: HeldRpc;

	beforeEach(() => {
		held = heldRpc();
		rpcStub.streaming = held.streaming;
	});

	it("records each call's method and input and keeps it pending until settled", async () => {
		let settled = false;
		const reply = rpc.streaming
			.setAudioMix({ id: "usb-a", mute: true })
			.then(() => {
				settled = true;
			});

		expect(held.calls.map(({ method, input }) => [method, input])).toEqual([
			["setAudioMix", { id: "usb-a", mute: true }],
		]);
		await Promise.resolve();
		expect(settled).toBe(false);

		held.calls[0]?.resolve({ success: true });
		await reply;
		expect(settled).toBe(true);
	});

	it("settles in the order the test picks: the second reply resolves before the first rejects", async () => {
		const order: string[] = [];
		const first = rpc.streaming.setAudioMix({ id: "usb-a", mute: true }).then(
			() => order.push("first resolved"),
			(error: Error) => order.push(`first rejected: ${error.message}`),
		);
		const second = rpc.streaming
			.setAudioMix({ id: "usb-a", mute: false })
			.then((result) => order.push(`second resolved: ${result.success}`));

		held.calls[1]?.resolve({ success: true });
		await second;
		held.calls[0]?.reject(new Error("socket closed"));
		await first;

		expect(order).toEqual([
			"second resolved: true",
			"first rejected: socket closed",
		]);
	});

	it("next(method) yields that method's next call, already made or still to come, skipping others", async () => {
		void rpc.streaming.setConfig({ max_br: 4000 });
		void rpc.streaming.setAudioMix({ id: "usb-a", gain_db: -3 });

		expect((await held.next("setConfig")).input).toEqual({ max_br: 4000 });
		expect((await held.next("setAudioMix")).input).toEqual({
			id: "usb-a",
			gain_db: -3,
		});

		const upcoming = held.next("setAudioMix");
		void rpc.streaming.setConfig({ max_br: 5000 });
		void rpc.streaming.setAudioMix({ id: "usb-a", mute: true });

		expect((await upcoming).input).toEqual({ id: "usb-a", mute: true });
		expect(held.calls.map((call) => call.method)).toEqual([
			"setConfig",
			"setAudioMix",
			"setConfig",
			"setAudioMix",
		]);
	});
});
