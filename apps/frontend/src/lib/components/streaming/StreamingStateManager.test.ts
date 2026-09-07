// @vitest-environment jsdom
import { render } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const snapshot = vi.hoisted(() => ({
	config: { asrc: "USB microphone" },
	status: { asrcs: ["USB microphone"] },
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getAudioCodecs: () => undefined,
	getConfig: () => snapshot.config,
	getIsStreaming: () => false,
	getRelays: () => undefined,
	getSources: () => undefined,
	getStatus: () => snapshot.status,
}));

import StreamingStateConsumer from "./__fixtures__/StreamingStateConsumer.svelte";

describe("StreamingStateManager", () => {
	beforeEach(() => {
		snapshot.config.asrc = "USB microphone";
		snapshot.status.asrcs = ["USB microphone"];
	});

	it("memoizes the projected state instead of allocating on every getter call", () => {
		const { getByTestId } = render(StreamingStateConsumer);
		const consumer = getByTestId("streaming-state-consumer");

		expect(consumer.getAttribute("data-same-reference")).toBe("true");
		expect(consumer.textContent?.trim()).toBe("USB microphone");
	});
});
