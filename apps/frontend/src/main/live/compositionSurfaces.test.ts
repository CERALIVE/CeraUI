// @vitest-environment jsdom
/**
 * The layout card, the layout designer, Start and Stop share the tab's one
 * lane (`compositionWrites`). With the device's answers held, a drag released
 * while an earlier one is unanswered waits; a newer change on the card (a
 * layout tap, turning composition off) drops that waiting drag, so it is never
 * sent after the operator's newer choice. A Start or a Stop drops nothing: what
 * was made before it is sent before it, and every write's `apply_now` follows
 * the session when the write is sent, not when it was made.
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
const start = vi.hoisted(() => vi.fn<(input?: unknown) => Promise<unknown>>());
const stop = vi.hoisted(() => vi.fn<(input?: unknown) => Promise<unknown>>());
vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig, start, stop } },
	rpcClient: {},
}));
vi.mock("$lib/rpc/client", () => ({
	rpc: { streaming: { setConfig, start, stop } },
	rpcClient: {},
}));
const session = vi.hoisted(() => ({ streaming: false }));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfigChange: () => undefined,
	getIsStreaming: () => session.streaming,
}));

import { startStreaming, stopStreaming } from "$lib/helpers/SystemHelper";

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

const STARTED = { success: true, is_streaming: true };
const STOPPED = { success: true, result: "stopped" };

afterEach(async () => {
	cleanup();
	// Every test ends with no session, as the device would after a Stop.
	stop.mockReset();
	stop.mockResolvedValue(STOPPED);
	await stopStreaming();
	session.streaming = false;
	setConfig.mockReset();
	start.mockReset();
	stop.mockReset();
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

/**
 * The card and the designer on one tab, against a device that answers each
 * setConfig, start and stop only when told, recording them in one ordered log.
 */
function renderBoth(isStreaming: boolean) {
	session.streaming = isStreaming;
	const answers: Array<(result: unknown) => void> = [];
	const calls: Array<[string, unknown]> = [];
	const held =
		(path: string) =>
		(input?: unknown): Promise<never> =>
			new Promise((resolve) => {
				calls.push([path, input]);
				answers.push(resolve as (result: unknown) => void);
			});
	setConfig.mockImplementation(held("setConfig"));
	start.mockImplementation(held("start"));
	stop.mockImplementation(held("stop"));
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
			pictureWidth: 1920,
			pictureHeight: 1080,
		},
	});
	return {
		answer: (result: unknown) => answers.shift()?.(result),
		waiting: () => answers.length,
		log: () => calls,
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
const SECOND = { x: 0.05, y: 0.45, width: 0.5, height: 0.5 };
const START_CONFIG = {
	pipeline: "hdmi",
	srtla_addr: "10.0.0.1",
	srtla_port: 5000,
} as unknown as ConfigMessage;

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

describe("Start and Stop wait in the same lane", () => {
	it("idle: drags released before Start go out idle before it, so Start runs the newest", async () => {
		const device = renderBoth(false);
		await drag(-256, 0, 1);
		await drag(0, 144, 2);
		const started = startStreaming(START_CONFIG);
		expect(device.log()).toEqual([["setConfig", { composition_rect: FIRST }]]);

		device.answer(SAVED);
		await waitFor(() => expect(device.log()).toHaveLength(2));
		device.answer(SAVED);
		await waitFor(() => expect(device.log()).toHaveLength(3));
		device.answer(STARTED);
		await expect(started).resolves.toEqual(STARTED);
		expect(device.log()).toEqual([
			["setConfig", { composition_rect: FIRST }],
			["setConfig", { composition_rect: SECOND }],
			["start", expect.objectContaining({ pipeline: "hdmi" })],
		]);
	});

	it("a drag made while Start is unanswered waits for it and changes the running stream, even before the device's status says live", async () => {
		const device = renderBoth(false);
		const started = startStreaming(START_CONFIG);
		await drag(-256, 0, 1);
		expect(device.log()).toEqual([["start", expect.anything()]]);

		device.answer(STARTED);
		await started;
		await waitFor(() => expect(device.log()).toHaveLength(2));
		device.answer(APPLIED);
		expect(device.log()[1]).toEqual([
			"setConfig",
			{ composition_rect: FIRST, apply_now: true },
		]);
	});

	it("after a refused Start the next write only saves", async () => {
		const device = renderBoth(false);
		const started = startStreaming(START_CONFIG);
		device.answer({ success: false, error: "START_IN_PROGRESS" });
		await started;
		await drag(-256, 0, 1);
		await waitFor(() => expect(device.log()).toHaveLength(2));
		device.answer(SAVED);
		expect(device.log()[1]).toEqual(["setConfig", { composition_rect: FIRST }]);
	});

	it("live: drags released before Stop change the running stream before it, and a drag after Stop only saves", async () => {
		const device = renderBoth(true);
		await drag(-256, 0, 1);
		await drag(0, 144, 2);
		const stopped = stopStreaming();

		device.answer(APPLIED);
		await waitFor(() => expect(device.log()).toHaveLength(2));
		device.answer(APPLIED);
		await waitFor(() => expect(device.log()).toHaveLength(3));
		session.streaming = false;
		device.answer(STOPPED);
		await stopped;
		await drag(-128, 0, 3);
		await waitFor(() => expect(device.log()).toHaveLength(4));
		device.answer(SAVED);
		expect(device.log()).toEqual([
			["setConfig", { composition_rect: FIRST, apply_now: true }],
			["setConfig", { composition_rect: SECOND, apply_now: true }],
			["stop", undefined],
			[
				"setConfig",
				{ composition_rect: { x: 0.25, y: 0.05, width: 0.5, height: 0.5 } },
			],
		]);
	});

	it("a card change made idle and sent after Start changes the running stream too", async () => {
		const device = renderBoth(false);
		await fireEvent.click(
			screen.getByTestId("composition-layout-pip-top-left"),
		);
		const started = startStreaming(START_CONFIG);
		device.answer(SAVED);
		await waitFor(() => expect(device.log()).toHaveLength(2));
		device.answer(STARTED);
		await started;
		await fireEvent.click(
			screen.getByTestId("composition-layout-pbp-left-right"),
		);
		await waitFor(() => expect(device.log()).toHaveLength(3));
		device.answer(APPLIED);
		expect(device.log()).toEqual([
			["setConfig", { composition_patch: { layout: "pip-top-left" } }],
			["start", expect.anything()],
			[
				"setConfig",
				{ composition_patch: { layout: "pbp-left-right" }, apply_now: true },
			],
		]);
	});

	it("a session that ends by itself: a placement still waiting goes out once the device says idle, and only saves", async () => {
		const device = renderBoth(true);
		await drag(-256, 0, 1);
		await drag(0, 144, 2);
		session.streaming = false;
		device.answer(SAVED);
		await waitFor(() => expect(device.log()).toHaveLength(2));
		device.answer(SAVED);
		expect(device.log()).toEqual([
			["setConfig", { composition_rect: FIRST, apply_now: true }],
			["setConfig", { composition_rect: SECOND }],
		]);
	});
});
