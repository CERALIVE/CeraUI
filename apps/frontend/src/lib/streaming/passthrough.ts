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

import type {
	DeviceMode,
	VideoCodec,
	VideoPassthrough,
} from "@ceraui/rpc/schemas";

export type PassthroughMode = "passthrough" | "transcode" | "forceUnavailable";

export const MEDIA_TYPE_H264 = "video/x-h264";
export const MEDIA_TYPE_H265 = "video/x-h265";

// The hardware codecs a capture device's probed modes reveal, h264→h265 order.
// The engine collapses a dual-capable UVC camera's scalar `kind` to a single
// H.265-priority value (`devices.rs`), but emits one mode per media type — so a
// dual device returns `["h264","h265"]` here even though `kind` names only one.
// Raw/MJPEG modes contribute nothing (`[]` → caller keeps its scalar-kind label).
export function captureModeCodecs(
	modes: readonly DeviceMode[] | undefined,
): VideoCodec[] {
	if (modes === undefined) return [];
	const codecs: VideoCodec[] = [];
	if (modes.some((m) => m.media_type === MEDIA_TYPE_H264)) codecs.push("h264");
	if (modes.some((m) => m.media_type === MEDIA_TYPE_H265)) codecs.push("h265");
	return codecs;
}

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
	offeredCodecs?: readonly VideoCodec[],
): boolean {
	// The modes-derived codec set is authoritative when present: it is the ONLY
	// input that stays correct for a dual-codec device (whose `kind` collapsed to
	// one value). Scalar-kind matching is the coarse/old-engine fallback.
	if (offeredCodecs !== undefined && offeredCodecs.length > 0) {
		return offeredCodecs.includes(outputCodec);
	}
	if (kind === "uvc_h264" || kind === "libuvch264")
		return outputCodec === "h264";
	if (kind === "uvc_h265") return outputCodec === "h265";
	return false;
}
