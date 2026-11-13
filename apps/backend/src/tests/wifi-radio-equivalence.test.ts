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
		for (const [index, frame] of transcript.frames.entries()) {
			for (const activation of frame.activations) {
				const admitted = fixture.limitedFrames?.includes(index)
					? false
					: fixture.admitted;
				expect(activation.prepare.success).toBe(admitted);
				expect(activation.start.success).toBe(admitted);
			}
		}
		if (fixture.limitedFrames) {
			const verified = golden.transcripts["verified fresh"];
			const expectedCalls: unknown[][] =
				fixture.frames.length > 1 ? [...verified.calls] : [];
			const expectedBroadcasts: typeof broadcasts =
				fixture.frames.length > 1
					? [...golden.broadcasts["verified fresh"]]
					: [];
			expect(transcript.frames).toHaveLength(fixture.frames.length);
			for (const [index, frame] of transcript.frames.entries()) {
				if (!fixture.limitedFrames.includes(index)) {
					expect(JSON.stringify(frame)).toBe(
						JSON.stringify(verified.frames[0]),
					);
					continue;
				}
				const radios = fixture.frames[index];
				if (!radios) throw new Error("Missing limited input frame");
				const adapters = radios.map((radio, offset) => ({
					id: index === 0 ? offset : 1,
					key: `limited:${radio.ifindex}:${radio.phy}`,
					wifi: {
						ifname: radio.ifname,
						conn: "",
						hw: "Fixture Radio",
						saved: {},
						degraded_reason: "permanent-mac-unresolved",
						available: [],
						supports_hotspot: true,
						mode: "station",
					},
				}));
				const wifi = Object.fromEntries(
					adapters.map((adapter) => [adapter.id, adapter.wifi]),
				);
				const snapshot = {
					wifi,
					keys: adapters.map((adapter) => adapter.key),
					ids: Object.fromEntries(
						adapters.map((adapter) => [adapter.id, adapter.key]),
					),
				};
				const refusal = { success: false, error: "activation-failed" } as const;
				expect(frame.discovered).toEqual(snapshot);
				expect(frame.activations).toEqual(
					adapters.map(({ id }) => ({
						device: id,
						prepare: refusal,
						start: refusal,
						prepared: snapshot,
						starting: snapshot,
						confirmed: snapshot,
					})),
				);
				for (const { id } of adapters)
					expectedCalls.push(["publishOutcome", "start", id, refusal]);
				const broadcast = {
					phase: "discovery:pending",
					at: index,
					payload: { wifi },
				};
				expectedBroadcasts.push(broadcast, broadcast);
			}
			expect(transcript.calls).toEqual(expectedCalls);
			expect(broadcasts).toEqual(expectedBroadcasts);
			return;
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
			await expect(
				radioEquivalenceTranscript({ ...fixture, resample: true }),
			).rejects.toThrow("Detached shadow changed legacy state");
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
