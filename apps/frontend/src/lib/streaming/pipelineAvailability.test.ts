import type { NetworkIngest, Pipeline, Pipelines } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	isPipelineAvailable,
	PIPELINE_GATEWAY_DISABLED_IN_SETTINGS,
	PIPELINE_GATEWAY_INACTIVE,
	PIPELINE_GATEWAY_NO_ADDRESS,
	pipelineAvailability,
	pipelineViews,
} from "./pipelineAvailability";

// A minimal pipeline entry; only `requires_gateway` is read by the rule.
function makePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
	return {
		name: "Source",
		description: "A source",
		supportsAudio: false,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		...overrides,
	};
}

// A network-ingest surface with per-protocol service state.
function makeNetworkIngest(
	rtmpActive: boolean | null,
	srtActive: boolean | null,
): NetworkIngest {
	return {
		rtmp:
			rtmpActive === null
				? null
				: {
						service_active: rtmpActive,
						url: "rtmp://192.168.1.100:1935/publish/live",
					},
		srt:
			srtActive === null
				? null
				: { service_active: srtActive, url: "srt://192.168.1.100:4001" },
	};
}

describe("pipelineAvailability — gateway-active case", () => {
	it("marks an rtmp pipeline available when its gateway is active", () => {
		const verdict = pipelineAvailability(
			makePipeline({ requires_gateway: "rtmp" }),
			makeNetworkIngest(true, false),
		);
		expect(verdict.available).toBe(true);
	});

	it("marks an srt pipeline available when its gateway is active", () => {
		const verdict = pipelineAvailability(
			makePipeline({ requires_gateway: "srt" }),
			makeNetworkIngest(false, true),
		);
		expect(verdict.available).toBe(true);
	});

	it("keeps a non-gateway (direct-capture) pipeline available regardless of ingest state", () => {
		const verdict = pipelineAvailability(
			makePipeline(),
			makeNetworkIngest(false, false),
		);
		expect(verdict.available).toBe(true);
	});
});

describe("pipelineAvailability — gateway-inactive case", () => {
	it("blocks an rtmp pipeline with a reason when its gateway is inactive", () => {
		const verdict = pipelineAvailability(
			makePipeline({ requires_gateway: "rtmp" }),
			makeNetworkIngest(false, true),
		);
		expect(verdict.available).toBe(false);
		if (!verdict.available) {
			expect(verdict.reason).toBe(PIPELINE_GATEWAY_INACTIVE);
			expect(verdict.reason.length).toBeGreaterThan(0);
		}
	});

	it("blocks an srt pipeline whose protocol slot is null (board caps exclude it)", () => {
		const verdict = pipelineAvailability(
			makePipeline({ requires_gateway: "srt" }),
			makeNetworkIngest(true, null),
		);
		expect(verdict.available).toBe(false);
		if (!verdict.available) {
			expect(verdict.reason).toBe(PIPELINE_GATEWAY_INACTIVE);
		}
	});
});

describe("pipelineAvailability — addressless case (gateway up, url null)", () => {
	// The gateway service is running but no reachable LAN/hotspot address exists
	// (modem-only). This is a DISTINCT verdict from gateway-inactive.
	const addressless: NetworkIngest = {
		rtmp: {
			service_active: true,
			url: null,
			unavailable_reason: "no_lan_or_hotspot_address",
		},
		srt: { service_active: true, url: "srt://192.168.1.100:4001" },
	};

	it("blocks an rtmp pipeline with the DISTINCT no-address reason when url is null", () => {
		const verdict = pipelineAvailability(
			makePipeline({ requires_gateway: "rtmp" }),
			addressless,
		);
		expect(verdict.available).toBe(false);
		if (!verdict.available) {
			expect(verdict.reason).toBe(PIPELINE_GATEWAY_NO_ADDRESS);
			expect(verdict.reason).not.toBe(PIPELINE_GATEWAY_INACTIVE);
			expect(verdict.reason.length).toBeGreaterThan(0);
		}
	});

	it("keeps the sibling srt pipeline (which still has a url) available", () => {
		const verdict = pipelineAvailability(
			makePipeline({ requires_gateway: "srt" }),
			addressless,
		);
		expect(verdict.available).toBe(true);
	});
});

describe("pipelineAvailability — operator-disabled (Settings) case", () => {
	// The operator turned the protocol OFF in Settings. In the NEW topology the
	// shared MediaMTX unit can still report service_active for the sibling, so
	// operator intent must win over unit truth — with a DISTINCT reason.
	const disabledActive: NetworkIngest = {
		rtmp: {
			service_active: true,
			url: "rtmp://192.168.1.100:1935/publish/live",
			operator_disabled: true,
		},
		srt: { service_active: true, url: "srt://192.168.1.100:4001" },
	};

	it("blocks a disabled rtmp pipeline with the DISTINCT disabledInSettings reason even when service_active", () => {
		const verdict = pipelineAvailability(
			makePipeline({ requires_gateway: "rtmp" }),
			disabledActive,
		);
		expect(verdict.available).toBe(false);
		if (!verdict.available) {
			expect(verdict.reason).toBe(PIPELINE_GATEWAY_DISABLED_IN_SETTINGS);
			expect(verdict.reason).not.toBe(PIPELINE_GATEWAY_INACTIVE);
			expect(verdict.reason.length).toBeGreaterThan(0);
		}
	});

	it("keeps the sibling srt pipeline (not disabled) available on the same shared unit", () => {
		const verdict = pipelineAvailability(
			makePipeline({ requires_gateway: "srt" }),
			disabledActive,
		);
		expect(verdict.available).toBe(true);
	});

	it("operator_disabled takes precedence over the addressless (url null) state", () => {
		const verdict = pipelineAvailability(
			makePipeline({ requires_gateway: "rtmp" }),
			{
				rtmp: {
					service_active: true,
					url: null,
					unavailable_reason: "no_lan_or_hotspot_address",
					operator_disabled: true,
				},
				srt: null,
			},
		);
		expect(verdict.available).toBe(false);
		if (!verdict.available) {
			expect(verdict.reason).toBe(PIPELINE_GATEWAY_DISABLED_IN_SETTINGS);
			expect(verdict.reason).not.toBe(PIPELINE_GATEWAY_NO_ADDRESS);
		}
	});

	it("surfaces disabledInSettings (not gatewayInactive) even when the unit is also inactive", () => {
		const verdict = pipelineAvailability(
			makePipeline({ requires_gateway: "rtmp" }),
			{
				rtmp: { service_active: false, url: null, operator_disabled: true },
				srt: null,
			},
		);
		expect(verdict.available).toBe(false);
		if (!verdict.available) {
			expect(verdict.reason).toBe(PIPELINE_GATEWAY_DISABLED_IN_SETTINGS);
			expect(verdict.reason).not.toBe(PIPELINE_GATEWAY_INACTIVE);
		}
	});
});

describe("pipelineAvailability — protocol/network_ingest absent (null) case", () => {
	it("blocks an rtmp pipeline when network_ingest is null (older backend / not yet arrived)", () => {
		const verdict = pipelineAvailability(
			makePipeline({ requires_gateway: "rtmp" }),
			null,
		);
		expect(verdict.available).toBe(false);
		if (!verdict.available)
			expect(verdict.reason).toBe(PIPELINE_GATEWAY_INACTIVE);
	});

	it("blocks an srt pipeline when network_ingest is undefined", () => {
		const verdict = pipelineAvailability(
			makePipeline({ requires_gateway: "srt" }),
			undefined,
		);
		expect(verdict.available).toBe(false);
	});

	it("keeps a non-gateway pipeline available even when network_ingest is absent", () => {
		expect(pipelineAvailability(makePipeline(), null).available).toBe(true);
		expect(pipelineAvailability(makePipeline(), undefined).available).toBe(
			true,
		);
	});

	it("treats an undefined pipeline (no source selected) as available", () => {
		expect(pipelineAvailability(undefined, null).available).toBe(true);
	});
});

describe("isPipelineAvailable — boolean convenience", () => {
	it("mirrors pipelineAvailability().available", () => {
		expect(
			isPipelineAvailable(
				makePipeline({ requires_gateway: "rtmp" }),
				makeNetworkIngest(true, false),
			),
		).toBe(true);
		expect(
			isPipelineAvailable(
				makePipeline({ requires_gateway: "rtmp" }),
				makeNetworkIngest(false, false),
			),
		).toBe(false);
	});
});

describe("pipelineViews — per-pipeline verdict tagging (never hides)", () => {
	const pipelines: Pipelines = {
		hdmi: makePipeline({ name: "HDMI" }),
		rtmp: makePipeline({ name: "RTMP Ingest", requires_gateway: "rtmp" }),
		srt: makePipeline({ name: "SRT Ingest", requires_gateway: "srt" }),
	};

	it("returns every pipeline (unavailable ones disabled-with-reason, not dropped)", () => {
		const views = pipelineViews(pipelines, makeNetworkIngest(true, false));
		expect(views).toHaveLength(3);

		const hdmi = views.find((v) => v.id === "hdmi");
		const rtmp = views.find((v) => v.id === "rtmp");
		const srt = views.find((v) => v.id === "srt");

		expect(hdmi?.availability.available).toBe(true);
		expect(rtmp?.availability.available).toBe(true); // rtmp gateway active
		expect(srt?.availability.available).toBe(false); // srt gateway inactive
		if (srt && !srt.availability.available) {
			expect(srt.availability.reason).toBe(PIPELINE_GATEWAY_INACTIVE);
		}
	});

	it("blocks all gateway pipelines when network_ingest is absent, keeps direct-capture available", () => {
		const views = pipelineViews(pipelines, null);
		expect(views.find((v) => v.id === "hdmi")?.availability.available).toBe(
			true,
		);
		expect(views.find((v) => v.id === "rtmp")?.availability.available).toBe(
			false,
		);
		expect(views.find((v) => v.id === "srt")?.availability.available).toBe(
			false,
		);
	});

	it("returns [] for an absent pipeline map (still loading)", () => {
		expect(pipelineViews(undefined, makeNetworkIngest(true, true))).toEqual([]);
	});
});
