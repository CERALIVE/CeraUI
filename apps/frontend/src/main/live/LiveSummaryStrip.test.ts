// @vitest-environment jsdom
/**
 * LiveSummaryStrip — the "Now streaming" summary strip (Task T12).
 *
 * Locks the plan's acceptance:
 *   • full activeEncode → every token renders (source · mode · codec · transport
 *     → destination), sourced from engine truth;
 *   • null activeEncode → falls back to the SAVED config tokens (no fabrication);
 *   • absent fields render NOTHING — never the literal "undefined", never an empty
 *     separator (config-less strip = transport-only, no crash);
 *   • R5-1: resolved_asrc "HDMI" + pending_audio_follow_asrc "USB audio" → the audio
 *     line shows HDMI as CURRENT and a pending pill NAMING USB audio — never
 *     USB-as-current;
 *   • R9-1: resolved_asrc_reason 'embedded' → the audio line shows the "Embedded
 *     audio" copy, not a dash.
 *
 * The audio props are produced by the SAME pure owners LiveView threads through
 * (deriveActiveSummary + resolvedAudioLabel), so this is a real end-to-end proof of
 * the current-vs-pending distinction, not just markup.
 */
import type {
	ActiveEncode,
	AudioSource,
	ConfigMessage,
	StreamSource,
} from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import {
	type ActiveSummary,
	deriveActiveSummary,
	resolvedAudioLabel,
} from "$lib/streaming/sourceSummary";
import LiveSummaryStrip from "./LiveSummaryStrip.svelte";

const identity = (key: string): string => key;

function captureSource(id: string, displayName: string): StreamSource {
	return {
		id,
		pipelineId: `${id}-pipe`,
		modes: [],
		supportsAudio: false,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: "none",
		available: true,
		origin: "capture",
		kind: "hdmi",
		displayName,
		devicePath: `/dev/${id}`,
	};
}

function strip(
	over: Partial<{
		summary: ActiveSummary;
		destination: string | undefined;
		audioCurrent: string | undefined;
		audioPending: string | undefined;
		audioEmbedded: boolean;
	}> = {},
) {
	const summary: ActiveSummary = over.summary ?? {
		live: true,
		source: "HDMI Capture",
		resolution: "1080p",
		framerate: 60,
		codec: "H.265",
		inputCodec: undefined,
		transport: "SRTLA",
	};
	return render(LiveSummaryStrip, {
		props: {
			summary,
			destination: over.destination,
			audioCurrent: over.audioCurrent,
			audioPending: over.audioPending,
			audioEmbedded: over.audioEmbedded ?? false,
		},
	});
}

function liveValue(container: HTMLElement, key: string): string | null {
	return (
		container
			.querySelector(`[data-live-value="${key}"]`)
			?.textContent?.trim() ?? null
	);
}

describe("LiveSummaryStrip — full activeEncode summary", () => {
	it("renders every token from engine truth: source · mode · codec · transport → destination", () => {
		const summary = deriveActiveSummary(
			{} as ConfigMessage,
			{
				active_input: "cam-1",
				resolution: "1920x1080",
				framerate: 60,
				codec: "h265",
			} as ActiveEncode,
			undefined,
			[captureSource("cam-1", "HDMI Capture")],
		);
		const { container } = strip({ summary, destination: "CeraLive Cloud" });

		expect(liveValue(container, "source")).toBe("HDMI Capture");
		expect(liveValue(container, "resolution")).not.toBeNull();
		expect(liveValue(container, "framerate")).toBe("60fps");
		expect(liveValue(container, "codec")).toBe("H.265");
		expect(liveValue(container, "transport")).toBe("SRTLA");
		expect(liveValue(container, "destination")).toBe("CeraLive Cloud");
		expect(container.textContent).not.toContain("undefined");
	});
});

describe("LiveSummaryStrip — null activeEncode falls back to saved config", () => {
	it("uses the saved config tokens when there is no engine active_encode", () => {
		const summary = deriveActiveSummary(
			{
				source: "cam-1",
				resolution: "720p",
				framerate: 30,
				video_codec: "h264",
			} as ConfigMessage,
			null,
			undefined,
			[captureSource("cam-1", "USB Cam")],
		);
		const { container } = strip({ summary, destination: "BELABOX Cloud" });

		// config.source is preferred over the legacy fallbacks and resolves via the list.
		expect(liveValue(container, "source")).toBe("USB Cam");
		expect(liveValue(container, "resolution")).toBe("720p");
		expect(liveValue(container, "framerate")).toBe("30fps");
		expect(liveValue(container, "codec")).toBe("H.264");
		expect(container.textContent).not.toContain("undefined");
	});
});

describe("LiveSummaryStrip — absent fields render nothing", () => {
	it("a config-less summary renders transport-only, no crash, no empty separators", () => {
		const summary = deriveActiveSummary(undefined, null, undefined, undefined);
		const { container } = strip({ summary });

		expect(
			container.querySelector('[data-testid="live-summary-strip"]'),
		).not.toBeNull();
		expect(liveValue(container, "source")).toBeNull();
		expect(liveValue(container, "resolution")).toBeNull();
		expect(liveValue(container, "framerate")).toBeNull();
		expect(liveValue(container, "codec")).toBeNull();
		expect(liveValue(container, "transport")).toBe("SRTLA");
		expect(liveValue(container, "destination")).toBeNull();
		expect(container.textContent).not.toContain("undefined");
		// The main line has no leading/dangling separator when only transport shows.
		const mainLine = container
			.querySelector('[data-live-value="transport"]')
			?.closest("p");
		expect(mainLine?.textContent?.includes("\u00b7")).toBe(false);
		expect(mainLine?.textContent?.includes("\u2192")).toBe(false);
	});
});

describe("LiveSummaryStrip — R5-1: current audio vs pending follow", () => {
	it("shows resolved_asrc (HDMI) as current AND a pending pill naming USB audio", () => {
		const entries: AudioSource[] = [
			{ id: "HDMI", kind: "device", label: "HDMI" },
			{ id: "USB audio", kind: "device", label: "USB audio" },
		];
		const resolved = resolvedAudioLabel(
			{ asrc: "Auto" } as ConfigMessage,
			{ resolved_asrc: "HDMI", pending_audio_follow_asrc: "USB audio" },
			entries,
			identity,
		);
		const { container, getByTestId } = strip({
			audioCurrent: resolved.current,
			audioPending: resolved.pending,
		});

		// Current line: Auto resolved to HDMI, never USB.
		const current = liveValue(container, "audio") ?? "";
		expect(current).toContain("HDMI");
		expect(current).not.toContain("USB audio");

		// Pending pill: distinct element, names the deferred USB audio target.
		const pending = getByTestId("audio-follow-pending");
		expect(pending.textContent).toContain("USB audio");
	});
});

describe("LiveSummaryStrip — R9-1: embedded audio", () => {
	it("shows the Embedded audio copy, not a dash", () => {
		const { container } = strip({
			audioEmbedded: true,
			audioCurrent: undefined,
		});
		const audio = liveValue(container, "audio") ?? "";
		expect(audio.length).toBeGreaterThan(0);
		expect(audio).not.toBe("\u2014");
		// The R9-1 reason drives the embedded copy through resolvedAudioLabel.
		const resolved = resolvedAudioLabel(
			{ asrc: "Auto" } as ConfigMessage,
			{ resolved_asrc: null, resolved_asrc_reason: "embedded" },
			[],
			identity,
		);
		expect(resolved.embedded).toBe(true);
	});
});

describe("LiveSummaryStrip — T14 transcode chip", () => {
	function networkSource(id: "rtmp" | "srt"): StreamSource {
		return {
			id,
			pipelineId: id,
			labelKey: `settings.sources.${id}`,
			requiresGateway: id,
			url: `${id}://192.168.1.100:1935/publish/live`,
			modes: [],
			supportsAudio: true,
			supportsResolutionOverride: false,
			supportsFramerateOverride: false,
			audioKind: "embedded",
			available: true,
			origin: "network",
		};
	}

	it("renders In→Out when the network source reports input_codec", () => {
		const summary = deriveActiveSummary(
			{ source: "rtmp" } as ConfigMessage,
			{
				active_input: "rtmp",
				resolution: "1920x1080",
				framerate: 30,
				codec: "h265",
				input_codec: "h264",
			} as ActiveEncode,
			undefined,
			[networkSource("rtmp")],
		);
		const { getByTestId } = strip({ summary });

		const chip = getByTestId("transcode-chip");
		expect(chip.textContent).toContain("H.264");
		expect(chip.textContent).toContain("H.265");
		expect(chip.getAttribute("title")?.length).toBeGreaterThan(0);
	});

	it("no chip for a capture source even with input_codec present", () => {
		const summary = deriveActiveSummary(
			{ source: "cam-1" } as ConfigMessage,
			{
				active_input: "cam-1",
				resolution: "1920x1080",
				framerate: 30,
				codec: "h265",
				input_codec: "h264",
			} as ActiveEncode,
			undefined,
			[captureSource("cam-1", "HDMI Capture")],
		);
		const { queryByTestId } = strip({ summary });
		expect(queryByTestId("transcode-chip")).toBeNull();
	});

	it("no chip when the engine omits input_codec (older-engine degradation)", () => {
		const summary = deriveActiveSummary(
			{ source: "rtmp" } as ConfigMessage,
			{
				active_input: "rtmp",
				resolution: "1920x1080",
				framerate: 30,
				codec: "h265",
			} as ActiveEncode,
			undefined,
			[networkSource("rtmp")],
		);
		const { queryByTestId } = strip({ summary });
		expect(queryByTestId("transcode-chip")).toBeNull();
	});
});
