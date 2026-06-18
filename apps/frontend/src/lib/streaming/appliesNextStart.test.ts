import { describe, expect, it } from "vitest";

import { appliesOnNextStart } from "./appliesNextStart";
import { RESTART_REQUIRED_FIELDS } from "./streamingLockPolicy";

describe("appliesOnNextStart", () => {
	it("flags a restart-required field edited while streaming", () => {
		for (const field of RESTART_REQUIRED_FIELDS) {
			expect(appliesOnNextStart(field, true, true)).toBe(true);
		}
	});

	it("never flags an untouched field", () => {
		expect(appliesOnNextStart("pipeline", true, false)).toBe(false);
	});

	it("never flags while not streaming", () => {
		expect(appliesOnNextStart("pipeline", false, true)).toBe(false);
	});

	it("never flags a hot-changeable field even when edited mid-stream", () => {
		expect(appliesOnNextStart("max_br", true, true)).toBe(false);
	});

	it("never flags an unknown field", () => {
		expect(appliesOnNextStart("bitrate_overlay", true, true)).toBe(false);
	});
});
