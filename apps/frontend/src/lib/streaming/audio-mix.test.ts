import { describe, expect, it } from "vitest";

import { audioPickSave, effectiveAudioInputs } from "./audio-mix";

const entry = (id: string, tracks = [1]) => ({
	id,
	tracks,
	gain_db: 0,
	mute: false,
	delay_ms: 0,
});
const A = entry("a");
const B2 = entry("b", [2]);

describe("effectiveAudioInputs", () => {
	it("a main input outside the saved mix joins first on Track 1 at its defaults, the rest as saved", () => {
		expect(effectiveAudioInputs([A, B2], "c", 4)).toEqual([entry("c"), A, B2]);
	});

	it("a main input already in the saved mix leaves the mix as saved", () => {
		expect(effectiveAudioInputs([A, B2], "b", 4)).toEqual([A, B2]);
	});

	it("in a full mix the main input takes the previous main input's place and tracks", () => {
		expect(effectiveAudioInputs([A, B2], "c", 2, "b")).toEqual([
			entry("c", [2]),
			A,
		]);
	});

	it("in a full mix without a known previous main input, the first entry (saved first) is replaced", () => {
		expect(effectiveAudioInputs([entry("a", [1, 3]), B2], "c", 2)).toEqual([
			entry("c", [1, 3]),
			B2,
		]);
	});

	it("without a saved mix there is no mix, and without a main input the mix is as saved", () => {
		expect(effectiveAudioInputs(undefined, "c", 4)).toBeUndefined();
		expect(effectiveAudioInputs([], "c", 4)).toBeUndefined();
		expect(effectiveAudioInputs([A, B2], undefined, 4)).toEqual([A, B2]);
	});
});

describe("audioPickSave", () => {
	it("a device picked outside a saved mix saves the pick and the mix in one write", () => {
		expect(
			audioPickSave("c", {
				saved: [A, B2],
				maxInputs: 4,
				previous: "a",
				mixInput: true,
			}),
		).toEqual({
			asrc: "c",
			audio_inputs: [entry("c"), A, B2],
		});
	});

	it("full mix, chained: a secondary picked as main saves only the pick, then a new input replaces it and keeps the first", () => {
		const saved = [A, B2];
		expect(
			audioPickSave("b", {
				saved,
				maxInputs: 2,
				previous: "a",
				mixInput: true,
			}),
		).toEqual({ asrc: "b" });
		expect(
			audioPickSave("c", {
				saved,
				maxInputs: 2,
				previous: "b",
				mixInput: true,
			}),
		).toEqual({
			asrc: "c",
			audio_inputs: [entry("c", [2]), A],
		});
	});

	it("a pick that is not a mixable device, or with no saved mix or no capability, saves only the pick", () => {
		expect(
			audioPickSave("Auto", {
				saved: [A, B2],
				maxInputs: 4,
				previous: "a",
				mixInput: false,
			}),
		).toEqual({
			asrc: "Auto",
		});
		expect(
			audioPickSave("c", {
				saved: undefined,
				maxInputs: 4,
				previous: "a",
				mixInput: true,
			}),
		).toEqual({
			asrc: "c",
		});
		expect(
			audioPickSave("c", {
				saved: [A, B2],
				maxInputs: undefined,
				previous: "a",
				mixInput: true,
			}),
		).toEqual({
			asrc: "c",
		});
	});
});
