// @vitest-environment jsdom
/**
 * LayoutDesigner — the second input placed on the preview (Live screen
 * contract, "The layout designer").
 *
 *   • a drag or a held arrow key moves the inset locally and sends ONE
 *     placement when it is released, already clamped, as the delta
 *     `composition_rect` (the device composes it on its own saved composition);
 *   • live, the same placement carries `apply_now: true`;
 *   • a refused placement puts the last applied rectangle back and says why;
 *   • a placement released while an earlier one is unanswered waits for that
 *     answer and is then sent, so quick drags never drop one another;
 *   • each corner also resizes from a cap inside the inset, never larger than a
 *     quarter of it, so even the smallest inset keeps its middle for moving;
 *   • Escape during a pointer drag puts the inset back and sends nothing.
 */
import type {
	CompositionConfig,
	StreamingSetConfigOutput,
} from "@ceraui/rpc/schemas";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const setConfig = vi.hoisted(() =>
	vi.fn<
		(input: Record<string, unknown>) => Promise<StreamingSetConfigOutput>
	>(),
);
vi.mock("$lib/rpc/client", () => ({
	rpc: { streaming: { setConfig } },
	rpcClient: {},
}));
// The device's own word on the session, which the composition lane reads when
// it sends a placement.
const session = vi.hoisted(() => ({ streaming: false }));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getIsStreaming: () => session.streaming,
}));

import LayoutDesigner from "./LayoutDesigner.svelte";

const STAGE = { width: 640, height: 360 };

beforeAll(() => {
	if (!("ResizeObserver" in window)) {
		(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		};
	}
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get: () => STAGE.width,
	});
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get: () => STAGE.height,
	});
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.setPointerCapture ??= vi.fn();
	proto.releasePointerCapture ??= vi.fn();
	proto.hasPointerCapture ??= vi.fn(() => false);
});

afterEach(() => {
	cleanup();
	setConfig.mockReset();
});

const PRESET: CompositionConfig = {
	secondary_input_id: "/dev/video1",
	layout: "pip-top-right",
	alpha: 0.8,
};

const SAVED: StreamingSetConfigOutput = { success: true, applied: {} };
const APPLIED: StreamingSetConfigOutput = {
	success: true,
	applied: {},
	configChange: { result: "applied", attemptId: "attempt-1" },
};
const REFUSED: StreamingSetConfigOutput = {
	success: true,
	applied: {},
	configChange: {
		result: "reverted",
		attemptId: "attempt-1",
		reason: "change_rejected",
	},
};

function renderDesigner(
	composition: CompositionConfig = PRESET,
	isStreaming = false,
) {
	session.streaming = isStreaming;
	return render(LayoutDesigner, {
		props: {
			composition,
			pictureWidth: 1920,
			pictureHeight: 1080,
		},
	});
}

const inset = () => screen.getByTestId("layout-inset");

/** The inset's rectangle as rendered, in fractions of the picture. */
function shownRect() {
	const style = inset().style;
	const fraction = (value: string) =>
		Math.round(Number.parseFloat(value) * 100) / 10_000;
	return {
		x: fraction(style.left),
		y: fraction(style.top),
		width: fraction(style.width),
		height: fraction(style.height),
	};
}

/** Drag a part of the inset by a distance in stage pixels, then release it. */
async function drag(
	target: HTMLElement,
	dx: number,
	dy: number,
	pointerId = 1,
) {
	await fireEvent.pointerDown(target, {
		pointerId,
		button: 0,
		clientX: 100,
		clientY: 100,
	});
	await fireEvent.pointerMove(inset(), {
		pointerId,
		clientX: 100 + dx,
		clientY: 100 + dy,
	});
	await fireEvent.pointerUp(inset(), {
		pointerId,
		clientX: 100 + dx,
		clientY: 100 + dy,
	});
}

const sent = () => setConfig.mock.calls.map(([input]) => input);

describe("LayoutDesigner", () => {
	it("starts from the active preset's rectangle", () => {
		renderDesigner();
		expect(shownRect()).toEqual({ x: 0.45, y: 0.05, width: 0.5, height: 0.5 });
		for (const corner of [
			"top-left",
			"top-right",
			"bottom-left",
			"bottom-right",
		])
			expect(screen.getByTestId(`layout-inset-handle-${corner}`)).toBeTruthy();
	});

	it("has an accessible name and a live description of its position and size", () => {
		renderDesigner();
		expect(inset().getAttribute("aria-label")).toBeTruthy();
		const describedBy = inset().getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		const description = document.getElementById(describedBy ?? "");
		expect(description?.getAttribute("aria-live")).toBe("polite");
		expect(description?.textContent).toMatch(/45.*5.*50.*50/);
	});

	it("its description says that Escape puts it back during a move", () => {
		renderDesigner();
		const description = document.getElementById(
			inset().getAttribute("aria-describedby") ?? "",
		);
		expect(description?.textContent).toContain("Escape");
	});

	it("moves locally while dragging and ends in one setConfig with the clamped rectangle", async () => {
		setConfig.mockResolvedValue(SAVED);
		renderDesigner();
		await fireEvent.pointerDown(inset(), {
			pointerId: 1,
			button: 0,
			clientX: 100,
			clientY: 100,
		});
		await fireEvent.pointerMove(inset(), {
			pointerId: 1,
			clientX: 100 - 256,
			clientY: 100 + 144,
		});
		expect(shownRect()).toEqual({ x: 0.05, y: 0.45, width: 0.5, height: 0.5 });
		expect(setConfig).not.toHaveBeenCalled();
		await fireEvent.pointerMove(inset(), {
			pointerId: 1,
			clientX: 100 + 600,
			clientY: 100 + 600,
		});
		await fireEvent.pointerUp(inset(), {
			pointerId: 1,
			clientX: 100 + 600,
			clientY: 100 + 600,
		});
		expect(sent()).toEqual([
			{ composition_rect: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } },
		]);
	});

	it("resizes from a corner and holds a size below the minimum at the minimum", async () => {
		setConfig.mockResolvedValue(SAVED);
		renderDesigner();
		await drag(
			screen.getByTestId("layout-inset-handle-bottom-left"),
			600,
			-600,
		);
		expect(sent()).toEqual([
			{ composition_rect: { x: 0.825, y: 0.05, width: 0.125, height: 0.125 } },
		]);
	});

	it("resizes from the cap inside each corner too", async () => {
		setConfig.mockResolvedValue(SAVED);
		renderDesigner();
		const cap = inset().querySelector<HTMLElement>(
			'[data-corner-cap="bottom-left"]',
		);
		expect(cap).not.toBeNull();
		await drag(cap as HTMLElement, 600, -600);
		expect(sent()).toEqual([
			{ composition_rect: { x: 0.825, y: 0.05, width: 0.125, height: 0.125 } },
		]);
	});

	it("at the smallest size, a press on the inset's middle moves it without resizing", async () => {
		setConfig.mockResolvedValue(SAVED);
		renderDesigner({
			...PRESET,
			layout: "custom",
			rect: { x: 0.4, y: 0.4, width: 0.125, height: 0.125 },
		});
		await drag(inset(), 64, 36);
		expect(sent()).toEqual([
			{ composition_rect: { x: 0.5, y: 0.5, width: 0.125, height: 0.125 } },
		]);
	});

	it("Escape during a pointer drag puts it back, lets the pointer go and sends nothing", async () => {
		const release = vi.spyOn(HTMLElement.prototype, "releasePointerCapture");
		renderDesigner();
		await fireEvent.pointerDown(inset(), {
			pointerId: 7,
			button: 0,
			clientX: 100,
			clientY: 100,
		});
		await fireEvent.pointerMove(inset(), {
			pointerId: 7,
			clientX: 100 - 256,
			clientY: 100 + 144,
		});
		expect(shownRect()).toEqual({ x: 0.05, y: 0.45, width: 0.5, height: 0.5 });
		await fireEvent.keyDown(inset(), { key: "Escape", code: "Escape" });
		expect(shownRect()).toEqual({ x: 0.45, y: 0.05, width: 0.5, height: 0.5 });
		expect(release).toHaveBeenCalledWith(7);
		await fireEvent.pointerMove(inset(), {
			pointerId: 7,
			clientX: 100 + 300,
			clientY: 100,
		});
		await fireEvent.pointerUp(inset(), {
			pointerId: 7,
			clientX: 100 + 300,
			clientY: 100,
		});
		expect(shownRect()).toEqual({ x: 0.45, y: 0.05, width: 0.5, height: 0.5 });
		expect(setConfig).not.toHaveBeenCalled();
		release.mockRestore();
	});

	it("sends nothing for a press that does not move it", async () => {
		renderDesigner();
		await drag(inset(), 0, 0);
		expect(setConfig).not.toHaveBeenCalled();
	});

	it("while live, the placement asks for the running stream to change now", async () => {
		setConfig.mockResolvedValue(APPLIED);
		renderDesigner(PRESET, true);
		await drag(inset(), -256, 144);
		expect(sent()).toEqual([
			{
				composition_rect: { x: 0.05, y: 0.45, width: 0.5, height: 0.5 },
				apply_now: true,
			},
		]);
	});

	it("a refused change returns to the last applied rectangle and says why", async () => {
		setConfig.mockResolvedValue(REFUSED);
		renderDesigner(
			{
				...PRESET,
				layout: "custom",
				rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 },
			},
			true,
		);
		await drag(inset(), 128, 72);
		await waitFor(() =>
			expect(shownRect()).toEqual({ x: 0.2, y: 0.2, width: 0.3, height: 0.3 }),
		);
		expect(screen.getByRole("alert").textContent?.trim()).not.toBe("");
	});

	it("a typed refusal from the device reads as its own copy, never the raw token", async () => {
		setConfig.mockResolvedValue({
			success: false,
			error: "composition_geometry_unsupported",
			applied: {},
		});
		renderDesigner();
		await drag(inset(), -256, 144);
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent?.trim()).not.toBe(""),
		);
		expect(screen.getByRole("alert").textContent).not.toContain(
			"composition_geometry_unsupported",
		);
		expect(shownRect()).toEqual({ x: 0.45, y: 0.05, width: 0.5, height: 0.5 });
	});

	it("arrow keys move it by 1% and send once, when the last key comes up", async () => {
		setConfig.mockResolvedValue(SAVED);
		renderDesigner();
		inset().focus();
		await fireEvent.keyDown(inset(), { key: "ArrowRight", code: "ArrowRight" });
		await fireEvent.keyDown(inset(), { key: "ArrowDown", code: "ArrowDown" });
		expect(shownRect()).toEqual({ x: 0.46, y: 0.06, width: 0.5, height: 0.5 });
		await fireEvent.keyUp(inset(), { key: "ArrowRight", code: "ArrowRight" });
		expect(setConfig).not.toHaveBeenCalled();
		await fireEvent.keyUp(inset(), { key: "ArrowDown", code: "ArrowDown" });
		expect(sent()).toEqual([
			{ composition_rect: { x: 0.46, y: 0.06, width: 0.5, height: 0.5 } },
		]);
	});

	it("Shift moves by 5% and Alt resizes", async () => {
		setConfig.mockResolvedValue(SAVED);
		renderDesigner();
		inset().focus();
		await fireEvent.keyDown(inset(), {
			key: "ArrowLeft",
			code: "ArrowLeft",
			shiftKey: true,
		});
		await fireEvent.keyDown(inset(), {
			key: "ArrowUp",
			code: "ArrowUp",
			altKey: true,
		});
		await fireEvent.keyUp(inset(), { key: "ArrowLeft", code: "ArrowLeft" });
		await fireEvent.keyUp(inset(), { key: "ArrowUp", code: "ArrowUp" });
		expect(sent()).toEqual([
			{ composition_rect: { x: 0.4, y: 0.05, width: 0.5, height: 0.49 } },
		]);
	});

	it("a drag released before the previous answer waits for it, then is sent", async () => {
		let answer: (value: StreamingSetConfigOutput) => void = () => undefined;
		setConfig.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		setConfig.mockResolvedValue(APPLIED);
		renderDesigner(PRESET, true);
		await drag(inset(), -256, 0, 1);
		await drag(inset(), 0, 144, 2);
		expect(sent()).toHaveLength(1);
		expect(shownRect()).toEqual({ x: 0.05, y: 0.45, width: 0.5, height: 0.5 });
		answer(APPLIED);
		await waitFor(() => expect(sent()).toHaveLength(2));
		expect(sent()).toEqual([
			{
				composition_rect: { x: 0.05, y: 0.05, width: 0.5, height: 0.5 },
				apply_now: true,
			},
			{
				composition_rect: { x: 0.05, y: 0.45, width: 0.5, height: 0.5 },
				apply_now: true,
			},
		]);
	});

	it("of several drags released before an answer, only the newest is sent next", async () => {
		let answer: (value: StreamingSetConfigOutput) => void = () => undefined;
		setConfig.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		setConfig.mockResolvedValue(SAVED);
		renderDesigner();
		await drag(inset(), -256, 0, 1);
		await drag(inset(), 0, 72, 2);
		await drag(inset(), 0, 72, 3);
		answer(SAVED);
		await waitFor(() => expect(sent()).toHaveLength(2));
		expect(sent()[1]).toEqual({
			composition_rect: { x: 0.05, y: 0.45, width: 0.5, height: 0.5 },
		});
	});

	it("follows the device's saved rectangle once nothing is in flight", async () => {
		const view = renderDesigner({
			...PRESET,
			layout: "custom",
			rect: { x: 0.1, y: 0.1, width: 0.25, height: 0.25 },
		});
		expect(shownRect()).toEqual({ x: 0.1, y: 0.1, width: 0.25, height: 0.25 });
		await view.rerender({
			composition: {
				...PRESET,
				layout: "custom",
				rect: { x: 0.6, y: 0.5, width: 0.4, height: 0.5 },
			},
			pictureWidth: 1920,
			pictureHeight: 1080,
		});
		expect(shownRect()).toEqual({ x: 0.6, y: 0.5, width: 0.4, height: 0.5 });
	});
});
