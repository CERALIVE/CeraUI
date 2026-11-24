// @vitest-environment jsdom
/**
 * The Live bar's audio line on a stream started with "No audio", closed loop: the
 * device's frames go through the real serializer and subscription handler into
 * LiveView, its real cockpit and the real summary strip.
 */
import { render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { installJsdomShims } from "../tests/fixtures/real-cockpit-harness";

const noop = vi.hoisted(
	() => async () =>
		({ default: (await import("../tests/fixtures/Noop.svelte")).default }) as {
			default: unknown;
		},
);
vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));
vi.mock("$lib/rpc", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	rpc: { streaming: { start: vi.fn(), stop: vi.fn(), setConfig: vi.fn() } },
}));
vi.mock("$lib/components/preview/PreviewCanvas.svelte", noop);
vi.mock("$lib/components/custom/ComingSoon.svelte", noop);
vi.mock("$main/live/CapabilityTierBanner.svelte", noop);
vi.mock("$main/dialogs/ServerDialog.svelte", noop);
vi.mock("$main/dialogs/AudioDialog.svelte", noop);
vi.mock("$main/dialogs/EncoderDialog.svelte", noop);

import { resetState } from "$lib/rpc/subscriptions.svelte";
import { ingest } from "../tests/harness/device-loop";
import LiveView from "./LiveView.svelte";

beforeAll(() => {
	installJsdomShims();
});
beforeEach(() => {
	resetState();
});
afterEach(() => {
	resetState();
});

const deliver = (type: string, payload: unknown) => {
	ingest(type, payload);
	flushSync();
};
const audioLine = (container: HTMLElement) =>
	container
		.querySelector('[data-testid="live-cockpit"] [data-live-value="audio"]')
		?.textContent?.trim();

it("names No audio while the silent stream runs and another microphone is saved, then follows the saved pick", () => {
	const asrcs = ["USB audio", "No audio", "Pipeline default"];
	deliver("config", { pipeline: "hdmi", max_br: 6000, asrc: "No audio" });
	deliver("status", { is_streaming: true, audio_off_active: true, asrcs });
	const { container } = render(LiveView);
	flushSync();
	expect(audioLine(container)).toBe("No audio");

	deliver("config", { asrc: "USB audio" });
	expect(audioLine(container)).toBe("No audio");

	// A frame that does not carry the fact keeps it.
	deliver("status", { is_streaming: true, audio_mix_active: false });
	expect(audioLine(container)).toBe("No audio");

	deliver("status", { is_streaming: false, audio_off_active: false });
	deliver("status", { is_streaming: true, audio_off_active: false });
	expect(audioLine(container)).toBe("USB audio");

	// "No audio" saved for the next Start is not claimed for a stream with sound.
	deliver("config", { asrc: "No audio" });
	expect(audioLine(container)).toBeUndefined();
});
