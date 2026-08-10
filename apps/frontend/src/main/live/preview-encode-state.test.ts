/**
 * T15 — the three-channel derivation behind the hardware-preview control.
 *
 * These tests exist because the four readings of capability
 * (`true` / `false` / absent-field / absent-`preview`-block) are FOUR different
 * facts, and collapsing any of them into another either offers an operator a
 * switch their board cannot honour or hides one that works. The same applies to
 * the fallback report: dropping `property` turns "this image's encoder plugin
 * refuses `bps`" into the useless "hardware preview is broken".
 */
import type {
	CapabilitiesMessage,
	ConfigMessage,
	PreviewEncoderRealized,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { derivePreviewEncodeView } from "./preview-encode-state";

const BASE_CAPS: CapabilitiesMessage = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "3840x2160",
	},
	encoder: {
		codecs: ["H264"],
		bitrate_range: { min: 500, max: 12000, unit: "kbps" },
	},
	sources: [],
};

function capsWithPreview(
	preview: CapabilitiesMessage["preview"],
): CapabilitiesMessage {
	return { ...BASE_CAPS, ...(preview ? { preview } : {}) };
}

const HARDWARE_REALIZED: PreviewEncoderRealized = {
	selected_element: "mpph264enc",
	realized_element: "mpph264enc",
	mode: "hardware",
};

const FACTORY_MISSING: PreviewEncoderRealized = {
	selected_element: "mpph264enc",
	realized_element: "x264enc",
	mode: "software",
	fallback_reason: { code: "factory-missing" },
};

const PROPERTY_FAILURE: PreviewEncoderRealized = {
	selected_element: "mpph264enc",
	realized_element: "x264enc",
	mode: "software",
	fallback_reason: { code: "property-failure", property: "bps" },
};

describe("visibility is gated on preview_hw_capability === true and nothing else", () => {
	it("a board that publishes the capability shows the control", () => {
		const caps = capsWithPreview({
			enabled: true,
			bound: true,
			preview_hw_capability: true,
		});
		expect(derivePreviewEncodeView(caps, null, undefined).visible).toBe(true);
	});

	it("an explicit false hides it — the board publishes no preview encoder", () => {
		const caps = capsWithPreview({
			enabled: true,
			bound: true,
			preview_hw_capability: false,
		});
		expect(derivePreviewEncodeView(caps, null, undefined).visible).toBe(false);
	});

	it("an ABSENT field hides it — a legacy engine never stated a capability", () => {
		const caps = capsWithPreview({ enabled: true, bound: true });
		expect(derivePreviewEncodeView(caps, null, undefined).visible).toBe(false);
	});

	it("an absent preview BLOCK hides it — capability is unknown, not false", () => {
		expect(derivePreviewEncodeView(BASE_CAPS, null, undefined).visible).toBe(
			false,
		);
	});

	it("an absent capability snapshot hides it — nothing has arrived yet", () => {
		expect(derivePreviewEncodeView(undefined, null, undefined).visible).toBe(
			false,
		);
	});

	it("a live hardware realization does NOT substitute for the capability gate", () => {
		// Realized is session-scoped truth; capability is the platform channel.
		// One never stands in for the other, in either direction.
		expect(
			derivePreviewEncodeView(BASE_CAPS, HARDWARE_REALIZED, undefined).visible,
		).toBe(false);
	});
});

describe("the request defaults OFF", () => {
	const caps = capsWithPreview({
		enabled: true,
		bound: true,
		preview_hw_capability: true,
	});

	it("an absent config reads software — never hardware", () => {
		expect(derivePreviewEncodeView(caps, null, undefined).requested).toBe(
			"software",
		);
	});

	it("a config with no previewEncode reads software", () => {
		const config = { max_br: 6000 } as ConfigMessage;
		expect(derivePreviewEncodeView(caps, null, config).requested).toBe(
			"software",
		);
	});

	it("an explicit hardware request is carried through verbatim", () => {
		const config = { previewEncode: "hardware" } as ConfigMessage;
		expect(derivePreviewEncodeView(caps, null, config).requested).toBe(
			"hardware",
		);
	});
});

describe("the active reading is the REALIZED element, never the request", () => {
	const caps = capsWithPreview({
		enabled: true,
		bound: true,
		preview_hw_capability: true,
	});
	const requestedHardware = { previewEncode: "hardware" } as ConfigMessage;

	it('no session publishes no active reading — absent is not "software"', () => {
		expect(
			derivePreviewEncodeView(caps, null, requestedHardware).active,
		).toBeNull();
		expect(
			derivePreviewEncodeView(caps, undefined, requestedHardware).active,
		).toBeNull();
	});

	it("hardware asked for and delivered reports the hardware element", () => {
		expect(
			derivePreviewEncodeView(caps, HARDWARE_REALIZED, requestedHardware)
				.active,
		).toEqual({
			element: "mpph264enc",
			mode: "hardware",
		});
	});

	it("a fallen-back session reports the SOFTWARE element it actually built", () => {
		expect(
			derivePreviewEncodeView(caps, FACTORY_MISSING, requestedHardware).active,
		).toEqual({
			element: "x264enc",
			mode: "software",
		});
	});
});

describe("the fallback report is never swallowed", () => {
	const caps = capsWithPreview({
		enabled: true,
		bound: true,
		preview_hw_capability: true,
	});
	const requestedHardware = { previewEncode: "hardware" } as ConfigMessage;

	it("factory-missing surfaces its code", () => {
		expect(
			derivePreviewEncodeView(caps, FACTORY_MISSING, requestedHardware)
				.fallback,
		).toEqual({
			code: "factory-missing",
		});
	});

	it("property-failure surfaces its code AND the property name", () => {
		expect(
			derivePreviewEncodeView(caps, PROPERTY_FAILURE, requestedHardware)
				.fallback,
		).toEqual({
			code: "property-failure",
			property: "bps",
		});
	});

	it("a delivered hardware session reports no fallback", () => {
		expect(
			derivePreviewEncodeView(caps, HARDWARE_REALIZED, requestedHardware)
				.fallback,
		).toBeNull();
	});

	it("software chosen on a capable board is not a fallback", () => {
		const software: PreviewEncoderRealized = {
			selected_element: "mpph264enc",
			realized_element: "x264enc",
			mode: "software",
		};
		expect(
			derivePreviewEncodeView(caps, software, undefined).fallback,
		).toBeNull();
	});

	it("the report survives the operator flipping the request back to software", () => {
		// The live session is STILL the fallen-back one. Keying the warning on a
		// local config-vs-status comparison would erase it the instant the operator
		// untoggled, while the software preview it explains is still on screen.
		const config = { previewEncode: "software" } as ConfigMessage;
		expect(
			derivePreviewEncodeView(caps, PROPERTY_FAILURE, config).fallback,
		).toEqual({
			code: "property-failure",
			property: "bps",
		});
	});
});
