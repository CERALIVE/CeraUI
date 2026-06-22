import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getBufferingState,
	ingestBuffering,
	isBuffering,
	parseBufferingStatus,
	resetBuffering,
} from "./buffering.svelte";

describe("parseBufferingStatus", () => {
	it("parses an active payload with byte counters", () => {
		expect(
			parseBufferingStatus({
				active: true,
				spooled_bytes: 1024,
				data_headroom_bytes: 2048,
				disk_warning: true,
			}),
		).toEqual({
			active: true,
			spooledBytes: 1024,
			dataHeadroomBytes: 2048,
			diskWarning: true,
		});
	});

	it("parses recovery (active:false) with null counters", () => {
		expect(parseBufferingStatus({ active: false })).toEqual({
			active: false,
			spooledBytes: null,
			dataHeadroomBytes: null,
			diskWarning: false,
		});
	});

	it("returns null for missing/malformed/non-object payloads (never throws)", () => {
		expect(parseBufferingStatus(undefined)).toBeNull();
		expect(parseBufferingStatus(null)).toBeNull();
		expect(parseBufferingStatus({})).toBeNull();
		expect(parseBufferingStatus({ active: "yes" })).toBeNull();
		expect(parseBufferingStatus(42)).toBeNull();
	});

	it("drops negative / non-numeric byte counters", () => {
		expect(
			parseBufferingStatus({
				active: true,
				spooled_bytes: -1,
				data_headroom_bytes: "lots",
			}),
		).toEqual({
			active: true,
			spooledBytes: null,
			dataHeadroomBytes: null,
			diskWarning: false,
		});
	});
});

describe("buffering store (capability gate + show/hide)", () => {
	beforeEach(() => resetBuffering());
	afterEach(() => resetBuffering());

	it("renders nothing before the engine advertises buffering", () => {
		expect(getBufferingState()).toBeNull();
		expect(isBuffering()).toBe(false);
	});

	it("undefined frames are a no-op (most status frames carry no buffering field)", () => {
		ingestBuffering(undefined);
		expect(getBufferingState()).toBeNull();
		expect(isBuffering()).toBe(false);
	});

	it("shows the indicator on a buffering-active event with spooled bytes", () => {
		ingestBuffering({ active: true, spooled_bytes: 4096 });
		expect(isBuffering()).toBe(true);
		expect(getBufferingState()).toEqual({
			active: true,
			spooledBytes: 4096,
			dataHeadroomBytes: null,
			diskWarning: false,
		});
	});

	it("hides the indicator on recovery (active:false)", () => {
		ingestBuffering({ active: true, spooled_bytes: 4096 });
		expect(isBuffering()).toBe(true);

		ingestBuffering({ active: false });
		expect(isBuffering()).toBe(false);
		expect(getBufferingState()?.active).toBe(false);
	});

	it("a malformed frame never disturbs the last-known state", () => {
		ingestBuffering({ active: true, spooled_bytes: 512 });
		ingestBuffering({ garbage: true });
		ingestBuffering(null);
		expect(isBuffering()).toBe(true);
		expect(getBufferingState()?.spooledBytes).toBe(512);
	});
});
