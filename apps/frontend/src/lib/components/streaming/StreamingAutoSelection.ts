import type { GroupedPipelines } from "$lib/helpers/PipelineHelper";
import type { PipelinesMessage } from '../../types/socket-messages';

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
	currentLevel: string,
	properties: Properties,
	groupedPipelines: GroupedPipelines[keyof GroupedPipelines] | undefined,
): AutoSelectionResult {
	if (!groupedPipelines) return {};

	console.log(`🔬 PROFOUND INVESTIGATION starting from ${currentLevel}:`, {
		inputMode: properties.inputMode,
		encoder: properties.encoder,
		resolution: properties.resolution,
		framerate: properties.framerate,
	});

	// Initialize result with all possible fields to ensure proper clearing
	const result: AutoSelectionResult = {
		encoder: properties.encoder,
		resolution: properties.resolution,
		framerate: properties.framerate,
		pipeline: properties.pipeline,
	};

	// Step 1: Validate/fix inputMode level
	if (!properties.inputMode) {
		console.log("⚠️ No inputMode - cannot proceed");
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
	console.log(
		`🔍 Available encoders for ${properties.inputMode}:`,
		availableEncoders,
	);

	if (properties.encoder && !availableEncoders.includes(properties.encoder)) {
		console.log(
			`❌ Encoder '${properties.encoder}' invalid for inputMode, clearing all dependents`,
		);
		result.encoder = undefined;
		result.resolution = undefined;
		result.framerate = undefined;
		result.pipeline = undefined;
		console.log("🧹 FORCED CLEARING - All dependent fields set to undefined");
	}

	// Auto-select encoder if needed
	if (!result.encoder && availableEncoders.length === 1) {
		console.log(`🎯 Auto-selecting single encoder: ${availableEncoders[0]}`);
		result.encoder = availableEncoders[0];
	} else if (!result.encoder && availableEncoders.length === 0) {
		console.log("⚠️ No encoders available - stopping investigation");
		return {
			encoder: undefined,
			resolution: undefined,
			framerate: undefined,
			pipeline: undefined,
		};
	}

	// If no encoder selected and multiple options, ensure dependents are cleared
	if (!result.encoder) {
		console.log(
			"⏸️ Multiple encoder options - user must choose, clearing dependents",
		);
		result.resolution = undefined;
		result.framerate = undefined;
		result.pipeline = undefined;
		console.log(
			"🧹 DEPENDENT CLEARING - resolution, framerate, pipeline set to undefined",
		);
		return result;
	}

	// Step 3: Investigate resolution level
	const availableResolutions = Object.keys(
		groupedPipelines[properties.inputMode][result.encoder] || {},
	);
	console.log(
		`🔍 Available resolutions for ${properties.inputMode}/${result.encoder}:`,
		availableResolutions,
	);

	if (result.resolution && !availableResolutions.includes(result.resolution)) {
		console.log(
			`❌ Resolution '${result.resolution}' invalid for encoder, clearing dependents`,
		);
		result.resolution = undefined;
		result.framerate = undefined;
		result.pipeline = undefined;
		console.log("🧹 FORCED CLEARING - resolution dependents set to undefined");
	}

	// Auto-select resolution if needed
	if (!result.resolution && availableResolutions.length === 1) {
		console.log(
			`🎯 Auto-selecting single resolution: ${availableResolutions[0]}`,
		);
		result.resolution = availableResolutions[0];
	} else if (!result.resolution && availableResolutions.length === 0) {
		console.log("⚠️ No resolutions available - stopping investigation");
		result.resolution = undefined;
		result.framerate = undefined;
		result.pipeline = undefined;
		console.log(
			"🧹 NO OPTIONS CLEARING - resolution dependents set to undefined",
		);
		return result;
	}

	// If no resolution selected and multiple options, ensure dependents are cleared
	if (!result.resolution) {
		console.log(
			"⏸️ Multiple resolution options - user must choose, clearing dependents",
		);
		result.framerate = undefined;
		result.pipeline = undefined;
		console.log("🧹 DEPENDENT CLEARING - framerate, pipeline set to undefined");
		return result;
	}

	// Step 4: Investigate framerate level
	const availableFramerates =
		groupedPipelines[properties.inputMode][result.encoder][result.resolution];
	console.log(
		`🔍 Available framerates for ${properties.inputMode}/${result.encoder}/${result.resolution}:`,
		availableFramerates?.map((p) => p.extraction.fps),
	);

	if (result.framerate) {
		const frameratExists = availableFramerates?.some(
			(p) => p.extraction.fps === result.framerate,
		);
		if (!frameratExists) {
			console.log(
				`❌ Framerate '${result.framerate}' invalid for resolution, clearing`,
			);
			result.framerate = undefined;
			result.pipeline = undefined;
			console.log(
				"🧹 FORCED CLEARING - framerate and pipeline set to undefined",
			);
		}
	}

	// Auto-select framerate if needed
	if (!result.framerate && availableFramerates?.length === 1) {
		const fps = availableFramerates[0].extraction.fps ?? undefined;
		console.log(`🎯 Auto-selecting single framerate: ${fps}`);
		result.framerate = fps;
	} else if (
		!result.framerate &&
		(!availableFramerates || availableFramerates.length === 0)
	) {
		console.log("⚠️ No framerates available - stopping investigation");
		result.framerate = undefined;
		result.pipeline = undefined;
		console.log(
			"🧹 NO OPTIONS CLEARING - framerate and pipeline set to undefined",
		);
		return result;
	}

	// If no framerate selected and multiple options, ensure pipeline is cleared
	if (!result.framerate) {
		console.log(
			"⏸️ Multiple framerate options - user must choose, clearing pipeline",
		);
		result.pipeline = undefined;
		console.log("🧹 DEPENDENT CLEARING - pipeline set to undefined");
		return result;
	}

	// Step 5: Build pipeline if all fields are valid
	if (result.encoder && result.resolution && result.framerate) {
		const foundPipeline = availableFramerates?.find(
			(p) => p.extraction.fps === result.framerate,
		)?.identifier;
		if (foundPipeline) {
			console.log(`🏗️ PIPELINE BUILT: ${foundPipeline}`);
			result.pipeline = foundPipeline;
		} else {
			console.log("⚠️ Could not build pipeline - no matching combination found");
			result.pipeline = undefined;
			console.log("🧹 BUILD FAILED CLEARING - pipeline set to undefined");
		}
	}

	console.log("🎯 PROFOUND INVESTIGATION COMPLETE:", result);
	return result;
}

// resetDependentSelections function removed - all logic now unified in autoSelectNextOption
