import {
	MEDIA_TYPE_H264,
	MEDIA_TYPE_H265,
	type PlatformCaps,
} from "@ceraui/rpc";
import type { CapabilitiesMessage, CaptureDevice } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	bitrateBoundsFromCaps,
	clampBitrateToBounds,
	deriveCodecOptions,
	deriveUvcH265Sources,
	summarizeProbedCaps,
} from "./ValidationAdapter";

function makeCaps(min: number, max: number): CapabilitiesMessage {
	return {
		platform: {
			supports_h265: true,
			hardware_accelerated: false,
			max_resolution: "1080p",
		},
		encoder: {
			codecs: ["H264", "H265"],
			bitrate_range: { min, max, unit: "kbps" },
		},
		sources: [],
	};
}

const accel: PlatformCaps = {
	supports_h265: true,
	hardware_accelerated: true,
	max_resolution: "2160p",
};
const generic: PlatformCaps = {
	supports_h265: true,
	hardware_accelerated: false,
	max_resolution: "1080p",
};
const noH265: PlatformCaps = {
	supports_h265: false,
	hardware_accelerated: true,
	max_resolution: "1080p",
};

function makeDevice(mediaType: string | undefined): CaptureDevice {
	return {
		input_id: "usb-cam-0",
		device_path: "/dev/video0",
		display_name: "QA H.265 Cam",
		media_class: "video",
		kind: "usb",
		caps: mediaType
			? [{ width: 1920, height: 1080, media_type: mediaType }]
			: [],
	};
}

describe("bitrateBoundsFromCaps", () => {
	it("falls back to the schema-wide range when no contract is present", () => {
		expect(bitrateBoundsFromCaps(undefined)).toEqual({
			min: 500,
			max: 50000,
			defaultMin: 2000,
			defaultMax: 12000,
		});
	});

	it("uses the per-board window from the contract", () => {
		expect(bitrateBoundsFromCaps(makeCaps(2000, 15000))).toEqual({
			min: 2000,
			max: 15000,
			defaultMin: 2000,
			defaultMax: 12000,
		});
	});

	it("keeps the practical slider seeds inside a narrow per-board window", () => {
		expect(bitrateBoundsFromCaps(makeCaps(6000, 8000))).toEqual({
			min: 6000,
			max: 8000,
			defaultMin: 6000,
			defaultMax: 8000,
		});
	});
});

describe("clampBitrateToBounds", () => {
	const bounds = bitrateBoundsFromCaps(makeCaps(2000, 15000));

	it("snaps an over-max entry down to the board ceiling", () => {
		expect(clampBitrateToBounds(50000, bounds)).toBe(15000);
	});

	it("snaps an under-min entry up to the board floor", () => {
		expect(clampBitrateToBounds(100, bounds)).toBe(2000);
	});

	it("passes an in-range value through unchanged", () => {
		expect(clampBitrateToBounds(9000, bounds)).toBe(9000);
	});

	it("returns the default seed for a non-finite value", () => {
		expect(clampBitrateToBounds(Number.NaN, bounds)).toBe(bounds.defaultMin);
	});
});

describe("deriveCodecOptions", () => {
	it("offers H.264 only when nothing is known", () => {
		expect(deriveCodecOptions(undefined)).toEqual([
			{
				mediaType: MEDIA_TYPE_H264,
				value: "h264",
				hardwareAccelerated: false,
				softwareWarning: false,
			},
		]);
	});

	it("offers H.265 without a warning on a hardware-accelerated board", () => {
		const options = deriveCodecOptions(accel);
		const h265 = options.find((o) => o.value === "h265");
		expect(h265).toBeDefined();
		expect(h265?.softwareWarning).toBe(false);
	});

	it("offers generic H.265 WITH the software-encode warning", () => {
		const options = deriveCodecOptions(generic);
		const h265 = options.find((o) => o.value === "h265");
		expect(h265).toBeDefined();
		expect(h265?.softwareWarning).toBe(true);
	});

	it("omits H.265 entirely when the platform does not support it", () => {
		const options = deriveCodecOptions(noH265);
		expect(options.some((o) => o.value === "h265")).toBe(false);
	});

	it("labels EVERY codec hardware-accelerated uniformly on an accelerated board", () => {
		const options = deriveCodecOptions(accel);
		expect(options.length).toBeGreaterThan(1);
		expect(options.every((o) => o.hardwareAccelerated)).toBe(true);
	});

	it("labels EVERY codec software uniformly on a generic board", () => {
		const options = deriveCodecOptions(generic);
		expect(options.length).toBeGreaterThan(1);
		expect(options.every((o) => !o.hardwareAccelerated)).toBe(true);
		const h264 = options.find((o) => o.value === "h264");
		expect(h264?.hardwareAccelerated).toBe(false);
	});
});

describe("summarizeProbedCaps", () => {
	it("returns nothing for an absent device list", () => {
		expect(summarizeProbedCaps(undefined)).toEqual([]);
	});

	it("omits a device that advertises no formats", () => {
		expect(summarizeProbedCaps([makeDevice(undefined)])).toEqual([]);
	});

	it("formats a probed format as a compact resolution + codec spec", () => {
		expect(summarizeProbedCaps([makeDevice(MEDIA_TYPE_H265)])).toEqual([
			{
				inputId: "usb-cam-0",
				displayName: "QA H.265 Cam",
				caps: ["1920\u00d71080 H.265"],
			},
		]);
	});
});

describe("deriveUvcH265Sources", () => {
	it("returns nothing for an absent device list", () => {
		expect(deriveUvcH265Sources(undefined)).toEqual([]);
	});

	it("surfaces a device advertising video/x-h265 as a uvc_h265 source", () => {
		expect(deriveUvcH265Sources([makeDevice(MEDIA_TYPE_H265)])).toEqual([
			{
				inputId: "usb-cam-0",
				displayName: "QA H.265 Cam",
				sourceKind: "uvc_h265",
			},
		]);
	});

	it("ignores a device that only advertises H.264", () => {
		expect(deriveUvcH265Sources([makeDevice(MEDIA_TYPE_H264)])).toEqual([]);
	});

	it("ignores a device with no advertised formats", () => {
		expect(deriveUvcH265Sources([makeDevice(undefined)])).toEqual([]);
	});
});
