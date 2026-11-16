// @vitest-environment jsdom
/**
 * The tab's one lane (`compositionWrites`): every composition write from the
 * layout card and the layout designer, and every Start and Stop, leaves one at
 * a time, in the order it was made. A placement still waiting when a newer
 * composition write arrives is dropped unsent, so an older drag can never undo
 * a newer choice; a Start or a Stop drops nothing. Whether a write changes the
 * running stream (`apply_now`) follows the session when the write is sent.
 */
import type { StreamingSetConfigOutput } from "@ceraui/rpc/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

const setConfig = vi.hoisted(() =>
	vi.fn<
		(input: Record<string, unknown>) => Promise<StreamingSetConfigOutput>
	>(),
);
vi.mock("$lib/rpc/client", () => ({
	rpc: { streaming: { setConfig } },
	rpcClient: {},
}));

import {
	compositionRefusal,
	pendingPlacement,
	sendSessionTransition,
	sendCompositionWrite as sendWrite,
} from "./compositionWrites.svelte";

// The device's own word on the session (its status push), read at send time.
const session = { streaming: false };
const sendCompositionWrite = (input: Parameters<typeof sendWrite>[0]) =>
	sendWrite(input, () => session.streaming);

const SAVED: StreamingSetConfigOutput = { success: true, applied: {} };
const A = { x: 0.1, y: 0.1, width: 0.3, height: 0.3 };
const B = { x: 0.2, y: 0.2, width: 0.3, height: 0.3 };
const C = { x: 0.3, y: 0.3, width: 0.3, height: 0.3 };

/** A device that answers each write only when the test says so. */
function heldDevice() {
	const answers: Array<(result: StreamingSetConfigOutput) => void> = [];
	setConfig.mockImplementation(
		() =>
			new Promise((resolve) => {
				answers.push(resolve);
			}),
	);
	return {
		answerNext: async (result: StreamingSetConfigOutput = SAVED) => {
			answers.shift()?.(result);
			await vi.waitFor(() => undefined);
			await Promise.resolve();
		},
	};
}

const sent = () => setConfig.mock.calls.map(([input]) => input);
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

afterEach(async () => {
	// Every test ends with no session, as the device would after a Stop.
	await sendSessionTransition("idle", async () => ({ success: true }));
	session.streaming = false;
	setConfig.mockReset();
});

/** Writes, Starts and Stops against a device that answers each only when told, in one ordered log. */
function heldLane() {
	const log: Array<[string, unknown]> = [];
	const answers: Array<(result: unknown) => void> = [];
	const held =
		(path: string) =>
		(input?: unknown): Promise<never> =>
			new Promise((resolve) => {
				log.push([path, input]);
				answers.push(resolve as (result: unknown) => void);
			});
	setConfig.mockImplementation(held("setConfig"));
	return {
		log,
		start: () => sendSessionTransition("live", held("start")),
		stop: () => sendSessionTransition("idle", held("stop")),
		answer: async (result: unknown, logged: number) => {
			answers.shift()?.(result);
			await vi.waitFor(() => expect(log).toHaveLength(logged));
		},
		settle: async (result: unknown) => {
			answers.shift()?.(result);
			await vi.waitFor(() => expect(answers).toHaveLength(0));
		},
	};
}

const STARTED = { success: true, is_streaming: true };

describe("compositionWrites", () => {
	it("sends one write at a time, in the order they were made", async () => {
		const device = heldDevice();
		const preset = sendCompositionWrite({
			composition_patch: { layout: "pbp-left-right" },
		});
		const placed = sendCompositionWrite({ composition_rect: A });
		await flush();
		expect(sent()).toEqual([
			{ composition_patch: { layout: "pbp-left-right" } },
		]);
		await device.answerNext();
		await expect(preset).resolves.toEqual(SAVED);
		await vi.waitFor(() => expect(sent()).toHaveLength(2));
		expect(sent()[1]).toEqual({ composition_rect: A });
		await device.answerNext();
		await expect(placed).resolves.toEqual(SAVED);
	});

	it("a newer write drops a placement still waiting, which is never sent", async () => {
		const device = heldDevice();
		const first = sendCompositionWrite({ composition_rect: A });
		const waiting = sendCompositionWrite({ composition_rect: B });
		const preset = sendCompositionWrite({
			composition_patch: { layout: "pbp-left-right" },
		});
		await expect(waiting).resolves.toBeUndefined();
		await device.answerNext();
		await expect(first).resolves.toEqual(SAVED);
		await vi.waitFor(() => expect(sent()).toHaveLength(2));
		await device.answerNext();
		await expect(preset).resolves.toEqual(SAVED);
		expect(sent()).toEqual([
			{ composition_rect: A },
			{ composition_patch: { layout: "pbp-left-right" } },
		]);
	});

	it("of several placements waiting, only the newest is sent", async () => {
		const device = heldDevice();
		void sendCompositionWrite({ composition_rect: A });
		const older = sendCompositionWrite({ composition_rect: B });
		const newest = sendCompositionWrite({ composition_rect: C });
		await expect(older).resolves.toBeUndefined();
		expect(pendingPlacement()).toEqual(C);
		await device.answerNext();
		await vi.waitFor(() => expect(sent()).toHaveLength(2));
		expect(sent()[1]).toEqual({ composition_rect: C });
		await device.answerNext();
		await expect(newest).resolves.toEqual(SAVED);
		expect(pendingPlacement()).toBeUndefined();
	});

	it("a placement made after a card write waits for it and is then sent", async () => {
		const device = heldDevice();
		void sendCompositionWrite({ composition_patch: { alpha: 0.5 } });
		const placed = sendCompositionWrite({ composition_rect: A });
		expect(pendingPlacement()).toEqual(A);
		await device.answerNext();
		await vi.waitFor(() => expect(sent()).toHaveLength(2));
		await device.answerNext();
		await expect(placed).resolves.toEqual(SAVED);
		expect(sent()).toEqual([
			{ composition_patch: { alpha: 0.5 } },
			{ composition_rect: A },
		]);
	});

	it("a failed write rejects only its own promise; the next one still goes out", async () => {
		setConfig.mockRejectedValueOnce(new Error("socket closed"));
		setConfig.mockResolvedValueOnce(SAVED);
		const failed = sendCompositionWrite({ composition_patch: { alpha: 0.4 } });
		const next = sendCompositionWrite({ composition_patch: { alpha: 0.6 } });
		await expect(failed).rejects.toThrow("socket closed");
		await expect(next).resolves.toEqual(SAVED);
	});

	it("a refusal reads as the copy of its token, never the raw token", () => {
		for (const error of [
			"composition_off",
			"composition_unsupported",
			"composition_geometry_unsupported",
			"composition_rect_invalid",
		]) {
			const copy = compositionRefusal({ success: false, error, applied: {} });
			expect(copy).toBeTruthy();
			expect(copy).not.toContain(error);
		}
		expect(compositionRefusal(SAVED)).toBeUndefined();
	});
});

describe("compositionWrites with Start and Stop", () => {
	it("a Start waits for the write in flight and the placement made before it, which go out only saving", async () => {
		const lane = heldLane();
		void sendCompositionWrite({ composition_rect: A });
		void sendCompositionWrite({ composition_rect: B });
		const started = lane.start();
		expect(lane.log).toEqual([["setConfig", { composition_rect: A }]]);
		await lane.answer(SAVED, 2);
		await lane.answer(SAVED, 3);
		expect(lane.log).toEqual([
			["setConfig", { composition_rect: A }],
			["setConfig", { composition_rect: B }],
			["start", undefined],
		]);
		await lane.settle(STARTED);
		await expect(started).resolves.toEqual(STARTED);
	});

	it("a write made while a Start is unanswered is sent after it and changes the running stream, before the device's status says live", async () => {
		const lane = heldLane();
		void lane.start();
		const placed = sendCompositionWrite({ composition_rect: A });
		const tapped = sendCompositionWrite({ composition_patch: { alpha: 0.5 } });
		expect(pendingPlacement()).toBeUndefined();
		await lane.answer(STARTED, 2);
		await expect(placed).resolves.toBeUndefined();
		await lane.settle(SAVED);
		await expect(tapped).resolves.toEqual(SAVED);
		expect(lane.log).toEqual([
			["start", undefined],
			["setConfig", { composition_patch: { alpha: 0.5 }, apply_now: true }],
		]);
	});

	it("a Start drops no waiting placement, but a newer composition write still does", async () => {
		const lane = heldLane();
		void sendCompositionWrite({ composition_rect: A });
		const waiting = sendCompositionWrite({ composition_rect: B });
		void lane.start();
		expect(pendingPlacement()).toEqual(B);
		void sendCompositionWrite({
			composition_patch: { layout: "pbp-left-right" },
		});
		await expect(waiting).resolves.toBeUndefined();
		await lane.answer(SAVED, 2);
		await lane.answer(STARTED, 3);
		await lane.settle(SAVED);
		expect(lane.log).toEqual([
			["setConfig", { composition_rect: A }],
			["start", undefined],
			[
				"setConfig",
				{ composition_patch: { layout: "pbp-left-right" }, apply_now: true },
			],
		]);
	});

	it("live, a Stop sends the placements made before it first, changing the running stream; one made after it only saves", async () => {
		session.streaming = true;
		const lane = heldLane();
		void sendCompositionWrite({ composition_rect: A });
		void sendCompositionWrite({ composition_rect: B });
		const stopped = lane.stop();
		await lane.answer(SAVED, 2);
		await lane.answer(SAVED, 3);
		session.streaming = false;
		await lane.settle({ success: true, result: "stopped" });
		await stopped;
		void sendCompositionWrite({ composition_patch: { alpha: 0.4 } });
		await vi.waitFor(() => expect(lane.log).toHaveLength(4));
		await lane.settle(SAVED);
		expect(lane.log).toEqual([
			["setConfig", { composition_rect: A, apply_now: true }],
			["setConfig", { composition_rect: B, apply_now: true }],
			["stop", undefined],
			["setConfig", { composition_patch: { alpha: 0.4 } }],
		]);
	});

	it("a Stop never waits for an earlier Stop still unanswered, and a write waits for both", async () => {
		session.streaming = true;
		const lane = heldLane();
		const first = lane.stop();
		void sendCompositionWrite({ composition_rect: A });
		const second = lane.stop();
		expect(lane.log).toEqual([
			["stop", undefined],
			["stop", undefined],
		]);
		session.streaming = false;
		await lane.answer({ success: true, result: "stopped" }, 2);
		await first;
		expect(lane.log).toHaveLength(2);
		await lane.answer({ success: true, result: "stopped" }, 3);
		await second;
		await lane.settle(SAVED);
		expect(lane.log[2]).toEqual(["setConfig", { composition_rect: A }]);
	});

	it("the session when a write is sent decides, not the one when it was made", async () => {
		const lane = heldLane();
		void sendCompositionWrite({ composition_patch: { alpha: 0.2 } });
		void sendCompositionWrite({ composition_rect: A });
		session.streaming = true;
		await lane.answer(SAVED, 2);
		void sendCompositionWrite({ composition_rect: B });
		session.streaming = false;
		await lane.answer(SAVED, 3);
		await lane.settle(SAVED);
		expect(lane.log).toEqual([
			["setConfig", { composition_patch: { alpha: 0.2 } }],
			["setConfig", { composition_rect: A, apply_now: true }],
			["setConfig", { composition_rect: B }],
		]);
	});

	it("after a refused Start the next write only saves; after a Start whose answer was lost it asks to change the running stream", async () => {
		const lane = heldLane();
		const refused = lane.start();
		await lane.settle({ success: false, error: "START_IN_PROGRESS" });
		await refused;
		void sendCompositionWrite({ composition_rect: A });
		await lane.settle(SAVED);

		const lost = sendSessionTransition("live", () =>
			Promise.reject(new Error("socket closed")),
		);
		await expect(lost).rejects.toThrow("socket closed");
		void sendCompositionWrite({ composition_rect: B });
		await vi.waitFor(() => expect(lane.log).toHaveLength(3));
		await lane.settle(SAVED);
		expect(lane.log).toEqual([
			["start", undefined],
			["setConfig", { composition_rect: A }],
			["setConfig", { composition_rect: B, apply_now: true }],
		]);
	});
});
