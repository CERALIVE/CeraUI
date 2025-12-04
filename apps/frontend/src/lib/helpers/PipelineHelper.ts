import type { PipelinesMessage } from "@ceraui/rpc/schemas";

export type PipelineInfo = {
	device: string | null;
	encoder: string | null;
	format: string | null;
	resolution: string | null;
	fps: string | null;
};

export type HumanReadablePipeline = {
	name: string;
	asrc: boolean;
	acodec: boolean;
	identifier: string;
	extraction: PipelineInfo;
};

export type GroupedPipelines = {
	[device: string]: {
		[format: string]: {
			[encoder: string]: {
				[resolution: string]: HumanReadablePipeline[];
			};
		};
	};
};

export function parsePipelineName(
	name: string,
	translations?: {
		matchDeviceResolution: string;
		matchDeviceOutput: string;
	},
): PipelineInfo {
	// Basic device extraction
	const deviceMatch = name.match(/^([^/]+)/);

	// Extract encoder (h264 or h265)
	const encoderMatch = name.match(/(h264|h265)/);

	// Format extraction - comes after h264/h265_ prefix
	const formatMatch = name.match(/(?:h264|h265)_([^_]+)/);

	// Extract resolution - typically NNNp format (like 720p, 1080p)
	const resolutionMatch = name.match(/(\d{3,4}p)/);

	// Extract framerate - typically pNN format (like p30, p60) or _NNfps (like _30fps, _60fps)
	const fpsMatch = name.match(/p(\d+(?:\.\d+)?)|_(\d+(?:\.\d+)?)fps/);
	// Special case for libuvch264
	const isLibUVC = name.includes("libuvch264");

	// Use translations if provided, fallback to English defaults
	const defaultResolution =
		translations?.matchDeviceResolution || "[Match device resolution]";
	const defaultOutput =
		translations?.matchDeviceOutput || "[Match device output]";

	return {
		device: deviceMatch ? deviceMatch[0] : null,
		encoder: encoderMatch ? encoderMatch[0] : null,
		format: formatMatch
			? isLibUVC
				? "usb-libuvch264"
				: formatMatch[1].replace(/_/g, " ")
			: null,
		resolution: resolutionMatch ? resolutionMatch[0] : defaultResolution,
		fps: fpsMatch ? fpsMatch[1] || fpsMatch[2] : defaultOutput,
	};
}

export const groupPipelinesByDeviceAndFormat = (
	pipelines: PipelinesMessage,
	translations?: {
		matchDeviceResolution: string;
		matchDeviceOutput: string;
	},
): GroupedPipelines => {
	const groupedPipelines: GroupedPipelines = {};

	Object.entries(pipelines).forEach(([key, value]) => {
		const extraction = parsePipelineName(value.name, translations);
		const device = extraction.device || "unknown";
		const format = extraction.format || "unknown";
		const encoder = extraction.encoder || "unknown";
		const resolution = extraction.resolution || "unknown";

		if (!groupedPipelines[device]) {
			groupedPipelines[device] = {};
		}

		if (!groupedPipelines[device][format]) {
			groupedPipelines[device][format] = {};
		}

		if (!groupedPipelines[device][format][encoder]) {
			groupedPipelines[device][format][encoder] = {};
		}

		if (!groupedPipelines[device][format][encoder][resolution]) {
			groupedPipelines[device][format][encoder][resolution] = [];
		}

		groupedPipelines[device][format][encoder][resolution].push({
			...value,
			identifier: key,
			extraction,
		});
	});

	return groupedPipelines;
};
