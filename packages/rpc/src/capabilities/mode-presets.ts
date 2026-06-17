/**
 * Shared mode-preset catalog.
 *
 * Canonical preset definitions for common streaming configurations.
 * Each preset is a named combination of resolution, framerate, and codec
 * that can be offered to the user as a quick-select option.
 *
 * All enum values (resolution, framerate, codec) reference existing schemas
 * from `streaming.schema.ts` — no raw literals.
 */

import { type Framerate, type Resolution } from '../schemas/streaming.schema';
import { MEDIA_TYPE_H264, MEDIA_TYPE_H265, type OfferedSet } from './intersect-caps';

/**
 * A single mode preset: a named combination of resolution, framerate, and codec.
 */
export interface ModePreset {
	/** Unique preset identifier (e.g., "1080p60-h264") */
	id: string;

	/** i18n key for the preset label (e.g., "presets.1080p60h264") */
	labelKey: string;

	/** Resolution from resolutionSchema */
	resolution: Resolution;

	/** Framerate from framerateSchema */
	framerate: Framerate;

	/** Codec: MEDIA_TYPE_H264 or MEDIA_TYPE_H265 */
	codec: string;

	/** Optional default bitrate in kbps */
	bitrateDefault?: number;
}

/**
 * Canonical preset catalog.
 *
 * Five presets covering common streaming scenarios:
 * - 1080p60-h264: Full HD, 60fps, universal H.264 codec
 * - 1080p30-h264: Full HD, 30fps, universal H.264 codec
 * - 4k30-h265: 4K, 30fps, modern H.265 codec (requires hardware support)
 * - 720p60-h264: HD, 60fps, universal H.264 codec
 * - 1080p30-h265: Full HD, 30fps, modern H.265 codec (requires hardware support)
 */
export const CANONICAL_PRESETS: Record<string, ModePreset> = {
	'1080p60-h264': {
		id: '1080p60-h264',
		labelKey: 'presets.1080p60h264',
		resolution: '1080p',
		framerate: 60,
		codec: MEDIA_TYPE_H264,
		bitrateDefault: 6000,
	},
	'1080p30-h264': {
		id: '1080p30-h264',
		labelKey: 'presets.1080p30h264',
		resolution: '1080p',
		framerate: 30,
		codec: MEDIA_TYPE_H264,
		bitrateDefault: 4000,
	},
	'4k30-h265': {
		id: '4k30-h265',
		labelKey: 'presets.4k30h265',
		resolution: '2160p',
		framerate: 30,
		codec: MEDIA_TYPE_H265,
		bitrateDefault: 8000,
	},
	'720p60-h264': {
		id: '720p60-h264',
		labelKey: 'presets.720p60h264',
		resolution: '720p',
		framerate: 60,
		codec: MEDIA_TYPE_H264,
		bitrateDefault: 4000,
	},
	'1080p30-h265': {
		id: '1080p30-h265',
		labelKey: 'presets.1080p30h265',
		resolution: '1080p',
		framerate: 30,
		codec: MEDIA_TYPE_H265,
		bitrateDefault: 3000,
	},
};

/**
 * Check if a preset's resolution, framerate, and codec are all offered.
 *
 * Pure function — no side effects, no I/O.
 *
 * @param preset The preset to check
 * @param offered The effective capability set from intersectCaps
 * @returns true if all three (resolution, framerate, codec) are in the offered set
 */
export function presetMatchesOffered(preset: ModePreset, offered: OfferedSet): boolean {
	const resolutionOffered = offered.resolutions.includes(preset.resolution);
	const framerateOffered = offered.framerates.includes(preset.framerate);
	const codecOffered = offered.codecs.includes(preset.codec);

	return resolutionOffered && framerateOffered && codecOffered;
}
