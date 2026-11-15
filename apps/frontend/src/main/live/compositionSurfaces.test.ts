// @vitest-environment jsdom
/**
 * The layout card and the layout designer share the tab's one composition lane
 * (`compositionWrites`). With the device's answers held, a drag released while
 * an earlier one is unanswered waits; a newer change on the card (a layout tap,
 * turning composition off) drops that waiting drag, so it is never sent after
 * the operator's newer choice.
 */
import type {
	CaptureStreamSource,
	CompositionConfig,
	ConfigMessage,
	SourcesMessage,
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
vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig } },
	rpcClient: {},
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfigChange: () => undefined,
}));

import CompositionCard from "./CompositionCard.svelte";
import LayoutDesigner from "./LayoutDesigner.svelte";

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
		get: () => 640,
	});
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get: () => 360,
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

function capture(id: string, displayName: string): CaptureStreamSource {
	return {
		origin: "capture",
		id,
		pipelineId: "hdmi",
		kind: "hdmi",
		displayName,
		devicePath: id,
		modes: [],
		supportsAudio: false,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: "none",
		available: true,
	};
}

const SOURCES: SourcesMessage = {
	hardware: "rk3588",
	sources: [
		capture("/dev/video0", "Primary Cam"),
		capture("/dev/video1", "Second Cam"),
	],
};
const COMPOSITION: CompositionConfig = {
	secondary_input_id: "/dev/video1",
	layout: "custom",
	alpha: 1,
	rect: { x: 0.45, y: 0.05, width: 0.5, height: 0.5 },
};
const SAVED: StreamingSetConfigOutput = { success: true, applied: {} };
const APPLIED: StreamingSetConfigOutput = {
	success: true,
	applied: {},
	configChange: { result: "applied", attemptId: "attempt-1" },
};

/** The card and the designer on one tab, against a device that answers only when told. */
function renderBoth(isStreaming: boolean) {
	const answers: Array<(result: StreamingSetConfigOutput) => void> = [];
	setConfig.mockImplementation(
		() =>
			new Promise((resolve) => {
				answers.push(resolve);
			}),
	);
	render(CompositionCard, {
		props: {
			sources: SOURCES,
			config: {
				source: "/dev/video0",
				composition: COMPOSITION,
			} as unknown as ConfigMessage,
			isStreaming,
			geometry: true,
		},
	});
	render(LayoutDesigner, {
		props: {
			composition: COMPOSITION,
			isStreaming,
			pictureWidth: 1920,
			pictureHeight: 1080,
		},
	});
	return {
		answer: (result: StreamingSetConfigOutput) => answers.shift()?.(result),
		waiting: () => answers.length,
	};
}

const inset = () => screen.getByTestId("layout-inset");
const sent = () => setConfig.mock.calls.map(([input]) => input);

async function drag(dx: number, dy: number, pointerId: number) {
	await fireEvent.pointerDown(inset(), {
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

const FIRST = { x: 0.05, y: 0.05, width: 0.5, height: 0.5 };

describe("the layout card and the layout designer share one ordered lane", () => {
	it("idle: a layout tap drops the drag still waiting, and is sent after the one in flight", async () => {
		const device = renderBoth(false);
		await drag(-256, 0, 1);
		await drag(0, 144, 2);
		await fireEvent.click(
			screen.getByTestId("composition-layout-pbp-left-right"),
		);
		expect(sent()).toEqual([{ composition_rect: FIRST }]);

		device.answer(SAVED);
		await waitFor(() => expect(sent()).toHaveLength(2));
		device.answer(SAVED);
		await waitFor(() => expect(device.waiting()).toBe(0));
		expect(sent()).toEqual([
			{ composition_rect: FIRST },
			{ composition_patch: { layout: "pbp-left-right" } },
		]);
	});

	it("idle: turning composition off drops the drag still waiting", async () => {
		const device = renderBoth(false);
		await drag(-256, 0, 1);
		await drag(0, 144, 2);
		await fireEvent.click(screen.getByTestId("composition-enable"));

		device.answer(SAVED);
		await waitFor(() => expect(sent()).toHaveLength(2));
		device.answer(SAVED);
		expect(sent()).toEqual([
			{ composition_rect: FIRST },
			{ composition: null },
		]);
	});

	it("live: the same, with every write asking for the running stream to change now", async () => {
		const device = renderBoth(true);
		await drag(-256, 0, 1);
		await drag(0, 144, 2);
		await fireEvent.click(
			screen.getByTestId("composition-layout-pbp-top-bottom"),
		);

		device.answer(APPLIED);
		await waitFor(() => expect(sent()).toHaveLength(2));
		device.answer(APPLIED);
		await waitFor(() => expect(device.waiting()).toBe(0));
		expect(sent()).toEqual([
			{ composition_rect: FIRST, apply_now: true },
			{ composition_patch: { layout: "pbp-top-bottom" }, apply_now: true },
		]);
	});

	it("a drag made after a card change waits for it, and is then sent", async () => {
		const device = renderBoth(false);
		await fireEvent.click(
			screen.getByTestId("composition-layout-pip-top-left"),
		);
		await drag(-256, 0, 1);
		expect(sent()).toEqual([{ composition_patch: { layout: "pip-top-left" } }]);

		device.answer(SAVED);
		await waitFor(() => expect(sent()).toHaveLength(2));
		device.answer(SAVED);
		expect(sent()[1]).toEqual({ composition_rect: FIRST });
	});
});
