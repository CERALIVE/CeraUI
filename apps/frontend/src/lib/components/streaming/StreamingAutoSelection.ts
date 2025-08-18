import type { GroupedPipelines } from '$lib/helpers/PipelineHelper';

type Properties = {
  inputMode: string | undefined;
  encoder: string | undefined;
  resolution: string | undefined;
  framerate: string | undefined;
};

export interface AutoSelectionResult {
  encoder?: string;
  resolution?: string;
  framerate?: string;
}

export function autoSelectNextOption(
  currentLevel: string,
  properties: Properties,
  groupedPipelines: GroupedPipelines[keyof GroupedPipelines] | undefined,
): AutoSelectionResult {
  if (!groupedPipelines) return {};

  const result: AutoSelectionResult = {};

  switch (currentLevel) {
    case 'inputMode':
      if (properties.inputMode) {
        // If there's only one encoding format option, auto-select it
        const encoders = Object.keys(groupedPipelines[properties.inputMode]);
        if (encoders.length === 1) {
          result.encoder = encoders[0];
          // Continue chain to next level
          const nextResult = autoSelectNextOption('encoder', { ...properties, encoder: encoders[0] }, groupedPipelines);
          return { ...result, ...nextResult };
        }
      }
      break;

    case 'encoder':
      if (properties.inputMode && properties.encoder) {
        // If there's only one resolution option, auto-select it
        const resolutions = Object.keys(groupedPipelines[properties.inputMode][properties.encoder]);
        if (resolutions.length === 1) {
          result.resolution = resolutions[0];
          // Continue chain to next level
          const nextResult = autoSelectNextOption(
            'resolution',
            { ...properties, resolution: resolutions[0] },
            groupedPipelines,
          );
          return { ...result, ...nextResult };
        }
      }
      break;

    case 'resolution':
      if (properties.inputMode && properties.encoder && properties.resolution) {
        // If there's only one framerate option, auto-select it
        const framerates = groupedPipelines[properties.inputMode][properties.encoder][properties.resolution];
        if (framerates.length === 1) {
          result.framerate = framerates[0].extraction.fps ?? undefined;
        }
      }
      break;
  }

  return result;
}

export function resetDependentSelections(level: string): Partial<Properties> {
  const resetValues: Partial<Properties> = {};

  switch (level) {
    case 'inputMode':
      resetValues.encoder = undefined;
      resetValues.resolution = undefined;
      resetValues.framerate = undefined;
      break;
    case 'encoder':
      resetValues.resolution = undefined;
      resetValues.framerate = undefined;
      break;
    case 'resolution':
      resetValues.framerate = undefined;
      break;
  }

  return resetValues;
}
