import { afterEach, describe, expect, test } from "bun:test";

import {
	getIsStreaming,
	updateStatus,
} from "../modules/streaming/streaming.ts";

afterEach(() => {
	updateStatus(false);
});

describe("stream lifecycle baseline characterization", () => {
	test("the public streaming status edge remains idempotent", () => {
		// Given an idle backend process.
		updateStatus(false);

		// When the observable status is advanced to streaming twice.
		const firstTransition = updateStatus(true);
		const duplicateTransition = updateStatus(true);

		// Then clients observe one streaming edge and the stored state is live.
		expect(firstTransition).toBe(true);
		expect(duplicateTransition).toBe(false);
		expect(getIsStreaming()).toBe(true);
	});
});
