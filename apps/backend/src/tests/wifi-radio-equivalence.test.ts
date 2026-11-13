import { expect, spyOn, test } from "bun:test";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
} from "../modules/wifi/wifi-connections.ts";
import { getWifiIdToMacAddress } from "../modules/wifi/wifi-interfaces.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
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

test.each(["id", "registry-key", "id-map"] as const)(
	"the parity oracle rejects a detached producer legacy %s write",
	async (kind) => {
		const fixture = radioEquivalenceCases[0];
		if (!fixture) throw new Error("Missing verified fixture");
		const discover = wifiRadioIdentity.discover.bind(wifiRadioIdentity);
		let writes = 0;
		const mutation = spyOn(wifiRadioIdentity, "discover").mockImplementation(
			async (...args) => {
				await discover(...args);
				if (wifiRadioIdentity.state.rows.size === 0) return;
				const registry = getWifiInterfacesByMacAddress();
				const iface = Object.values(registry)[0];
				if (!iface) throw new Error("Missing legacy mutation target");
				switch (kind) {
					case "id":
						iface.id = 999;
						break;
					case "registry-key":
						addWifiInterface("shadow:legacy:leak", iface);
						break;
					case "id-map":
						getWifiIdToMacAddress()[999] = "shadow:legacy:leak";
						break;
					default:
						throw new Error(`Unhandled mutation: ${kind satisfies never}`);
				}
				writes++;
			},
		);
		try {
			await expect(radioEquivalenceTranscript(fixture)).rejects.toThrow(
				"Detached shadow changed legacy state",
			);
			expect(writes).toBe(1);
		} finally {
			mutation.mockRestore();
		}
	},
);

test("overlapping callers share the queued observation and its broadcasts", async () => {
	expect(await legacyOverlapTranscript()).toEqual({
		initialReads: 1,
		reads: 2,
		joined: true,
		results: [false, false, false],
		broadcasts: 1,
		keys: ["degraded:wlan0"],
		unexpected: [],
	});
});

test("a discovery failure stays with its run while queued callers share success", async () => {
	expect(await legacyOverlapTranscript(true)).toEqual({
		initialReads: 1,
		reads: 2,
		joined: true,
		results: [
			{ error: "first legacy failure" },
			{ value: false },
			{ value: false },
		],
		broadcasts: 0,
		keys: [],
		unexpected: [],
	});
});
