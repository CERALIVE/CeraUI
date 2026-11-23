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

const bindingFields = {
	"connection.interface-name": "",
	"802-11-wireless.mac-address": "58:02:05:e1:79:1c",
	"match.path": "platform-equivalence-phy0",
	"connection.autoconnect": "no",
	"802-11-wireless-security.key-mgmt": "wpa-psk",
	"802-11-wireless-security.pmf": "disable",
};
const renameOwner = bindingFields["802-11-wireless.mac-address"];
const savedStartReads = {
	// Confirm that the selected UUID is still recorded before refreshing saved profiles.
	beforeRefresh: renameOwner,
	// Recheck recorded ownership immediately before the binding write.
	beforeBind: renameOwner,
	// Recheck recorded ownership after prune is scheduled, before NM activation.
	beforeUp: renameOwner,
	// Recheck recorded ownership after activation, before the autoconnect write.
	beforePolicy: renameOwner,
} as const;
// Keep the recorded baseline immutable; apply the approved bindings and refresh.
const verifiedTranscript = {
	...golden.transcripts["verified fresh"],
	calls: golden.transcripts["verified fresh"].calls.map((call, index) =>
		index === 9 ? [call[0], call[1], bindingFields] : call,
	),
};
const transcripts: Readonly<
	Record<string, { readonly calls: readonly (readonly unknown[])[] }>
> = {
	...golden.transcripts,
	"verified fresh": verifiedTranscript,
	rename: {
		...golden.transcripts.rename,
		calls: expectedRenameCalls(),
	},
	replug: {
		...golden.transcripts.replug,
		calls: golden.transcripts.replug.calls.map((call, index) =>
			index === 9
				? [call[0], call[1], bindingFields]
				: index === 26
					? [
							call[0],
							call[1],
							{ ...bindingFields, "match.path": "platform-equivalence-phy2" },
						]
					: call,
		),
	},
};
const broadcastTranscripts: Readonly<Record<string, unknown>> =
	golden.broadcasts;

function expectedRenameCalls() {
	let renamed = false;
	return golden.transcripts.rename.calls.flatMap(
		(call): readonly (readonly unknown[])[] => {
			const [effect, target, fields] = call;
			if (effect === "setDupIpSuppression" && target === "wlp-renamed")
				renamed = true;
			if (
				effect === "nmConnSetFields" &&
				fields &&
				typeof fields === "object"
			) {
				if ("802-11-wireless.mac-address" in fields) {
					const bind = [effect, target, bindingFields];
					return renamed
						? [
								["credentials.get", savedStartReads.beforeRefresh],
								["wifiUpdateSavedConns"],
								["credentials.get", savedStartReads.beforeBind],
								["credentials.get", savedStartReads.beforeBind],
								bind,
							]
						: [bind];
				}
				if (renamed)
					return [
						["credentials.get", savedStartReads.beforePolicy],
						["credentials.get", savedStartReads.beforePolicy],
						call,
					];
			}
			if (renamed && effect === "nmConnect")
				return [["credentials.get", savedStartReads.beforeUp], call];
			return [call];
		},
	);
}

function renameTranscriptBytes<
	T extends { readonly calls: readonly (readonly unknown[])[] },
>(transcript: T): string {
	return JSON.stringify({
		...transcript,
		calls: transcript.calls.map((call) =>
			call[0] === "credentials.get" ? ["credential-read", call[1]] : call,
		),
	});
}

/** B7 changes only first-profile creation; retain the recorded main oracle. */
function firstApTranscript<
	T extends { readonly calls: readonly (readonly unknown[])[] },
>(transcript: T | undefined) {
	if (!transcript) throw new Error("Missing recorded main transcript");
	return {
		...transcript,
		calls: transcript.calls.flatMap((call, index, calls) => {
			if (call[0] === "nmHotspot") {
				const binding = calls[index + 1];
				if (binding?.[0] !== "nmConnSetFields")
					throw new Error("Missing recorded first-profile binding");
				return [
					[
						"nmApConnAdd",
						call[1],
						{ name: call[2], password: call[3] },
						binding[2],
					],
				];
			}
			return calls[index - 1]?.[0] === "nmHotspot" ? [] : [[...call]];
		}),
	};
}

// R-A: shadow identity must preserve main's public discovery and activation bytes.
for (const fixture of radioEquivalenceCases) {
	test(`preserves main discovery and public hotspot behavior: ${fixture.name}`, async () => {
		const { broadcasts, ...transcript } =
			await radioEquivalenceTranscript(fixture);
		expect(transcript.unexpected).toEqual([]);
		if (fixture.name === "duplicate MAC") {
			const [frame] = transcript.frames;
			const keys = [
				"58:02:05:e1:79:1c@platform-equivalence-phy0",
				"58:02:05:e1:79:1c@platform-equivalence-phy1",
			];
			expect(transcript.frames).toHaveLength(1);
			expect(frame?.discovered.keys).toEqual(keys);
			expect(frame?.discovered.ids).toEqual({ 0: keys[0], 1: keys[1] });
			expect(
				frame?.activations.map(({ device, prepare, start }) => ({
					device,
					prepare: prepare.success,
					start,
				})),
			).toEqual([
				{ device: 0, prepare: true, start: { success: true } },
				{ device: 1, prepare: true, start: { success: true } },
			]);
			expect(
				transcript.calls.filter(([effect]) => effect === "nmConnect"),
			).toEqual([
				["nmConnect", "fixture-uuid-wlan0"],
				["nmConnect", "fixture-uuid-wlan1"],
			]);
			expect(
				broadcasts
					.filter(({ phase }) => phase === "discovery:pending")
					.map(({ payload }) => {
						if (
							typeof payload !== "object" ||
							!payload ||
							!("wifi" in payload) ||
							typeof payload.wifi !== "object" ||
							!payload.wifi
						)
							throw new Error("Missing twin broadcast");
						return Object.keys(payload.wifi);
					}),
			).toEqual([
				["0", "1"],
				["0", "1"],
			]);
			return;
		}
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
			const verified = verifiedTranscript;
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
				const refusal = { success: false, error: "radio-unverified" } as const;
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
			expect(transcript.calls).toEqual(
				firstApTranscript({ calls: expectedCalls }).calls,
			);
			expect(broadcasts).toEqual(expectedBroadcasts);
			return;
		}
		const bytes =
			fixture.name === "rename"
				? renameTranscriptBytes(transcript)
				: JSON.stringify(transcript);
		if (fixture.name === "rename")
			expect(JSON.stringify(transcript.frames)).toBe(
				JSON.stringify(golden.transcripts.rename.frames),
			);
		const expected = firstApTranscript(transcripts[fixture.name]);
		expect(bytes).toBe(
			fixture.name === "rename"
				? renameTranscriptBytes(expected)
				: JSON.stringify(expected),
		);
		expect(JSON.stringify(broadcasts)).toBe(
			JSON.stringify(broadcastTranscripts[fixture.name]),
		);
	});
}

const renameMutations = [
	"omit",
	"duplicate",
	"wrong owner",
	"cross a write",
	"reorder effects",
	"swap only effects",
] as const;
test.each(renameMutations)(
	"the real rename transcript rejects credential/effect drift: %s",
	async (mutation) => {
		const rename = radioEquivalenceCases.find(({ name }) => name === "rename");
		if (!rename) throw new Error("Missing rename fixture");
		const { broadcasts: _broadcasts, ...actual } =
			await radioEquivalenceTranscript(rename);
		const expected = firstApTranscript(transcripts.rename);
		const calls = actual.calls.map((call) => [...call]);
		const write = calls.findLastIndex(
			([effect]) => effect === "nmConnSetFields",
		);
		const read = calls[write - 1];
		const boundary = calls[write];
		if (read?.[0] !== "credentials.get" || !boundary)
			throw new Error(
				"Missing the saved AP's final policy write and owner read",
			);
		switch (mutation) {
			case "omit":
				calls.splice(write - 1, 1);
				break;
			case "duplicate":
				calls.splice(write, 0, read);
				break;
			case "wrong owner":
				calls[write - 1] = ["credentials.get", "foreign-owner"];
				break;
			case "cross a write":
				calls.splice(write - 1, 2, boundary, read);
				break;
			case "reorder effects":
				calls.reverse();
				break;
			case "swap only effects": {
				const bind = calls.findLastIndex(
					([effect], index) => effect === "nmConnSetFields" && index < write,
				);
				const activation = calls.findLastIndex(
					([effect]) => effect === "nmConnect",
				);
				const first = calls[bind];
				const second = calls[activation];
				if (!first || !second || bind >= activation)
					throw new Error("Missing ordered binding and activation effects");
				calls[bind] = second;
				calls[activation] = first;
				for (const [index, call] of actual.calls.entries())
					if (call[0] === "credentials.get") expect(calls[index]).toEqual(call);
				break;
			}
		}
		const matches = (transcript: typeof actual) =>
			renameTranscriptBytes(transcript) === renameTranscriptBytes(expected);
		expect(matches(actual)).toBe(true);
		expect(matches({ ...actual, calls })).toBe(false);
	},
);

test("the parity oracle rejects an extra real Wi-Fi broadcast", async () => {
	const fixture = radioEquivalenceCases[0];
	if (!fixture) throw new Error("Missing verified fixture");
	const { broadcasts, ...transcript } = await radioEquivalenceTranscript(
		fixture,
		true,
	);
	expect(JSON.stringify(transcript)).toBe(
		JSON.stringify(firstApTranscript(transcripts[fixture.name])),
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
