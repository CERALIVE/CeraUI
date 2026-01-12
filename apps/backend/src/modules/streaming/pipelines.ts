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

import { logger } from "../../helpers/logger.ts";

import { setup } from "../setup.ts";
import { TEMP_PIPELINE_PATH } from "./ceracoder.ts";
import {
	PipelineBuilder,
	type HardwareType as CeracoderHardwareType,
	type VideoSource,
	type PipelineOverrides,
	type Resolution,
	type Framerate,
} from "@ceralive/ceracoder";

// Pipeline interface
export type Pipeline = {
	source: VideoSource;
	name: string;
	hardware: CeracoderHardwareType;
	description: string;
	defaultResolution?: Resolution;
	defaultFramerate?: Framerate;
	supportsAudio: boolean;
	supportsResolutionOverride: boolean;
	supportsFramerateOverride: boolean;
};

// Valid hardware types
export const VALID_HARDWARE_TYPES = ["jetson", "n100", "rk3588", "generic"] as const;
export type HardwareType = (typeof VALID_HARDWARE_TYPES)[number];

let pipelines: Record<string, Pipeline> = {};

// Dev-only mock hardware override (defaults to null, using setup.hw)
let mockHardwareOverride: HardwareType | null = null;

/**
 * Get the effective hardware type (mock override or setup.hw)
 */
export function getEffectiveHardware(): CeracoderHardwareType {
	return (mockHardwareOverride ?? setup.hw) as CeracoderHardwareType;
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
	return true;
}

/**
 * Get current mock hardware override (null if using default)
 */
export function getMockHardware(): HardwareType | null {
	return mockHardwareOverride;
}

/**
 * Initialize pipelines from builder
 */
function getPipelines(): Record<string, Pipeline> {
	const ps: Record<string, Pipeline> = {};
	const hardware = getEffectiveHardware();
	const sources = PipelineBuilder.listSources(hardware);

	for (const sourceMeta of sources) {
		const id = sourceMeta.source;
		ps[id] = {
			source: sourceMeta.source,
			name: sourceMeta.source,
			hardware,
			description: sourceMeta.description,
			defaultResolution: sourceMeta.defaultResolution,
			defaultFramerate: sourceMeta.defaultFramerate,
			supportsAudio: sourceMeta.supportsAudio,
			supportsResolutionOverride: sourceMeta.supportsResolutionOverride,
			supportsFramerateOverride: sourceMeta.supportsFramerateOverride,
		};
	}

	return ps;
}

export function initPipelines() {
	pipelines = getPipelines();
	logger.info(
		`Initialized ${Object.keys(pipelines).length} pipeline sources for ${getEffectiveHardware()}`,
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
 * Generate a pipeline file with overrides
 */
export function generatePipelineFile(
	pipeline: Pipeline,
	overrides: PipelineOverrides,
): string {
	const result = PipelineBuilder.build({
		hardware: pipeline.hardware,
		source: pipeline.source,
		overrides,
		writeTo: TEMP_PIPELINE_PATH,
	});

	logger.debug(`Generated pipeline for ${pipeline.source} at ${result.path}`);
	return result.path!;
}
