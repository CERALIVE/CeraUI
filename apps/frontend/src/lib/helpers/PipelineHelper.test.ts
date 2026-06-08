import type { Pipelines } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { getPipelineDisplayName, getSourceLabel } from "./PipelineHelper";

// A realistic ceracoder pipeline id that is NOT a known video source — this is
// the value that used to leak through `source.toUpperCase()` (PipelineHelper.ts:33).
const HASH_ID = "aa5813aa21487de31570a888272bace773d556e0";

// Minimal i18n resolver mirroring EncoderDialog.svelte:90 / EncoderCard.svelte:55 —
// returns the key itself when no translation exists.
const passthroughT = (key: string): string => key;

// Pipelines fixture keyed by a known video source (`libuvch264`). The hash id is
// intentionally absent so unknown lookups must resolve via the safe fallback.
const pipelines: Pipelines = {
	libuvch264: {
		name: "UVC H264 Camera",
		description: "USB Video Class H.264 camera",
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
	},
};

describe("getSourceLabel", () => {
	it("never returns the raw/uppercased hash for an unknown source", () => {
		const label = getSourceLabel(HASH_ID);
		expect(label).not.toBe(HASH_ID.toUpperCase());
		expect(label).not.toBe(HASH_ID);
		expect(label.toLowerCase()).not.toContain(HASH_ID.toLowerCase());
	});

	it("returns the safe generic fallback for an unknown source", () => {
		expect(getSourceLabel(HASH_ID)).toBe("Unknown source");
	});

	it("still resolves a known video source to its friendly label", () => {
		expect(getSourceLabel("libuvch264")).toBe("UVC H264 Camera");
	});

	it("preserves the translated-key branch when a resolver hits", () => {
		const t = (key: string) =>
			key === "settings.sources.libuvch264" ? "Translated UVC" : key;
		expect(getSourceLabel("libuvch264", t)).toBe("Translated UVC");
	});

	it("falls back to bindings label when the resolver misses the key", () => {
		expect(getSourceLabel("libuvch264", passthroughT)).toBe("UVC H264 Camera");
	});
});

describe("getPipelineDisplayName", () => {
	it("resolves a known source id to its friendly label", () => {
		expect(getPipelineDisplayName("libuvch264", pipelines)).toBe(
			"UVC H264 Camera",
		);
	});

	it("never leaks a hash id and resolves to the safe fallback", () => {
		const name = getPipelineDisplayName(HASH_ID, pipelines);
		expect(name).toBe("Unknown source");
		expect(name).not.toBe(HASH_ID.toUpperCase());
		expect(name).not.toBe(HASH_ID);
	});

	it("returns the empty sentinel for an undefined id", () => {
		expect(getPipelineDisplayName(undefined, pipelines)).toBe("");
	});

	it("is pure and tolerates missing pipelines", () => {
		expect(getPipelineDisplayName("libuvch264")).toBe("UVC H264 Camera");
		expect(getPipelineDisplayName(HASH_ID)).toBe("Unknown source");
	});
});
