/**
 * networkIngestRows — shared structural derivation for the network-ingest source
 * rows (Task 12). Both `NetworkIngestSection.svelte` and `SourceSection.svelte`
 * consume this, so the truth (availability, addressless, embedded-audio) is proven
 * here once and neither surface re-derives it.
 */
import type {
	CapabilitiesMessage,
	NetworkIngest,
	Pipeline,
	Pipelines,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";
import {
	deriveNetworkIngestRows,
	NETWORK_INGEST_PROTOCOL_ORDER,
	pipelineIdForProtocol,
	sourceSupportsEmbeddedAudio,
} from "./networkIngestRows";
import {
	PIPELINE_GATEWAY_INACTIVE,
	PIPELINE_GATEWAY_NO_ADDRESS,
} from "./pipelineAvailability";

const RTMP_URL = "rtmp://192.168.1.100:1935/publish/live";
const SRT_URL = "srt://192.168.1.100:4001";

function pipeline(overrides: Partial<Pipeline> = {}): Pipeline {
	return {
		name: "Pipeline",
		description: "",
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		...overrides,
	};
}

const PIPELINES: Pipelines = {
	rtmp_source: pipeline({ name: "RTMP Ingest", requires_gateway: "rtmp" }),
	srt_source: pipeline({ name: "SRT Ingest", requires_gateway: "srt" }),
	hdmi: pipeline({ name: "HDMI" }),
};

function bothActive(): NetworkIngest {
	return {
		rtmp: { service_active: true, url: RTMP_URL },
		srt: { service_active: true, url: SRT_URL },
	};
}

const CAPS_WITH_AUDIO: CapabilitiesMessage = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "1080p",
	},
	encoder: {
		codecs: ["h264"],
		bitrate_range: { min: 500, max: 20000, unit: "kbps" },
	},
	sources: [
		{
			id: "rtmp_source",
			supports_audio: true,
			supports_resolution_override: false,
			supports_framerate_override: false,
			default_resolution: "1080p",
			default_framerate: 30,
		},
		{
			id: "srt",
			supports_audio: false,
			supports_resolution_override: false,
			supports_framerate_override: false,
			default_resolution: "1080p",
			default_framerate: 30,
		},
	],
};

describe("pipelineIdForProtocol", () => {
	it("resolves the registry id whose requires_gateway matches", () => {
		expect(pipelineIdForProtocol("rtmp", PIPELINES)).toBe("rtmp_source");
		expect(pipelineIdForProtocol("srt", PIPELINES)).toBe("srt_source");
	});

	it("falls back to the protocol key when the registry hasn't loaded", () => {
		expect(pipelineIdForProtocol("rtmp", undefined)).toBe("rtmp");
		expect(pipelineIdForProtocol("srt", {})).toBe("srt");
	});
});

describe("sourceSupportsEmbeddedAudio", () => {
	it("reads supports_audio matched by pipeline id", () => {
		expect(
			sourceSupportsEmbeddedAudio(CAPS_WITH_AUDIO, "rtmp_source", "rtmp"),
		).toBe(true);
	});

	it("falls back to matching the protocol key", () => {
		// srt caps entry is keyed by the protocol ("srt"), not the pipeline id.
		expect(
			sourceSupportsEmbeddedAudio(CAPS_WITH_AUDIO, "srt_source", "srt"),
		).toBe(false);
	});

	it("is false when caps are absent (legacy engine)", () => {
		expect(sourceSupportsEmbeddedAudio(undefined, "rtmp_source", "rtmp")).toBe(
			false,
		);
	});
});

describe("deriveNetworkIngestRows", () => {
	it("returns [] when network_ingest is null/undefined (fail-safe)", () => {
		expect(deriveNetworkIngestRows({ networkIngest: null })).toEqual([]);
		expect(deriveNetworkIngestRows({ networkIngest: undefined })).toEqual([]);
	});

	it("emits rows in protocol order with resolved pipeline ids + urls", () => {
		const rows = deriveNetworkIngestRows({
			networkIngest: bothActive(),
			pipelines: PIPELINES,
			capabilities: CAPS_WITH_AUDIO,
		});
		expect(rows.map((r) => r.protocol)).toEqual([
			...NETWORK_INGEST_PROTOCOL_ORDER,
		]);
		expect(rows[0]).toMatchObject({
			protocol: "rtmp",
			pipelineId: "rtmp_source",
			url: RTMP_URL,
			serviceActive: true,
			gatewayBlocked: false,
			disabled: false,
			supportsAudio: true,
		});
		expect(rows[1]).toMatchObject({ protocol: "srt", supportsAudio: false });
	});

	it("omits an absent (null) protocol slot — never hidden vs never offered", () => {
		const rows = deriveNetworkIngestRows({
			networkIngest: {
				rtmp: { service_active: true, url: RTMP_URL },
				srt: null,
			},
			pipelines: PIPELINES,
		});
		expect(rows.map((r) => r.protocol)).toEqual(["rtmp"]);
	});

	it("blocks an inactive gateway with the inactive reason (via pipelineAvailability)", () => {
		const rows = deriveNetworkIngestRows({
			networkIngest: {
				rtmp: { service_active: false, url: RTMP_URL },
				srt: null,
			},
			pipelines: PIPELINES,
		});
		expect(rows[0]).toMatchObject({
			gatewayBlocked: true,
			addressless: false,
			disabled: true,
		});
		// The reason itself is the shared gateway-inactive key (surface maps to i18n).
		expect(PIPELINE_GATEWAY_INACTIVE).toBe(
			"live.education.reason.gatewayInactive",
		);
	});

	it("flags the addressless (gateway up, no LAN/hotspot) state distinctly", () => {
		const rows = deriveNetworkIngestRows({
			networkIngest: {
				rtmp: {
					service_active: true,
					url: null,
					unavailable_reason: "no_lan_or_hotspot_address",
				},
				srt: null,
			},
			pipelines: PIPELINES,
		});
		expect(rows[0]).toMatchObject({
			gatewayBlocked: true,
			addressless: true,
			url: null,
		});
		expect(PIPELINE_GATEWAY_NO_ADDRESS).toBe(
			"live.education.reason.gatewayNoAddress",
		);
	});

	it("disables every row while streaming (streamingLocked, gateway itself fine)", () => {
		const rows = deriveNetworkIngestRows({
			networkIngest: bothActive(),
			pipelines: PIPELINES,
			isStreaming: true,
		});
		expect(rows[0]).toMatchObject({
			disabled: true,
			streamingLocked: true,
			gatewayBlocked: false,
		});
	});

	it("marks the selected pipeline", () => {
		const rows = deriveNetworkIngestRows({
			networkIngest: bothActive(),
			pipelines: PIPELINES,
			selectedPipeline: "srt_source",
		});
		expect(rows.find((r) => r.protocol === "srt")?.selected).toBe(true);
		expect(rows.find((r) => r.protocol === "rtmp")?.selected).toBe(false);
	});
});
