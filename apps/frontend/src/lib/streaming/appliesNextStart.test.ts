import { describe, expect, it } from "vitest";

import { appliesOnNextStart, restartChoiceRequired } from "./appliesNextStart";
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

describe("restartChoiceRequired — when the operator must be ASKED", () => {
	it("asks when a restart-required field is edited mid-stream", () => {
		expect(restartChoiceRequired(true, ["resolution"])).toBe(true);
		expect(restartChoiceRequired(true, ["framerate"])).toBe(true);
	});

	it("never asks while idle — there is no broadcast to interrupt", () => {
		expect(restartChoiceRequired(false, ["resolution", "framerate"])).toBe(
			false,
		);
	});

	it("never asks when nothing restart-required changed", () => {
		expect(restartChoiceRequired(true, [])).toBe(false);
		expect(restartChoiceRequired(true, ["max_br", "bitrate_overlay"])).toBe(
			false,
		);
	});

	it("asks when ANY of several edited fields needs a restart", () => {
		expect(restartChoiceRequired(true, ["max_br", "framerate"])).toBe(true);
	});

	it("agrees with the badge predicate for every field — one rule, two surfaces", () => {
		for (const field of [
			"resolution",
			"framerate",
			"max_br",
			"bitrate_overlay",
		]) {
			expect(restartChoiceRequired(true, [field])).toBe(
				appliesOnNextStart(field, true, true),
			);
		}
	});
});
