import { expect, test } from "bun:test";
import { radioEquivalenceCases } from "./fixtures/wifi/radio-equivalence-cases.ts";
import golden from "./fixtures/wifi/radio-equivalence-main.json";
import { legacyOverlapTranscript } from "./helpers/wifi-legacy-overlap.ts";
import { radioEquivalenceTranscript } from "./helpers/wifi-radio-equivalence.ts";

const transcripts: Readonly<Record<string, unknown>> = golden.transcripts;
const broadcastTranscripts: Readonly<Record<string, unknown>> =
	golden.broadcasts;

// R-A: shadow identity must preserve main's public discovery and activation bytes.
for (const fixture of radioEquivalenceCases) {
	test(`preserves main discovery and public hotspot behavior: ${fixture.name}`, async () => {
		const { broadcasts, ...transcript } =
			await radioEquivalenceTranscript(fixture);
		expect(transcript.unexpected).toEqual([]);
		for (const frame of transcript.frames) {
			for (const activation of frame.activations) {
				expect(activation.prepare.success).toBe(fixture.admitted);
				expect(activation.start.success).toBe(fixture.admitted);
			}
		}
		const bytes = JSON.stringify(transcript);
		expect(bytes).toBe(JSON.stringify(transcripts[fixture.name]));
		expect(JSON.stringify(broadcasts)).toBe(
			JSON.stringify(broadcastTranscripts[fixture.name]),
		);
	});
}

test("the parity oracle rejects an extra real Wi-Fi broadcast", async () => {
	const fixture = radioEquivalenceCases[0];
	if (!fixture) throw new Error("Missing verified fixture");
	const { broadcasts, ...transcript } = await radioEquivalenceTranscript(
		fixture,
		true,
	);
	expect(JSON.stringify(transcript)).toBe(
		JSON.stringify(transcripts[fixture.name]),
	);
	expect(JSON.stringify(broadcasts)).not.toBe(
		JSON.stringify(broadcastTranscripts[fixture.name]),
	);
});

test("overlapping legacy callers match main's distinct observations and broadcasts", async () => {
	expect(await legacyOverlapTranscript()).toEqual(golden.overlap);
});

test("overlapping legacy callers retain independent errors exactly as main", async () => {
	expect(await legacyOverlapTranscript(true)).toEqual(golden.errors);
});
