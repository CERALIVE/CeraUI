// @vitest-environment jsdom
/**
 * CompositionCard's seventh layout, `custom` (Live screen contract, "The layout
 * designer").
 *
 *   • the radio exists only when the engine advertises `composition-geometry`;
 *   • choosing it sends `custom` alone (`composition_patch`): the device takes
 *     the rectangle of the preset it has saved; with `apply_now: true` live;
 *   • every other control sends only its own field, so the device keeps its
 *     saved rectangle and every other field;
 *   • with the preview closed, the radio carries the hint to open it.
 */
import type {
	CaptureStreamSource,
	ConfigMessage,
	SourcesMessage,
	StreamingSetConfigOutput,
} from "@ceraui/rpc/schemas";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
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
const session = vi.hoisted(() => ({ streaming: false }));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfigChange: () => undefined,
	getIsStreaming: () => session.streaming,
}));

import CompositionCard from "./CompositionCard.svelte";
import { previewDisclosure } from "./previewDisclosure.svelte";

beforeAll(() => {
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
	previewDisclosure.open = false;
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

function config(composition: Record<string, unknown>): ConfigMessage {
	return { source: "/dev/video0", composition } as unknown as ConfigMessage;
}

const PRESET = config({
	secondary_input_id: "/dev/video1",
	layout: "pip-bottom-left",
	alpha: 1,
});
const CUSTOM = config({
	secondary_input_id: "/dev/video1",
	layout: "custom",
	alpha: 1,
	rect: { x: 0.3, y: 0.2, width: 0.25, height: 0.25 },
});

function renderCard(
	props: {
		config?: ConfigMessage;
		isStreaming?: boolean;
		geometry?: boolean;
	} = {},
) {
	session.streaming = props.isStreaming ?? false;
	return render(CompositionCard, {
		props: {
			sources: SOURCES,
			config: props.config ?? PRESET,
			isStreaming: props.isStreaming ?? false,
			geometry: props.geometry ?? true,
		},
	});
}

const radios = () =>
	screen
		.getByTestId("composition-layout-selector")
		.querySelectorAll('[role="radio"]');

describe("CompositionCard — custom layout", () => {
	it("offers no custom radio when the engine does not advertise free geometry", () => {
		renderCard({ geometry: false });
		expect(radios()).toHaveLength(6);
		expect(screen.queryByTestId("composition-layout-custom")).toBeNull();
	});

	it("adds a seventh radio when it does", () => {
		renderCard();
		expect(radios()).toHaveLength(7);
		expect(
			screen
				.getByTestId("composition-layout-custom")
				.getAttribute("aria-checked"),
		).toBe("false");
	});

	it("idle, choosing it asks the device to place the second input where its preset puts it", async () => {
		setConfig.mockResolvedValue({ success: true, applied: {} });
		renderCard();
		await fireEvent.click(screen.getByTestId("composition-layout-custom"));
		expect(setConfig.mock.calls.map(([input]) => input)).toEqual([
			{ composition_patch: { layout: "custom" } },
		]);
	});

	it("live, the same choice changes the running stream", async () => {
		setConfig.mockResolvedValue({
			success: true,
			applied: {},
			configChange: { result: "applied", attemptId: "attempt-1" },
		});
		renderCard({ isStreaming: true });
		await fireEvent.click(screen.getByTestId("composition-layout-custom"));
		expect(setConfig.mock.calls.map(([input]) => input)).toEqual([
			{ composition_patch: { layout: "custom" }, apply_now: true },
		]);
	});

	it("shows custom as the choice when it is saved, and no preset", () => {
		renderCard({ config: CUSTOM });
		expect(
			screen
				.getByTestId("composition-layout-custom")
				.getAttribute("aria-checked"),
		).toBe("true");
		for (const radio of radios())
			if (radio !== screen.getByTestId("composition-layout-custom"))
				expect(radio.getAttribute("aria-checked")).toBe("false");
	});

	it("choosing custom again sends nothing", async () => {
		renderCard({ config: CUSTOM });
		await fireEvent.click(screen.getByTestId("composition-layout-custom"));
		expect(setConfig).not.toHaveBeenCalled();
	});

	it("live and custom, another control's change leaves the rectangle to the device", async () => {
		setConfig.mockResolvedValue({
			success: true,
			applied: {},
			configChange: { result: "applied", attemptId: "attempt-1" },
		});
		renderCard({ config: CUSTOM, isStreaming: true });
		await fireEvent.click(
			screen.getByTestId("composition-layout-pbp-top-bottom"),
		);
		const [input] = setConfig.mock.calls[0] ?? [];
		expect(input).toEqual({
			composition_patch: { layout: "pbp-top-bottom" },
			apply_now: true,
		});
	});

	it("with the preview closed, the radio carries the hint to open it", () => {
		previewDisclosure.open = false;
		renderCard();
		const custom = screen.getByTestId("composition-layout-custom");
		const hintId = custom.getAttribute("aria-describedby");
		expect(hintId).toBeTruthy();
		expect(document.getElementById(hintId ?? "")?.textContent?.trim()).not.toBe(
			"",
		);
	});

	it("with the preview open, there is no hint", () => {
		previewDisclosure.open = true;
		renderCard();
		expect(
			screen
				.getByTestId("composition-layout-custom")
				.hasAttribute("aria-describedby"),
		).toBe(false);
	});
});
