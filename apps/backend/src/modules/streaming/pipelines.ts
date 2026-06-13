/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project


    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { SCHEMA_VERSION, type GetCapabilitiesResult } from "@ceralive/cerastream";
import { BITRATE_MAX, BITRATE_MIN } from "@ceraui/rpc/schemas";
import {
	framerateSchema,
	resolutionSchema,
} from "../../helpers/config-schemas.ts";
import { logger } from "../../helpers/logger.ts";
import { setup } from "../setup.ts";
import {
	type CapabilitiesServiceDeps,
	type EngineCapabilitiesSnapshot,
	getCapabilities,
} from "./capabilities.ts";
import {
	type Framerate,
	listPipelineSources,
	type PipelineHardwareType,
	type Resolution,
	type VideoSource,
} from "./pipeline-sources.ts";

// Pipeline interface
export type Pipeline = {
	source: VideoSource;
	name: string;
	hardware: PipelineHardwareType;
	description: string;
	defaultResolution?: Resolution;
	defaultFramerate?: Framerate;
	supportsAudio: boolean;
	supportsResolutionOverride: boolean;
	supportsFramerateOverride: boolean;
};

// Valid hardware types
export const VALID_HARDWARE_TYPES = [
	"jetson",
	"n100",
	"rk3588",
	"generic",
] as const;
export type HardwareType = (typeof VALID_HARDWARE_TYPES)[number];

let pipelines: Record<string, Pipeline> = {};

// Dev-only mock hardware override (defaults to null, using setup.hw)
let mockHardwareOverride: HardwareType | null = null;

/**
 * Get the effective hardware type (mock override or setup.hw)
 */
export function getEffectiveHardware(): PipelineHardwareType {
	return (mockHardwareOverride ?? setup.hw) as PipelineHardwareType;
}

/**
 * Set mock hardware override (dev-only)
 * Returns true if valid, false if invalid
 */
export function setMockHardware(hw: string): boolean {
	if (!VALID_HARDWARE_TYPES.includes(hw as HardwareType)) {
		logger.warn(`Invalid mock hardware type: ${hw}`);
		return false;
	}
	mockHardwareOverride = hw as HardwareType;
	logger.info(`🔧 Mock hardware set to: ${hw}`);
	// Callers rebuild the registry via `await initPipelines()` — kept out of this
	// setter so it stays synchronous now that initPipelines is async.
	return true;
}

/**
 * Get current mock hardware override (null if using default)
 */
export function getMockHardware(): HardwareType | null {
	return mockHardwareOverride;
}

// Decklink (Blackmagic SDI) has no cerastream pipeline, so it is absent from the
// capability contract on every board.
const UNSUPPORTED_SOURCES: ReadonlySet<string> = new Set<VideoSource>([
	"decklink",
]);

// Source descriptions are a UI label, not part of the engine capability contract,
// so CeraUI owns them here — the single source once pipeline-sources.ts is deleted
// (T29). usb_mjpeg and v4l_mjpeg are kept as DISTINCT ids even though both map to
// the engine's single Mjpeg input kind.
const SOURCE_DESCRIPTIONS: Record<string, string> = {
	camlink: "Elgato Cam Link 4K",
	libuvch264: "UVC H264 camera (hardware compressed)",
	hdmi: "HDMI capture",
	usb_mjpeg: "USB MJPEG capture card",
	v4l_mjpeg: "V4L2 MJPEG capture card",
	rtmp: "RTMP ingest from local server",
	srt: "SRT ingest",
	test: "Test pattern (no capture device required)",
};

function describeSource(id: string): string {
	return SOURCE_DESCRIPTIONS[id] ?? id;
}

// The capability contract types resolution/framerate as free-form string/number;
// only adopt the (enum-typed) Pipeline default when the value is a member of the
// frozen preset set, so the engine's minimal-floor "1920x1080" is dropped rather
// than forced into the enum.
function toResolution(value: string): Resolution | undefined {
	const parsed = resolutionSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

function toFramerate(value: number): Framerate | undefined {
	const parsed = framerateSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

// Bridge until cerastream exposes the get-capabilities IPC method: derive the
// capability contract from the per-board source tables (parity target; deleted
// T29), dropping unsupported sources. Passed to getCapabilities() as the live
// fetcher so the registry builds from the T14 contract shape, not the tables
// directly. platform/encoder are required by the contract but unused by the
// registry build (only `sources` is), so they carry placeholders.
function deriveCapabilitiesFromSourceTables(
	hardware: PipelineHardwareType,
): GetCapabilitiesResult {
	const sources = listPipelineSources(hardware)
		.filter((meta) => !UNSUPPORTED_SOURCES.has(meta.source))
		.map((meta) => ({
			id: meta.source,
			supports_audio: meta.supportsAudio,
			supports_resolution_override: meta.supportsResolutionOverride,
			supports_framerate_override: meta.supportsFramerateOverride,
			default_resolution: meta.defaultResolution ?? "1080p",
			default_framerate: meta.defaultFramerate ?? 30,
		}));

	return {
		platform: {
			supports_h265: true,
			hardware_accelerated: hardware !== "generic",
			max_resolution: "1080p",
		},
		encoder: {
			codecs: ["h264", "h265"],
			bitrate_range: { min: BITRATE_MIN, max: BITRATE_MAX, unit: "kbps" },
		},
		sources,
	};
}

function fetchParityCapabilities(
	hardware: PipelineHardwareType,
): Promise<EngineCapabilitiesSnapshot> {
	return Promise.resolve({
		caps: deriveCapabilitiesFromSourceTables(hardware),
		schemaVersion: SCHEMA_VERSION,
	});
}

function buildPipelineRegistry(
	sources: GetCapabilitiesResult["sources"],
	hardware: PipelineHardwareType,
): Record<string, Pipeline> {
	const ps: Record<string, Pipeline> = {};
	for (const cap of sources) {
		const pipeline: Pipeline = {
			source: cap.id as VideoSource,
			name: cap.id,
			hardware,
			description: describeSource(cap.id),
			supportsAudio: cap.supports_audio,
			supportsResolutionOverride: cap.supports_resolution_override,
			supportsFramerateOverride: cap.supports_framerate_override,
		};
		const resolution = toResolution(cap.default_resolution);
		if (resolution !== undefined) pipeline.defaultResolution = resolution;
		const framerate = toFramerate(cap.default_framerate);
		if (framerate !== undefined) pipeline.defaultFramerate = framerate;
		ps[cap.id] = pipeline;
	}
	return ps;
}

export async function initPipelines(
	overrides: Partial<CapabilitiesServiceDeps> = {},
): Promise<void> {
	const hardware = getEffectiveHardware();
	const capabilities = await getCapabilities({
		fetchEngineCapabilities: () => fetchParityCapabilities(hardware),
		...overrides,
	});
	pipelines = buildPipelineRegistry(capabilities.sources, hardware);
	logger.info(
		`Initialized ${Object.keys(pipelines).length} pipeline sources for ${hardware}`,
	);
}

export function searchPipelines(id: string): Pipeline | null {
	if (pipelines[id]) return pipelines[id];
	return null;
}

// Pipeline list in the format needed by the frontend
type PipelineResponseEntry = Pick<
	Pipeline,
	| "name"
	| "description"
	| "supportsAudio"
	| "supportsResolutionOverride"
	| "supportsFramerateOverride"
	| "defaultResolution"
	| "defaultFramerate"
>;

export function getPipelineList() {
	const list: Record<string, PipelineResponseEntry> = {};
	for (const id in pipelines) {
		const pipeline = pipelines[id];
		if (!pipeline) continue;

		list[id] = {
			name: pipeline.name,
			description: pipeline.description,
			supportsAudio: pipeline.supportsAudio,
			supportsResolutionOverride: pipeline.supportsResolutionOverride,
			supportsFramerateOverride: pipeline.supportsFramerateOverride,
			defaultResolution: pipeline.defaultResolution,
			defaultFramerate: pipeline.defaultFramerate,
		};
	}
	return list;
}

/**
 * Get pipelines message with hardware info (for WebSocket broadcast)
 */
export function getPipelinesMessage() {
	return {
		hardware: getEffectiveHardware(),
		pipelines: getPipelineList(),
	};
}

/**
 * Rejects overrides the selected pipeline cannot honor, so an invalid override
 * never reaches the engine.
 *
 * Throws a typed error with the offending field name for RPC rejection.
 */
export class PipelineOverrideError extends Error {
	constructor(
		public readonly field: "resolution" | "framerate",
		message: string,
	) {
		super(message);
		this.name = "PipelineOverrideError";
	}
}

export function validatePipelineOverrides(
	pipeline: Pick<
		Pipeline,
		"supportsResolutionOverride" | "supportsFramerateOverride"
	>,
	source: { resolution?: Resolution; framerate?: Framerate },
): void {
	if (source.resolution !== undefined && !pipeline.supportsResolutionOverride) {
		throw new PipelineOverrideError(
			"resolution",
			"Pipeline does not support resolution override",
		);
	}
	if (source.framerate !== undefined && !pipeline.supportsFramerateOverride) {
		throw new PipelineOverrideError(
			"framerate",
			"Pipeline does not support framerate override",
		);
	}
}
