import { describe, expect, it } from "vitest";

import { isSelectedAudioLost } from "./audioLost";

describe("isSelectedAudioLost", () => {
	it("is true when a real device is absent from the available list", () => {
		expect(isSelectedAudioLost("USB audio", ["HDMI", "No audio"])).toBe(true);
	});

	it("is false when the selected device is present", () => {
		expect(isSelectedAudioLost("USB audio", ["USB audio", "No audio"])).toBe(
			false,
		);
	});

	it("never reports the Auto sentinel as lost", () => {
		expect(isSelectedAudioLost("Auto", ["USB audio"])).toBe(false);
	});

	it("never reports pseudo sources as lost", () => {
		expect(isSelectedAudioLost("No audio", ["USB audio"])).toBe(false);
		expect(isSelectedAudioLost("Pipeline default", ["USB audio"])).toBe(false);
	});

	it("is false with no selection or no available list", () => {
		expect(isSelectedAudioLost(undefined, ["USB audio"])).toBe(false);
		expect(isSelectedAudioLost("USB audio", undefined)).toBe(false);
	});

	it("is false before the list arrives (empty list = pre-broadcast)", () => {
		expect(isSelectedAudioLost("USB audio", [])).toBe(false);
	});
});
