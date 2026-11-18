import { expect, test } from "bun:test";
import { parseIwPhyCapabilities } from "../../../src/modules/wifi/wifi-capabilities.ts";
import { parseIwPhyChannels } from "../../../src/modules/wifi/regdomain.ts";
import { loadReplayCorpus, sampleText } from "./replay-corpus.ts";

const corpus = await loadReplayCorpus();
const samples = corpus.manifest.additionalSamples ?? [];

test("R22 adds all four complete captured phys without replacing the truncated R21 sample", () => {
	expect(samples.map((sample) => sample.id)).toEqual([
		"r22/iw-phy0-info",
		"r22/iw-phy1-info",
		"r22/iw-phy2-info",
		"r22/iw-phy3-info",
	]);
});

for (const [index, sample] of samples.entries()) {
	test(`full captured iw output reaches the actual product parsers: ${sample.id}`, () => {
		const text = sampleText(corpus, sample);
		expect(sample.complete).toBe(true);
		expect(Buffer.byteLength(text)).toBe(35879);
		const parsed = parseIwPhyCapabilities(text);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error(parsed.reason);
		expect(parsed.value.get(`phy${index}`)?.bands).toEqual(["2.4", "5", "6"]);
		expect(parsed.value.get(`phy${index}`)?.staApCombo).toEqual({
			supported: true,
			sameChannelOnly: true,
		});
		expect(parseIwPhyChannels(text).get(`phy${index}`)).toContainEqual({
			channel: 6,
			freqMhz: 2437,
			band: "bg",
		});
		expect(parseIwPhyChannels(text).get(`phy${index}`)?.some((channel) => channel.freqMhz === 5180)).toBe(false);
		expect(parseIwPhyChannels(text).get(`phy${index}`)?.some((channel) => channel.freqMhz >= 5925)).toBe(false);
	});
}
