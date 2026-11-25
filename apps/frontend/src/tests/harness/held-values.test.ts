// @vitest-environment jsdom
/**
 * What an empty-looking value means to the lock that holds it. A write that
 * intends no value at all asks for a clear: its lock yields to the device's
 * `config_clear`, and guards nothing once the field shows none. `0`, `false` and
 * an empty list are values like any other: their lock keeps a stale echo out.
 *
 * The table is every field this build can lock on such a value, then the two
 * values no build sends. `server-save-lock.test.ts` runs the server saves
 * against the real device.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	destroyDirtyRegistry,
	isPending,
	markPending,
} from "$lib/rpc/dirty-registry.svelte";
import { getConfig, resetState } from "$lib/rpc/subscriptions.svelte";
import { buildEncoderSetConfig } from "$lib/streaming/encoderConfig";
import { buildServerSetConfig } from "$lib/streaming/receiver-experience";
import { ingest } from "./device-loop";

const shown = (field: string): unknown => Reflect.get(getConfig() ?? {}, field);

beforeEach(() => {
	resetState();
	destroyDirtyRegistry();
});

afterEach(() => {
	resetState();
	destroyDirtyRegistry();
});

/** [field, the value locked, what locks it, what it showed before, another tab's value] */
const CLEARS = [
	[
		"selected_ingest_endpoint",
		"",
		"every non-slot server save",
		"ep-1",
		"ep-2",
	],
	["srt_streamid", "", "a custom server save", "id-1", "id-2"],
	["relay_streamid_override", "", "a managed server save", "ov-1", "ov-2"],
	["srtla_addr", "", "a custom server save", "a.example", "b.example"],
	["relay_server", "", "a managed server save", "fra", "ams"],
	["video_codec", null, "Encoder, Automatic", "h264", "h265"],
	["video_codec", undefined, "nothing today", "h264", "h265"],
] as const;
const VALUES = [
	["bitrate_overlay", false, "Encoder, overlay off", true, true],
	["delay", 0, "Audio, no delay", 120, 80],
	["audio_inputs", [], "nothing today", [{ id: "a" }], [{ id: "b" }]],
] as const;

describe.each(CLEARS)(
	"%s locked on %o (%s) asks for a clear",
	(field, value, _by, old, other) => {
		it("yields to the device's clear, so another tab's value shows at once", () => {
			ingest("config", { [field]: old });
			markPending(field, value);

			ingest("config_clear", { keys: [field] });

			expect(shown(field)).toBeUndefined();
			expect(isPending(field)).toBe(false);
			ingest("config", { [field]: other });
			expect(shown(field)).toBe(other);
		});

		it("hides nothing when the field showed none: the device names no key for it", () => {
			ingest("config", { max_br: 6000 });
			markPending(field, value);

			ingest("config", { [field]: other });

			expect(shown(field)).toBe(other);
		});

		it("still keeps a stale echo of the value it clears out while the write is in flight", () => {
			ingest("config", { [field]: old });
			markPending(field, value);

			ingest("config", { [field]: other });

			expect(shown(field)).toBe(old);
		});
	},
);

describe.each(VALUES)(
	"%s locked on %o (%s) is a value",
	(field, value, _by, old, other) => {
		it("keeps its lock through a clear that crosses it, so a stale echo stays out", () => {
			ingest("config", { [field]: old });
			markPending(field, value);

			ingest("config_clear", { keys: [field] });

			expect(shown(field)).toBeUndefined();
			expect(isPending(field)).toBe(true);
			ingest("config", { [field]: old });
			expect(shown(field)).toBeUndefined();
		});

		it("keeps another tab's value out when the field showed none", () => {
			ingest("config", { max_br: 6000 });
			markPending(field, value);

			ingest("config", { [field]: other });

			expect(shown(field)).toBeUndefined();
		});
	},
);

describe("the table names every field a save can lock on an empty-looking value", () => {
	const emptyIn = (input: object) =>
		Object.entries(input)
			.filter(
				([, value]) => !value || (Array.isArray(value) && value.length === 0),
			)
			.map(([field]) => field)
			.sort();
	const inTable = (by: RegExp) =>
		[...CLEARS, ...VALUES]
			.filter(([, , source]) => by.test(source))
			.map(([field]) => field)
			.sort();
	const blank = {
		latency: 2000,
		protocol: "srtla",
		addr: "",
		portStr: "",
		streamId: "",
		relayStreamId: "",
		relayServer: "",
		relayAccount: "",
	} as const;

	it.each([
		["custom", /non-slot|custom/],
		["managed", /non-slot|managed/],
	] as const)("a blank %s server save", (destination, by) => {
		expect(
			emptyIn(
				buildServerSetConfig({ ...blank, protocol: "srtla" }, { destination }),
			),
		).toEqual(inTable(by));
	});

	it("an encoder save that turns everything off", () => {
		const gated = {
			supportsResolutionOverride: true,
			supportsFramerateOverride: true,
		} as Parameters<typeof buildEncoderSetConfig>[1];
		expect(
			emptyIn(
				buildEncoderSetConfig(
					{
						bitrate: undefined,
						bitrateOverlay: false,
						codec: null,
						resolution: undefined,
						framerate: undefined,
						applyNow: false,
					},
					gated,
				),
			),
		).toEqual(inTable(/^Encoder/));
	});
});
