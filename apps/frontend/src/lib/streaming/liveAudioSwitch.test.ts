import { describe, expect, it } from "vitest";

import { canLiveSwitchInput, isAudioInputId } from "./liveAudioSwitch";

describe("liveAudioSwitch — live audio-switch dispatch guard (Task 10)", () => {
	describe("isAudioInputId", () => {
		it("is true for an audio:* input id", () => {
			expect(isAudioInputId("audio:usbaudio")).toBe(true);
			expect(isAudioInputId("audio:hw:1,0")).toBe(true);
		});

		it("is false for a video / non-audio input id", () => {
			expect(isAudioInputId("video0")).toBe(false);
			expect(isAudioInputId("video63")).toBe(false);
			expect(isAudioInputId("")).toBe(false);
		});
	});

	describe("canLiveSwitchInput", () => {
		it("ALWAYS allows a non-audio source regardless of the flag", () => {
			expect(canLiveSwitchInput("video0", false)).toBe(true);
			expect(canLiveSwitchInput("video0", true)).toBe(true);
		});

		it("BLOCKS an audio:* source while the capability flag is false", () => {
			// Track 1 invariant: the flag is false, so an audio switch is impossible.
			expect(canLiveSwitchInput("audio:usbaudio", false)).toBe(false);
		});

		it("allows an audio:* source only once the capability flag is true", () => {
			expect(canLiveSwitchInput("audio:usbaudio", true)).toBe(true);
		});
	});
});
