import type { Pipelines } from "@ceraui/rpc/schemas";

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
	// Basic device extraction (everything before /)
	const deviceMatch = name.match(/^([^/]+)/);

	// Extract encoder: h264, h265, x264, x265 (belacoder uses x264/x265 naming)
	// Normalize x264->h264, x265->h265 for consistency in UI grouping
	const encoderMatch = name.match(/(h264|h265|x264|x265)/i);
	let encoder: string | null = null;
	if (encoderMatch) {
		const raw = encoderMatch[0].toLowerCase();
		// Normalize x264/x265 to h264/h265 for consistent grouping
		encoder = raw === "x264" ? "h264" : raw === "x265" ? "h265" : raw;
	}

	// Format extraction - comes after encoder prefix
	// Patterns: h264_raw_*, x264_superfast_v4l_mjpeg_*, h265_rtmp_*
	const formatMatch = name.match(/(?:h264|h265|x264|x265)_([^_]+)/i);

	// Extract resolution - formats: NNNp, NNNNp (720p, 1080p, 2160p), or 4k_2160p pattern
	const resolutionMatch = name.match(/(\d{3,4}p)/);

	// Extract framerate - multiple patterns:
	// 1. pNN (1080p30) - captures after 'p' if followed by digits
	// 2. _NNfps (like _30fps, _60fps)
	// 3. Decimal fps (29.97, 59.94)
	// Pattern must match fps after resolution or standalone _NNfps
	const fpsMatch = name.match(
		/(?:\d{3,4}p)(\d+(?:\.\d+)?)|_(\d+(?:\.\d+)?)fps/,
	);

	// Special case for libuvch264
	const isLibUVC = name.includes("libuvch264");

	// Use translations if provided, fallback to English defaults
	const defaultResolution =
		translations?.matchDeviceResolution || "[Match device resolution]";
	const defaultOutput =
		translations?.matchDeviceOutput || "[Match device output]";

	return {
		device: deviceMatch ? deviceMatch[0] : null,
		encoder,
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
	pipelines: Pipelines,
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
