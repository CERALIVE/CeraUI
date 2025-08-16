import type { HumanReadablePipeline } from '$lib/helpers/PipelineHelper';
import { updateBitrate } from '$lib/helpers/SystemHelper';

export function normalizeValue(value: number, min: number, max: number, step = 1): number {
  const stepped = Math.round((value - min) / step) * step + min;
  return Math.max(min, Math.min(max, stepped));
}

export function updateMaxBitrate(bitrate: number | undefined, isStreaming: boolean | undefined): void {
  if (isStreaming && bitrate) {
    updateBitrate(bitrate);
  }
}

export function getSortedFramerates(framerates: HumanReadablePipeline[]): HumanReadablePipeline[] {
  return [...framerates].sort((a, b) => {
    // Put "match device output" or similar special options first
    const fpsA = a.extraction.fps;
    const fpsB = b.extraction.fps;

    if (typeof fpsA === 'string' && fpsA.toLowerCase().includes('match')) return -1;
    if (typeof fpsB === 'string' && fpsB.toLowerCase().includes('match')) return 1;

    // Convert to numbers for numeric comparison
    const numA = parseFloat(String(fpsA)) || 0;
    const numB = parseFloat(String(fpsB)) || 0;

    // Sort by numeric value
    return numA - numB;
  });
}

export function getSortedResolutions(resolutions: string[]): string[] {
  return [...resolutions].sort((a, b) => {
    // Put "match device resolution" or similar special options first
    if (a.toLowerCase().includes('match') || a.toLowerCase().includes('device')) return -1;
    if (b.toLowerCase().includes('match') || b.toLowerCase().includes('device')) return 1;

    // Extract numeric values (like "720" from "720p")
    const numA = parseInt(a.match(/\d+/)?.[0] || '0', 10);
    const numB = parseInt(b.match(/\d+/)?.[0] || '0', 10);

    // Sort by numeric value
    return numA - numB;
  });
}
