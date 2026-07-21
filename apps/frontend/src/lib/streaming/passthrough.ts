// Pure, rune-free derivation of the RESOLVED same-codec passthrough mode for the
// pre-start Encoder disclosure and the bitrate-slider gate (Todo 18, part d).
//
// The engine's honest policy (cerastream Todo 16): under `auto`, an ACTIVE adaptive
// bitrate loop forces transcode (a passed-through camera stream can't have its
// bitrate driven), so passthrough only appears for a fixed-bitrate `auto` session
// or an explicit `force`. `off` always transcodes. `force` on a source that can't
// offer the output codec (MJPEG/raw) is surfaced BEFORE start as an unavailable
// warning — the engine would reject that start typed, and the pre-start disclosure
// is what makes `force` safe.

import type { VideoCodec, VideoPassthrough } from "@ceraui/rpc/schemas";

export type PassthroughMode = "passthrough" | "transcode" | "forceUnavailable";

export interface PassthroughInputs {
	setting: VideoPassthrough;
	// Whether the active source can emit the requested OUTPUT codec as a
	// compressed, passthrough-capable stream (h264 device + h264 output, etc.).
	sourceOffersOutputCodec: boolean;
	// Whether the adaptive bitrate loop is active this session (balancer !== fixed).
	adaptiveActive: boolean;
}

export function resolvePassthroughMode(i: PassthroughInputs): PassthroughMode {
	if (i.setting === "off") return "transcode";
	if (i.setting === "force") {
		return i.sourceOffersOutputCodec ? "passthrough" : "forceUnavailable";
	}
	return i.sourceOffersOutputCodec && !i.adaptiveActive
		? "passthrough"
		: "transcode";
}

// Which capture-source kinds carry a compressed stream that can be passed through
// for a given output codec. MJPEG (must decode), raw HDMI/Cam Link, network legs,
// and the test pattern never passthrough. A coarse `libuvch264` row is treated as
// H.264-capable (its hardware-H.264 UVC identity), and the resolved per-codec UVC
// kinds map to their own codec.
export function sourceOffersCodec(
	kind: string | undefined,
	outputCodec: VideoCodec,
): boolean {
	if (kind === "uvc_h264" || kind === "libuvch264")
		return outputCodec === "h264";
	if (kind === "uvc_h265") return outputCodec === "h265";
	return false;
}
