import type { AudioSource } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	audioQualityChip,
	audioSourceUnavailableHintKey,
	audioSourceUnavailableReasonKey,
	isBluetoothAudioSource,
} from "./bluetooth-audio-source";

function btMic(overrides: Partial<AudioSource> = {}): AudioSource {
	return {
		id: "bt:AA_BB_CC_11_22_33",
		kind: "device",
		label: "Jabra Talk 45",
		transport: "bluetooth",
		pcm_spec: "bluealsa:DEV=AA:BB:CC:11:22:33,PROFILE=sco",
		...overrides,
	};
}

describe("isBluetoothAudioSource", () => {
	it("keys on the engine-sourced transport, never on the id", () => {
		expect(isBluetoothAudioSource(btMic())).toBe(true);
		// An id that merely LOOKS bluetooth-ish is not one — the two definitions
		// must not be able to disagree with the External badge.
		expect(isBluetoothAudioSource(btMic({ transport: "usb" }))).toBe(false);
	});

	it("is false for a USB card and for a pseudo-source", () => {
		expect(
			isBluetoothAudioSource({
				id: "usbaudio",
				kind: "device",
				transport: "usb",
			}),
		).toBe(false);
		expect(isBluetoothAudioSource({ id: "No audio", kind: "none" })).toBe(
			false,
		);
	});
});

describe("audioQualityChip", () => {
	it("renders the NEGOTIATED reading when the device reported a codec", () => {
		expect(
			audioQualityChip(
				btMic({
					quality: { codec: "msbc", sample_rate_hz: 16000, channels: 1 },
				}),
			),
		).toEqual({
			key: "live.source.audioQualityNegotiated",
			params: { khz: "16" },
			kind: "negotiated",
			codec: "msbc",
		});
	});

	it("renders narrowband CVSD as 8 kHz", () => {
		expect(
			audioQualityChip(
				btMic({
					quality: { codec: "cvsd", sample_rate_hz: 8000, channels: 1 },
				}),
			),
		).toMatchObject({ params: { khz: "8" }, codec: "cvsd" });
	});

	it("falls back to the HONEST CEILING when no quality was reported", () => {
		expect(audioQualityChip(btMic())).toEqual({
			key: "live.source.audioQualityCeiling",
			kind: "ceiling",
		});
	});

	it("renders no chip at all for a non-bluetooth source", () => {
		expect(
			audioQualityChip({ id: "usbaudio", kind: "device", transport: "usb" }),
		).toBeUndefined();
	});

	it("keeps a fractional rate readable without inventing precision", () => {
		expect(
			audioQualityChip(
				btMic({
					quality: { codec: "msbc", sample_rate_hz: 44100, channels: 1 },
				}),
			),
		).toMatchObject({ params: { khz: "44.1" } });
	});
});

describe("audioSourceUnavailableReasonKey", () => {
	it("maps the engine gate to its own copy key", () => {
		expect(
			audioSourceUnavailableReasonKey(
				btMic({ unavailable_reason: "engine_update_required" }),
			),
		).toBe("live.source.audioUnavailable.engine_update_required");
	});

	it("is undefined for a selectable row", () => {
		expect(audioSourceUnavailableReasonKey(btMic())).toBeUndefined();
	});
});

describe("audioSourceUnavailableHintKey", () => {
	it("derives the long-form key from the same token, never by patching the short key", () => {
		const entry = btMic({ unavailable_reason: "engine_update_required" });
		expect(audioSourceUnavailableHintKey(entry)).toBe(
			"live.source.audioUnavailableHint.engine_update_required",
		);
		expect(audioSourceUnavailableHintKey(entry)).not.toBe(
			audioSourceUnavailableReasonKey(entry),
		);
	});

	it("is undefined for a selectable row", () => {
		expect(audioSourceUnavailableHintKey(btMic())).toBeUndefined();
	});
});
