import { afterEach, describe, expect, it } from "bun:test";

import {
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import { pipelinesMessageSchema } from "@ceraui/rpc/schemas";
import {
	getPipelineList,
	getPipelinesMessage,
	initPipelines,
	searchPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";

type SourceCap = GetCapabilitiesResult["sources"][number];

function source(id: string, overrides: Partial<SourceCap> = {}): SourceCap {
	return {
		id,
		supports_audio: true,
		supports_resolution_override: true,
		supports_framerate_override: true,
		default_resolution: "1080p",
		default_framerate: 30,
		...overrides,
	};
}

function caps(sources: SourceCap[]): GetCapabilitiesResult {
	return {
		platform: {
			supports_h265: true,
			hardware_accelerated: true,
			max_resolution: "1080p",
		},
		encoder: {
			codecs: ["h264", "h265"],
			bitrate_range: { min: 500, max: 50000, unit: "kbps" },
		},
		sources,
	};
}

// Inject a synthetic capability contract as the live fetcher, standing in for the
// cerastream get-capabilities response so getPipelines() is exercised without the
// engine.
function provide(snapshot: GetCapabilitiesResult) {
	return {
		fetchEngineCapabilities: async () => ({
			caps: snapshot,
			schemaVersion: SCHEMA_VERSION,
		}),
	};
}

// rk3588 contract — note: NO decklink (dropped from the contract).
const RK3588 = caps([
	source("hdmi"),
	source("libuvch264"),
	source("usb_mjpeg"),
	source("rtmp", { supports_resolution_override: false }),
	source("srt", { supports_resolution_override: false }),
	source("test"),
]);

// n100 contract — decklink dropped; usb_mjpeg AND v4l_mjpeg both present to prove
// they remain DISTINCT ids (both map to the engine's single Mjpeg input kind).
const N100 = caps([
	source("libuvch264"),
	source("usb_mjpeg"),
	source("v4l_mjpeg"),
	source("rtmp", { supports_resolution_override: false }),
	source("test"),
]);

afterEach(async () => {
	// Restore the default table-derived contract + a deterministic device baseline.
	setMockHardware("rk3588");
	await initPipelines();
});

describe("getPipelines derives from the capability contract", () => {
	it("rk3588: maps contract source-kinds onto a schema-valid pipelines message (no decklink)", async () => {
		setMockHardware("rk3588");
		await initPipelines(provide(RK3588));

		const message = getPipelinesMessage();
		expect(pipelinesMessageSchema.safeParse(message).success).toBe(true);
		expect(message.hardware).toBe("rk3588");

		const ids = Object.keys(message.pipelines);
		expect(ids).toContain("hdmi");
		expect(ids).toContain("libuvch264");
		expect(ids).not.toContain("decklink");
	});

	it("n100: decklink absent; usb_mjpeg and v4l_mjpeg stay distinct ids", async () => {
		setMockHardware("n100");
		await initPipelines(provide(N100));

		const message = getPipelinesMessage();
		expect(pipelinesMessageSchema.safeParse(message).success).toBe(true);

		const ids = Object.keys(message.pipelines);
		expect(ids).not.toContain("decklink");
		expect(ids).toContain("usb_mjpeg");
		expect(ids).toContain("v4l_mjpeg");

		const usb = searchPipelines("usb_mjpeg");
		const v4l = searchPipelines("v4l_mjpeg");
		expect(usb?.source).toBe("usb_mjpeg");
		expect(v4l?.source).toBe("v4l_mjpeg");
	});

	it("default (table-derived) contract: n100 derives the per-board list minus decklink", async () => {
		setMockHardware("n100");
		await initPipelines();

		const ids = Object.keys(getPipelineList());
		expect(ids).not.toContain("decklink");
		expect(ids).toContain("libuvch264");
		expect(ids).toContain("v4l_mjpeg");
		expect(ids).toContain("rtmp");
		expect(ids).toContain("test");
	});

	it("default (table-derived) contract: rk3588 message validates and excludes decklink", async () => {
		setMockHardware("rk3588");
		await initPipelines();

		const message = getPipelinesMessage();
		expect(pipelinesMessageSchema.safeParse(message).success).toBe(true);
		expect(Object.keys(message.pipelines)).not.toContain("decklink");
	});
});
