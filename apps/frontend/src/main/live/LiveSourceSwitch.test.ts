// @vitest-environment jsdom
/**
 * LiveSourceSwitch — the live capture-source switch card (Task T12).
 *
 * Locks the plan's acceptance:
 *   • R7-2: with a capture session + ≥2 capture sources, the card renders one row
 *     per capture with the ACTIVE row disabled + labeled "Active"; a non-active row
 *     dispatches onSwitch; below 2 capture sources the card renders NOTHING;
 *   • R8-1: when the CURRENTLY-RUNNING source is network (rtmp/srt) or virtual (test
 *     pattern) the card is ABSENT from the DOM (zero `data-switch-input` buttons)
 *     even when ≥2 capture sources exist — a leg-less session can't switch inputs.
 *
 * The switch buttons mirror SourceSection's streaming-branch contract exactly
 * (`data-switch-input`, disabled/label semantics).
 */
import type {
	ActiveEncode,
	SourcesMessage,
	StreamSource,
} from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import LiveSourceSwitch from "./LiveSourceSwitch.svelte";

function capture(id: string, displayName: string): StreamSource {
	return {
		id,
		pipelineId: `${id}-pipe`,
		modes: [],
		supportsAudio: false,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: "none",
		available: true,
		origin: "capture",
		kind: "hdmi",
		displayName,
		devicePath: `/dev/${id}`,
	};
}

function network(id: string): StreamSource {
	return {
		id,
		pipelineId: `${id}-pipe`,
		modes: [],
		supportsAudio: true,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: "embedded",
		available: true,
		origin: "network",
		labelKey: "live.inputPicker.groups.network",
		requiresGateway: "rtmp",
		url: null,
	};
}

function virtual(id: string): StreamSource {
	return {
		id,
		pipelineId: `${id}-pipe`,
		modes: [],
		supportsAudio: false,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: "none",
		available: true,
		origin: "virtual",
		labelKey: "live.inputPicker.groups.test",
	};
}

function makeSources(...list: StreamSource[]): SourcesMessage {
	return { hardware: "rk3588", sources: list };
}

function renderSwitch(
	over: {
		sources?: SourcesMessage;
		runningId?: string;
		activeInput?: string;
		switchingInput?: string;
		onSwitch?: (id: string) => void;
	} = {},
) {
	const onSwitch = over.onSwitch ?? vi.fn();
	const view = render(LiveSourceSwitch, {
		props: {
			sources: over.sources,
			config: undefined,
			activeEncode: over.runningId
				? ({ active_input: over.runningId } as ActiveEncode)
				: null,
			activeInput: over.activeInput,
			switchingInput: over.switchingInput,
			onSwitch,
		},
	});
	return { ...view, onSwitch };
}

describe("LiveSourceSwitch — R7-2: capture rows + switch semantics", () => {
	it("renders one row per capture with the active row disabled + labeled Active", () => {
		const { container } = renderSwitch({
			sources: makeSources(
				capture("cam-1", "HDMI Capture"),
				capture("cam-2", "USB Cam"),
			),
			runningId: "cam-1",
			activeInput: "cam-1",
		});

		expect(
			container.querySelector('[data-testid="live-source-switch"]'),
		).not.toBeNull();

		const activeBtn = container.querySelector<HTMLButtonElement>(
			'[data-switch-input="cam-1"]',
		);
		expect(activeBtn?.disabled).toBe(true);
		expect(activeBtn?.textContent?.trim()).toBe("Active");

		const otherBtn = container.querySelector<HTMLButtonElement>(
			'[data-switch-input="cam-2"]',
		);
		expect(otherBtn?.disabled).toBe(false);
		expect(otherBtn?.textContent?.trim()).toBe("Switch");
	});

	it("dispatches onSwitch when a non-active row is clicked", async () => {
		const { container, onSwitch } = renderSwitch({
			sources: makeSources(
				capture("cam-1", "HDMI Capture"),
				capture("cam-2", "USB Cam"),
			),
			runningId: "cam-1",
			activeInput: "cam-1",
		});
		await fireEvent.click(
			container.querySelector('[data-switch-input="cam-2"]') as HTMLElement,
		);
		expect(onSwitch).toHaveBeenCalledWith("cam-2");
	});

	it("shows the Switching label + disables the in-flight row", () => {
		const { container } = renderSwitch({
			sources: makeSources(
				capture("cam-1", "HDMI Capture"),
				capture("cam-2", "USB Cam"),
			),
			runningId: "cam-1",
			activeInput: "cam-1",
			switchingInput: "cam-2",
		});
		const btn = container.querySelector<HTMLButtonElement>(
			'[data-switch-input="cam-2"]',
		);
		expect(btn?.disabled).toBe(true);
		expect(btn?.textContent?.trim()).toBe("Switching\u2026");
	});

	it("renders NOTHING with fewer than 2 capture sources", () => {
		const { container } = renderSwitch({
			sources: makeSources(capture("cam-1", "HDMI Capture")),
			runningId: "cam-1",
			activeInput: "cam-1",
		});
		expect(
			container.querySelector('[data-testid="live-source-switch"]'),
		).toBeNull();
		expect(container.querySelectorAll("[data-switch-input]").length).toBe(0);
	});
});

describe("LiveSourceSwitch — R8-1: absent for non-capture running sources", () => {
	it("running source is network (rtmp) → card absent even with ≥2 captures", () => {
		const { container } = renderSwitch({
			sources: makeSources(
				network("rtmp"),
				capture("cam-1", "HDMI Capture"),
				capture("cam-2", "USB Cam"),
			),
			runningId: "rtmp",
		});
		expect(
			container.querySelector('[data-testid="live-source-switch"]'),
		).toBeNull();
		expect(container.querySelectorAll("[data-switch-input]").length).toBe(0);
	});

	it("running source is virtual (test pattern) → card absent even with ≥2 captures", () => {
		const { container } = renderSwitch({
			sources: makeSources(
				virtual("test"),
				capture("cam-1", "HDMI Capture"),
				capture("cam-2", "USB Cam"),
			),
			runningId: "test",
		});
		expect(
			container.querySelector('[data-testid="live-source-switch"]'),
		).toBeNull();
		expect(container.querySelectorAll("[data-switch-input]").length).toBe(0);
	});

	it("running source is capture → card renders with two switch buttons", () => {
		const { container } = renderSwitch({
			sources: makeSources(
				capture("cam-1", "HDMI Capture"),
				capture("cam-2", "USB Cam"),
			),
			runningId: "cam-1",
			activeInput: "cam-1",
		});
		expect(
			container.querySelector('[data-testid="live-source-switch"]'),
		).not.toBeNull();
		expect(container.querySelectorAll("[data-switch-input]").length).toBe(2);
	});
});
