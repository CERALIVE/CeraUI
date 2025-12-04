import type { PipelinesMessage } from "@ceraui/rpc/schemas";

import type { GroupedPipelines } from "$lib/helpers/PipelineHelper";

type Properties = {
	inputMode: string | undefined;
	encoder: string | undefined;
	resolution: string | undefined;
	framerate: string | undefined;
	pipeline: keyof PipelinesMessage | undefined;
};

export interface AutoSelectionResult {
	encoder?: string;
	resolution?: string;
	framerate?: string;
	pipeline?: keyof PipelinesMessage | undefined;
}

export function autoSelectNextOption(
	_currentLevel: string,
	properties: Properties,
	groupedPipelines: GroupedPipelines[keyof GroupedPipelines] | undefined,
): AutoSelectionResult {
	if (!groupedPipelines) return {};

	// Initialize result with all possible fields to ensure proper clearing
	const result: AutoSelectionResult = {
		encoder: properties.encoder,
		resolution: properties.resolution,
		framerate: properties.framerate,
		pipeline: properties.pipeline,
	};

	// Step 1: Validate/fix inputMode level
	if (!properties.inputMode) {
		return {
			encoder: undefined,
			resolution: undefined,
			framerate: undefined,
			pipeline: undefined,
		};
	}

	// Step 2: Investigate encoder level
	const availableEncoders = Object.keys(
		groupedPipelines[properties.inputMode] || {},
	);

	if (properties.encoder && !availableEncoders.includes(properties.encoder)) {
		result.encoder = undefined;
		result.resolution = undefined;
		result.framerate = undefined;
		result.pipeline = undefined;
	}

	// Auto-select encoder if needed
	if (!result.encoder && availableEncoders.length === 1) {
		result.encoder = availableEncoders[0];
	} else if (!result.encoder && availableEncoders.length === 0) {
		return {
			encoder: undefined,
			resolution: undefined,
			framerate: undefined,
			pipeline: undefined,
		};
	}

	// If no encoder selected and multiple options, ensure dependents are cleared
	if (!result.encoder) {
		result.resolution = undefined;
		result.framerate = undefined;
		result.pipeline = undefined;
		return result;
	}

	// Step 3: Investigate resolution level
	const availableResolutions = Object.keys(
		groupedPipelines[properties.inputMode][result.encoder] || {},
	);

	if (result.resolution && !availableResolutions.includes(result.resolution)) {
		result.resolution = undefined;
		result.framerate = undefined;
		result.pipeline = undefined;
	}

	// Auto-select resolution if needed
	if (!result.resolution && availableResolutions.length === 1) {
		result.resolution = availableResolutions[0];
	} else if (!result.resolution && availableResolutions.length === 0) {
		result.resolution = undefined;
		result.framerate = undefined;
		result.pipeline = undefined;
		return result;
	}

	// If no resolution selected and multiple options, ensure dependents are cleared
	if (!result.resolution) {
		result.framerate = undefined;
		result.pipeline = undefined;
		return result;
	}

	// Step 4: Investigate framerate level
	const availableFramerates =
		groupedPipelines[properties.inputMode][result.encoder][result.resolution];

	if (result.framerate) {
		const frameratExists = availableFramerates?.some(
			(p) => p.extraction.fps === result.framerate,
		);
		if (!frameratExists) {
			result.framerate = undefined;
			result.pipeline = undefined;
		}
	}

	// Auto-select framerate if needed
	if (!result.framerate && availableFramerates?.length === 1) {
		const fps = availableFramerates[0].extraction.fps ?? undefined;
		result.framerate = fps;
	} else if (
		!result.framerate &&
		(!availableFramerates || availableFramerates.length === 0)
	) {
		result.framerate = undefined;
		result.pipeline = undefined;
		return result;
	}

	// If no framerate selected and multiple options, ensure pipeline is cleared
	if (!result.framerate) {
		result.pipeline = undefined;
		return result;
	}

	// Step 5: Build pipeline if all fields are valid
	if (result.encoder && result.resolution && result.framerate) {
		const foundPipeline = availableFramerates?.find(
			(p) => p.extraction.fps === result.framerate,
		)?.identifier;
		if (foundPipeline) {
			result.pipeline = foundPipeline;
		} else {
			result.pipeline = undefined;
		}
	}

	return result;
}

// resetDependentSelections function removed - all logic now unified in autoSelectNextOption
