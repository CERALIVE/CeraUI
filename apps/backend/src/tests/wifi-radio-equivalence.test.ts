import { expect, test } from "bun:test";
import { radioEquivalenceCases } from "./fixtures/wifi/radio-equivalence-cases.ts";
import golden from "./fixtures/wifi/radio-equivalence-main.json";
import { radioEquivalenceTranscript } from "./helpers/wifi-radio-equivalence.ts";

const transcripts: Readonly<Record<string, unknown>> = golden.transcripts;

// R-A: shadow identity must preserve main's public discovery and activation bytes.
for (const fixture of radioEquivalenceCases) {
	test(`preserves main discovery and public hotspot behavior: ${fixture.name}`, async () => {
		const transcript = await radioEquivalenceTranscript(fixture);
		expect(transcript.unexpected).toEqual([]);
		for (const frame of transcript.frames) {
			for (const activation of frame.activations) {
				expect(activation.prepare.success).toBe(fixture.admitted);
				expect(activation.start.success).toBe(fixture.admitted);
			}
		}
		const bytes = JSON.stringify(transcript);
		expect(bytes).toBe(JSON.stringify(transcripts[fixture.name]));
	});
}
