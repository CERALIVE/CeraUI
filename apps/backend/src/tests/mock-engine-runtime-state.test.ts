import { expect, test } from "bun:test";
import {
	initMockService,
	setStreamingState,
	stopMockService,
} from "../mocks/mock-service.ts";
import { queryEngineRuntimeStreaming } from "../modules/streaming/engine-runtime-state.ts";
import {
	getIsStreaming,
	updateStatus,
} from "../modules/streaming/streaming.ts";

test.each([false, true])(
	"mock engine runtime reads independent engine truth active=%s",
	async (active) => {
		// Given the fake engine in the opposite state to the legacy status projection.
		const previous = process.env.MOCK_MODE;
		const previousStatus = getIsStreaming();
		process.env.MOCK_MODE = "true";
		initMockService("caps-full");
		setStreamingState(active);
		updateStatus(!active);
		try {
			// When authoritative runtime reconciliation observes the mock engine.
			const runtime = await queryEngineRuntimeStreaming();
			// Then the legacy boolean is not substituted for engine evidence.
			expect(runtime).toBe(active ? "streaming" : "idle");
		} finally {
			stopMockService();
			updateStatus(previousStatus);
			if (previous === undefined) delete process.env.MOCK_MODE;
			else process.env.MOCK_MODE = previous;
		}
	},
);
