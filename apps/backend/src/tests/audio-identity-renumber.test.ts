/*
 * Audio-side mid-stream re-enumeration self-heal (device-quality-wave2).
 *
 * `config.asrc` persists a KERNEL-ASSIGNED ALSA card key, and the kernel recycles
 * those: replugging while the old card is still held open gives the same hardware
 * a different id. The stored selection then matches nothing and is indistinguishable
 * from a real unplug — the audio-lost banner never clears, the label degrades to the
 * raw key, and `resolveMeterPreference` aims at a card that no longer exists so the
 * meter stays dark. This is the audio twin of the video defect covered by
 * `source-identity-renumber.test.ts`.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { AUDIO_SOURCE_AUTO } from "@ceraui/rpc/schemas";

import { getConfig } from "../modules/config.ts";
import {
	DEFAULT_AUDIO_ID,
	reconcileConfiguredAudioIdentity,
} from "../modules/streaming/audio.ts";
import type { AudioDeviceIdentity } from "../modules/streaming/audio-naming.ts";

const RODE_STABLE_ID = "usb:19f7:0037";

function identity(stableId: string): AudioDeviceIdentity {
	return { stable_id: stableId };
}

/** The card came back as `usbaudio_1` — same hardware, new kernel key. */
const AFTER_REPLUG = {
	devices: { usbaudio_1: "usbaudio_1", [DEFAULT_AUDIO_ID]: DEFAULT_AUDIO_ID },
	identities: new Map<string, AudioDeviceIdentity>([
		["usbaudio_1", identity(RODE_STABLE_ID)],
	]),
	remembered: new Map<string, string>([["usbaudio", RODE_STABLE_ID]]),
};

describe("reconcileConfiguredAudioIdentity", () => {
	beforeEach(() => {
		delete getConfig().asrc;
	});

	it("migrates a recycled ALSA key onto the same hardware's new key", () => {
		getConfig().asrc = "usbaudio";

		expect(
			reconcileConfiguredAudioIdentity(
				AFTER_REPLUG.identities,
				AFTER_REPLUG.devices,
				AFTER_REPLUG.remembered,
			),
		).toBe(true);
		expect(getConfig().asrc).toBe("usbaudio_1");
	});

	it("is a no-op while the configured card is still listed", () => {
		getConfig().asrc = "usbaudio";

		expect(
			reconcileConfiguredAudioIdentity(
				new Map([["usbaudio", identity(RODE_STABLE_ID)]]),
				{ usbaudio: "usbaudio" },
				AFTER_REPLUG.remembered,
			),
		).toBe(false);
		expect(getConfig().asrc).toBe("usbaudio");
	});

	it("NEVER adopts a different card that merely appeared in its place", () => {
		getConfig().asrc = "usbaudio";

		expect(
			reconcileConfiguredAudioIdentity(
				new Map([["Rx", identity("usb:dead:beef")]]),
				{ Rx: "Rx" },
				AFTER_REPLUG.remembered,
			),
		).toBe(false);
		expect(getConfig().asrc).toBe("usbaudio");
	});

	it("leaves a genuinely absent card alone when nothing matches its identity", () => {
		getConfig().asrc = "usbaudio";

		expect(
			reconcileConfiguredAudioIdentity(
				new Map(),
				{ [DEFAULT_AUDIO_ID]: DEFAULT_AUDIO_ID },
				AFTER_REPLUG.remembered,
			),
		).toBe(false);
		expect(getConfig().asrc).toBe("usbaudio");
	});

	it("is a no-op with no remembered identity for the configured key", () => {
		getConfig().asrc = "usbaudio";

		expect(
			reconcileConfiguredAudioIdentity(
				AFTER_REPLUG.identities,
				AFTER_REPLUG.devices,
				new Map(),
			),
		).toBe(false);
		expect(getConfig().asrc).toBe("usbaudio");
	});

	it("never touches Auto or a pipeline pseudo-source", () => {
		for (const pseudo of [AUDIO_SOURCE_AUTO, DEFAULT_AUDIO_ID, "No audio"]) {
			getConfig().asrc = pseudo;
			expect(
				reconcileConfiguredAudioIdentity(
					AFTER_REPLUG.identities,
					AFTER_REPLUG.devices,
					new Map([[pseudo, RODE_STABLE_ID]]),
				),
			).toBe(false);
			expect(getConfig().asrc).toBe(pseudo);
		}
	});
});
