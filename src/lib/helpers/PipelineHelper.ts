import type { PipelinesMessage } from '$lib/types/socket-messages';

export type PipelineInfo = {
  device: string | null;
  encoder: string | null;
  format: string | null;
  resolution: string | null;
  fps: number | string;
};

type HumanReadablePipeline = {
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

export function parsePipelineName(name: string): PipelineInfo {
  // Basic device extraction
  const deviceMatch = name.match(/^([^/]+)/);
  
  // Extract encoder (h264 or h265)
  const encoderMatch = name.match(/(h264|h265)/);
  
  // Format extraction - comes after h264/h265_ prefix
  const formatMatch = name.match(/(?:h264|h265)_([^_]+)/);
  
  // Extract resolution - typically NNNp format (like 720p, 1080p)
  const resolutionMatch = name.match(/(\d{3,4}p)/);
  
  // Extract framerate - typically pNN format (like p30, p60)
  // Handle both underscore separated and inline formats
  const fpsMatch = name.match(/p(\d+(?:\.\d+)?)/);
  
  // Special case for libuvch264
  const isLibUVC = name.includes('libuvch264');
  
  return {
    device: deviceMatch ? deviceMatch[0] : null,
    encoder: encoderMatch ? encoderMatch[0] : null,
    format: formatMatch 
      ? (isLibUVC ? 'usb-libuvch264' : formatMatch[1].replace(/_/g, ' ')) 
      : null,
    resolution: resolutionMatch ? resolutionMatch[0] : '[Match device resolution]',
    fps: fpsMatch ? parseFloat(fpsMatch[1]) : '[Match device output]',
  };
}

export const groupPipelinesByDeviceAndFormat = (pipelines: PipelinesMessage): GroupedPipelines => {
  const groupedPipelines: GroupedPipelines = {};

  Object.entries(pipelines).forEach(([key, value]) => {
    const extraction = parsePipelineName(value.name);
    const device = extraction.device || 'unknown';
    const format = extraction.format || 'unknown';
    const encoder = extraction.encoder || 'unknown';
    const resolution = extraction.resolution || 'unknown';

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