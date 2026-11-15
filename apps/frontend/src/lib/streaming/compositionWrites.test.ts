// @vitest-environment jsdom
/**
 * The tab's one composition lane (`compositionWrites`): every composition write
 * from the layout card and the layout designer leaves one at a time, in the
 * order it was made, and a placement still waiting when any newer write arrives
 * is dropped unsent, so an older drag can never undo a newer choice.
 */
import type { StreamingSetConfigOutput } from "@ceraui/rpc/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

const setConfig = vi.hoisted(() =>
	vi.fn<
		(input: Record<string, unknown>) => Promise<StreamingSetConfigOutput>
	>(),
);
vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig } },
	rpcClient: {},
}));

import {
	compositionRefusal,
	pendingPlacement,
	sendCompositionWrite,
} from "./compositionWrites.svelte";

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

afterEach(() => {
	setConfig.mockReset();
});

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
