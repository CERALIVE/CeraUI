// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import type { StreamingOptimismState } from "../lib/rpc/streaming-optimism.svelte";
import StreamControlButton from "../main/live/StreamControlButton.svelte";
import { ar, de, en, es, fr, hi, ja, ko, ptBR, zh } from "./helpers/catalog";

function mount(overrides: {
	isStreaming?: boolean;
	optimismState?: StreamingOptimismState;
	canStart?: boolean;
}) {
	return render(StreamControlButton, {
		props: {
			isStreaming: overrides.isStreaming ?? false,
			canStart: overrides.canStart ?? true,
			optimismState: overrides.optimismState ?? "idle",
			onStart: () => {},
			onStop: () => {},
		},
	});
}

function buttonText(container: HTMLElement): string {
	return container.querySelector("button")?.textContent?.trim() ?? "";
}

describe("StreamControlButton — the label follows the transient", () => {
	afterEach(cleanup);

	it("reads the idle start label before a start is dispatched", () => {
		const { container } = mount({});
		expect(buttonText(container)).toBe(en.live.startStream);
	});

	// A start legitimately runs for seconds; a spinner next to an unchanged
	// "Start Stream" reads as a stuck button, not as work in progress.
	it("reads 'Starting...' while the start attempt is in flight", () => {
		const { container } = mount({ optimismState: "starting" });
		expect(buttonText(container)).toBe(en.live.starting);
		expect(container.querySelector("button")?.disabled).toBe(true);
	});

	it("reads the idle stop label while the stream is simply live", () => {
		const { container } = mount({ isStreaming: true });
		expect(buttonText(container)).toBe(en.live.stopStream);
	});

	it("reads 'Stopping...' while the stop is in flight", () => {
		const { container } = mount({
			isStreaming: true,
			optimismState: "stopping",
		});
		expect(buttonText(container)).toBe(en.live.stopping);
		expect(container.querySelector("button")?.disabled).toBe(true);
	});

	// The transient labels reuse keys that already ship in all 10 locales, so the
	// fix costs no new translation. Lock that, or a locale gap becomes a silent
	// English leak on a non-EN device.
	it("keeps the transient labels translated in every shipped locale", () => {
		for (const dict of [en, ar, de, es, fr, hi, ja, ko, ptBR, zh]) {
			expect(dict.live.starting.length).toBeGreaterThan(0);
			expect(dict.live.stopping.length).toBeGreaterThan(0);
		}
	});
});
