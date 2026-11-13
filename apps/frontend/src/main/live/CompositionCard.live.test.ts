// @vitest-environment jsdom
/**
 * CompositionCard while live — the layout, the opacity and the second input
 * change on the running stream (Live screen contract, change 2).
 *
 *   • live, a layout tap writes the FULL composition with `apply_now: true`, so
 *     the backend stages it as an apply-now transaction instead of saving it for
 *     the next start;
 *   • a change the engine refuses leaves the previous layout running, so the
 *     previous radio is checked again and the reason is on screen;
 *   • turning composition on or off still waits for the next start: only the
 *     enable switch stays locked, with the locked text beside it;
 *   • idle, the same tap is the unchanged plain save (no `apply_now`).
 */
import type {
	CaptureStreamSource,
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

import type { ConfigChangeView } from "$lib/streaming/configChangePhase";

const setConfig = vi.hoisted(() =>
	vi.fn<
		(input: Record<string, unknown>) => Promise<StreamingSetConfigOutput>
	>(),
);
vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig } },
	rpcClient: {},
}));

// The config-change store is fed by the socket in the app; here each test sets
// the phase it needs before rendering.
const configChange = vi.hoisted(() => ({
	view: undefined as ConfigChangeView,
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfigChange: () => configChange.view,
}));

import CompositionCard from "./CompositionCard.svelte";

beforeAll(() => {
	// bits-ui's Slider installs a ResizeObserver, absent in jsdom.
	if (!("ResizeObserver" in window)) {
		(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		};
	}
});

afterEach(() => {
	cleanup();
	setConfig.mockReset();
	configChange.view = undefined;
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

const SAVED = {
	secondary_input_id: "/dev/video1",
	layout: "pip-top-right",
	alpha: 1,
} as const;

const CONFIG = {
	source: "/dev/video0",
	composition: SAVED,
} as unknown as ConfigMessage;

const APPLIED: StreamingSetConfigOutput = {
	success: true,
	applied: {},
	configChange: { result: "applied", attemptId: "attempt-1" },
};

// What the backend answers when the engine refuses the parameters: the save is
// accepted, the transaction never began, the previous composition is on air.
const REFUSED: StreamingSetConfigOutput = {
	success: true,
	applied: {},
	configChange: {
		result: "reverted",
		attemptId: "attempt-1",
		reason: "change_rejected",
	},
};

function renderCard(isStreaming: boolean) {
	return render(CompositionCard, {
		props: { sources: SOURCES, config: CONFIG, isStreaming },
	});
}

function radio(layout: string): HTMLElement {
	return screen.getByTestId(`composition-layout-${layout}`);
}

describe("CompositionCard — live layout, opacity and second input", () => {
	it("streaming: a layout tap writes the full composition with apply_now", async () => {
		setConfig.mockResolvedValue(APPLIED);
		renderCard(true);

		await fireEvent.click(radio("pbp-left-right"));

		expect(setConfig).toHaveBeenCalledTimes(1);
		expect(setConfig).toHaveBeenCalledWith({
			composition: {
				secondary_input_id: "/dev/video1",
				layout: "pbp-left-right",
				alpha: 1,
			},
			apply_now: true,
		});
	});

	it("streaming: a refused change checks the previous radio again and shows the reason", async () => {
		let answer: (value: StreamingSetConfigOutput) => void = () => undefined;
		setConfig.mockReturnValue(
			new Promise<StreamingSetConfigOutput>((resolve) => {
				answer = resolve;
			}),
		);
		renderCard(true);

		await fireEvent.click(radio("pbp-left-right"));

		// While the engine works on it, the tapped layout shows as the choice and
		// the group says it is busy.
		await waitFor(() =>
			expect(radio("pbp-left-right").getAttribute("aria-checked")).toBe("true"),
		);
		expect(
			screen
				.getByTestId("composition-layout-selector")
				.getAttribute("aria-busy"),
		).toBe("true");

		answer(REFUSED);

		await waitFor(() =>
			expect(radio("pip-top-right").getAttribute("aria-checked")).toBe("true"),
		);
		expect(radio("pbp-left-right").getAttribute("aria-checked")).toBe("false");
		const reason = screen.getByText(/previous settings are still running/);
		expect(reason.textContent).toContain(
			"The device couldn't use those settings.",
		);
		expect(reason.closest('[role="alert"]')).not.toBeNull();
	});

	it("streaming: an opacity step writes the new opacity with apply_now", async () => {
		setConfig.mockResolvedValue(APPLIED);
		renderCard(true);

		const thumb = screen
			.getByTestId("composition-alpha-control")
			.querySelector<HTMLElement>('[data-slot="slider-thumb"]');
		if (thumb === null) throw new Error("opacity thumb not rendered");
		await fireEvent.keyDown(thumb, { key: "ArrowLeft" });

		expect(setConfig).toHaveBeenCalledTimes(1);
		const [input] = setConfig.mock.calls[0] ?? [];
		expect(input).toMatchObject({
			composition: {
				secondary_input_id: "/dev/video1",
				layout: "pip-top-right",
			},
			apply_now: true,
		});
		const written = input?.composition as { alpha: number };
		expect(written.alpha).toBeCloseTo(0.95);
	});

	it("streaming: only the enable switch stays locked, with the locked text beside it", () => {
		renderCard(true);

		expect(
			screen.getByTestId("composition-enable").hasAttribute("disabled"),
		).toBe(true);
		expect(screen.getByTestId("composition-locked").textContent).toContain(
			"Stop the stream to change this.",
		);
		for (const layout of [
			"pip-top-right",
			"pip-top-left",
			"pip-bottom-right",
			"pip-bottom-left",
			"pbp-left-right",
			"pbp-top-bottom",
		]) {
			expect(radio(layout).hasAttribute("disabled")).toBe(false);
		}
		expect(
			screen
				.getByTestId("composition-secondary")
				.querySelector("#composition-secondary-trigger")
				?.hasAttribute("disabled"),
		).toBe(false);
		expect(
			screen
				.getByTestId("composition-alpha-control")
				.querySelector('[data-slot="slider"]')
				?.hasAttribute("data-disabled"),
		).toBe(false);
	});

	it("streaming: while another change is applying, the controls wait for it", async () => {
		configChange.view = { attemptId: "other", phase: "applying" };
		renderCard(true);

		expect(
			screen
				.getByTestId("composition-layout-selector")
				.getAttribute("aria-busy"),
		).toBe("true");
		expect(radio("pbp-left-right").hasAttribute("disabled")).toBe(true);
		await fireEvent.click(radio("pbp-left-right"));
		expect(setConfig).not.toHaveBeenCalled();
	});

	it("idle: the same tap saves the composition without apply_now", async () => {
		setConfig.mockResolvedValue({ success: true, applied: {} });
		renderCard(false);

		expect(screen.queryByTestId("composition-locked")).toBeNull();
		await fireEvent.click(radio("pbp-left-right"));

		expect(setConfig).toHaveBeenCalledTimes(1);
		const [input] = setConfig.mock.calls[0] ?? [];
		expect(input).toEqual({
			composition: {
				secondary_input_id: "/dev/video1",
				layout: "pbp-left-right",
				alpha: 1,
			},
		});
		expect(input).not.toHaveProperty("apply_now");
	});
});
