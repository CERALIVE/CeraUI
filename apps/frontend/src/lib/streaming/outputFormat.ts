// Pure, rune-free derivation of the Encoder dialog's output format and of the one
// line that says what the device will do with the picture. The engine decides the
// format and whether to re-encode (cerastream `decide_passthrough`); this module
// only reports it, from the engine's own answer while live and from the saved
// settings and the active source before start.

import {
	intersectCaps,
	MEDIA_TYPE_H264,
	MEDIA_TYPE_H265,
	type OfferedSet,
} from "@ceraui/rpc";
import {
	type ActiveEncode,
	type CapabilitiesMessage,
	type InputMode,
	ROUTE_REASONS,
	type StreamingSetConfigInput,
	type StreamSource,
	type VideoCodec,
	type VideoPassthrough,
} from "@ceraui/rpc/schemas";

import { STREAMING_MODE } from "$lib/components/streaming/ValidationAdapter";

import { governingInputMode } from "./capture-modes";
import { captureModeCodecs, sourceOffersCodec } from "./passthrough";

export type BalancerAlgorithm = NonNullable<
	StreamingSetConfigInput["balancer"]
>;
type PlatformCaps = CapabilitiesMessage["platform"];

export type RouteOutcome =
	| "untouched"
	| "forceUnavailable"
	| "sameFormatAdapted"
	| "sameFormatFixed"
	| "converted"
	| "encoded"
	| "willTryUntouched";

export interface ResolvedRoute {
	outcome: RouteOutcome;
	outputCodec: string;
	/** The compressed format the source delivers, when it has one (`h264`, `mjpeg`). */
	inputCodec?: string;
	/** The engine's own route reason, live only. */
	reason?: string;
}

export interface RouteInput {
	outputCodec: string;
	balancer: BalancerAlgorithm | undefined;
	passthrough: VideoPassthrough | undefined;
	source: StreamSource | undefined;
	/** The engine's realized encode; present only while live. */
	activeEncode?: ActiveEncode | null;
}

export function automaticCodec(
	caps: CapabilitiesMessage | undefined,
): string | undefined {
	return caps?.encoder.default_codec;
}

export function manualCodecs(
	offered: Pick<OfferedSet, "codecs">,
): VideoCodec[] {
	return offered.codecs.flatMap((mediaType): VideoCodec[] => {
		if (mediaType === MEDIA_TYPE_H264) return ["h264"];
		if (mediaType === MEDIA_TYPE_H265) return ["h265"];
		return [];
	});
}

const CODEC_LABELS: Record<string, string> = {
	h264: "H.264",
	h265: "H.265",
	av1: "AV1",
};

export function codecLabel(codec: string): string {
	return CODEC_LABELS[codec.toLowerCase()] ?? codec.toUpperCase();
}

/**
 * The codec the device will send: the operator's pick, else the engine's named
 * default. An engine that names none (older engines, a host without a capability
 * snapshot) gets the engine's own platform rule — H.265 on a hardware encoder that
 * offers it, else H.264 — so the route line can still name a codec while the
 * format line only says "Automatic".
 */
export function expectedOutputCodec(
	manual: VideoCodec | undefined,
	caps: CapabilitiesMessage | undefined,
	platform: PlatformCaps,
): string {
	if (manual !== undefined) return manual;
	const named = automaticCodec(caps);
	if (named !== undefined) return named;
	const offered = manualCodecs(
		intersectCaps(platform, undefined, STREAMING_MODE),
	);
	return offered.includes("h265") &&
		(platform.hardware_accelerated || !offered.includes("h264"))
		? "h265"
		: "h264";
}

const INPUT_MODE_CODEC: Partial<Record<InputMode, string>> = {
	uvc_h264: "h264",
	uvc_h265: "h265",
	mjpeg: "mjpeg",
};
const KIND_CODEC: Record<string, string> = {
	uvc_h264: "h264",
	libuvch264: "h264",
	uvc_h265: "h265",
	mjpeg: "mjpeg",
};

// The compressed format a capture source hands the engine, or undefined for a raw
// one. A multi-format camera is opened in ONE format, so that format alone counts.
function sourceCodec(
	source: StreamSource | undefined,
	output: string,
): string | undefined {
	if (source?.origin !== "capture") return undefined;
	const mode = governingInputMode(source);
	if (mode !== undefined) return INPUT_MODE_CODEC[mode];
	const codecs = captureModeCodecs(source.modes);
	if (sourceOffersCodec(source.kind, output as VideoCodec, codecs))
		return output;
	return codecs[0] ?? KIND_CODEC[source.kind];
}

function withOptional(
	route: ResolvedRoute,
	inputCodec: string | undefined,
	reason?: string,
): ResolvedRoute {
	return {
		...route,
		...(inputCodec !== undefined ? { inputCodec } : {}),
		...(reason !== undefined ? { reason } : {}),
	};
}

/** First match wins. */
export function resolveRoute(input: RouteInput): ResolvedRoute {
	const fixed = input.balancer === "fixed";
	const live = input.activeEncode;
	if (live) {
		const outputCodec = live.codec;
		const reason = live.route_reason;
		if (live.passthrough === true) {
			return withOptional(
				{ outcome: "untouched", outputCodec },
				live.input_codec ?? live.codec,
				reason,
			);
		}
		if (live.input_codec === undefined)
			return withOptional(
				{ outcome: "encoded", outputCodec },
				undefined,
				reason,
			);
		const same = live.input_codec.toLowerCase() === outputCodec.toLowerCase();
		const outcome = same
			? fixed
				? "sameFormatFixed"
				: "sameFormatAdapted"
			: "converted";
		return withOptional({ outcome, outputCodec }, live.input_codec, reason);
	}

	const outputCodec = input.outputCodec;
	const inputCodec = sourceCodec(input.source, outputCodec);
	const offers = inputCodec === outputCodec;
	const route = (outcome: RouteOutcome) =>
		withOptional({ outcome, outputCodec }, inputCodec);
	// The engine refuses a forced start it cannot pass through (cerastream state.rs).
	if (input.passthrough === "force")
		return route(offers ? "untouched" : "forceUnavailable");
	if (inputCodec === undefined) return route("encoded");
	if (fixed && input.passthrough !== "off" && offers)
		return route("willTryUntouched");
	if (offers) return route(fixed ? "sameFormatFixed" : "sameFormatAdapted");
	return route("converted");
}

export function routeCopy(route: ResolvedRoute): {
	key: string;
	params: Record<string, string>;
} {
	const output = codecLabel(route.outputCodec);
	if (route.outcome === "converted") {
		return {
			key: "live.encoder.route.converted",
			params: {
				input: route.inputCodec ? codecLabel(route.inputCodec) : output,
				output,
			},
		};
	}
	return {
		key: `live.encoder.route.${route.outcome}`,
		params: { codec: output },
	};
}

/** The catalog key for a known engine reason; an unknown token renders nothing. */
export function routeReasonKey(reason: string | undefined): string | undefined {
	return reason !== undefined &&
		(ROUTE_REASONS as readonly string[]).includes(reason)
		? `live.encoder.route.reason.${reason}`
		: undefined;
}
