// @vitest-environment jsdom
/**
 * LiveCockpit — post-stream summary "Done" close button (Task T13).
 *
 * Locks the plan's acceptance:
 *   • in summaryMode the footer renders `summary-done`; clicking it fires
 *     `onCloseSummary`;
 *   • outside summaryMode `summary-done` is ABSENT (the Stop control renders
 *     instead), so the escape hatch never leaks into the live surface;
 *   • double-clicking Done is idempotent — the callback simply fires again with
 *     no thrown error (LiveView's closeSummary is idempotent at the source).
 */
import type { LinkTelemetryMessage, SourcesMessage } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { StreamingOptimismState } from "$lib/rpc/streaming-optimism.svelte";
import type { ActiveSummary } from "$lib/streaming/sourceSummary";
import LiveCockpit from "./LiveCockpit.svelte";

beforeAll(() => {
	// The live-mode BitrateAdjuster (bits-ui Slider) installs a ResizeObserver,
	// absent in jsdom — needed only by the non-summaryMode render branch.
	if (!("ResizeObserver" in window)) {
		(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		};
	}
});

const SUMMARY: ActiveSummary = {
	live: true,
	source: "HDMI Capture",
	resolution: "1080p",
	framerate: 60,
	codec: "H.265",
	inputCodec: undefined,
	passthrough: undefined,
	transport: "SRTLA",
};

function cockpit(
	over: Partial<{
		summaryMode: boolean;
		onCloseSummary: () => void;
		telemetry: LinkTelemetryMessage | null;
		isStreaming: boolean;
		optimismState: StreamingOptimismState;
	}> = {},
) {
	return render(LiveCockpit, {
		props: {
			liveSummary: SUMMARY,
			sources: undefined as SourcesMessage | undefined,
			bitrate: "6 Mbps",
			bitrateDraft: 6000,
			bitrateLabel: "6 Mbps",
			bitrateMin: 500,
			bitrateMax: 12000,
			sliderMin: 1000,
			sliderMax: 9000,
			step: 250,
			onStep: () => {},
			onSliderChange: () => {},
			onSliderCommit: () => {},
			telemetry: over.telemetry ?? null,
			isStreaming: over.isStreaming ?? false,
			optimismState: over.optimismState ?? ("idle" as StreamingOptimismState),
			onStop: () => {},
			summaryMode: over.summaryMode ?? false,
			onCloseSummary: over.onCloseSummary,
		},
	});
}

describe("LiveCockpit — post-stream Done button", () => {
	it("renders summary-done in summaryMode and fires onCloseSummary on click", async () => {
		const onCloseSummary = vi.fn();
		const { getByTestId } = cockpit({ summaryMode: true, onCloseSummary });

		const done = getByTestId("summary-done");
		expect(done).not.toBeNull();

		await fireEvent.click(done);
		expect(onCloseSummary).toHaveBeenCalledTimes(1);
	});

	it("does NOT render summary-done outside summaryMode", () => {
		const { queryByTestId } = cockpit({
			summaryMode: false,
			isStreaming: true,
			optimismState: "streaming" as StreamingOptimismState,
		});
		expect(queryByTestId("summary-done")).toBeNull();
	});

	it("double-clicking Done is idempotent — no error, callback fires each time", async () => {
		const onCloseSummary = vi.fn();
		const { getByTestId } = cockpit({ summaryMode: true, onCloseSummary });

		const done = getByTestId("summary-done");
		await fireEvent.click(done);
		await fireEvent.click(done);

		expect(onCloseSummary).toHaveBeenCalledTimes(2);
	});
});
