/**
 * Mode preset catalog tests.
 *
 * TDD: locks the preset definitions, enum membership, and the
 * presetMatchesOffered helper.
 */
import { describe, expect, it } from 'bun:test';
import { MEDIA_TYPE_H264, MEDIA_TYPE_H265, type OfferedSet } from './intersect-caps';
import { CANONICAL_PRESETS, presetMatchesOffered } from './mode-presets';

describe('mode-presets', () => {
	describe('canonical presets', () => {
		it('defines exactly 5 canonical presets', () => {
			expect(Object.keys(CANONICAL_PRESETS)).toHaveLength(5);
		});

		it('includes 1080p60-h264', () => {
			expect(CANONICAL_PRESETS['1080p60-h264']).toBeDefined();
		});

		it('includes 1080p30-h264', () => {
			expect(CANONICAL_PRESETS['1080p30-h264']).toBeDefined();
		});

		it('includes 4k30-h265', () => {
			expect(CANONICAL_PRESETS['4k30-h265']).toBeDefined();
		});

		it('includes 720p60-h264', () => {
			expect(CANONICAL_PRESETS['720p60-h264']).toBeDefined();
		});

		it('includes 1080p30-h265', () => {
			expect(CANONICAL_PRESETS['1080p30-h265']).toBeDefined();
		});
	});

	describe('preset shape', () => {
		it('has id, labelKey, resolution, framerate, codec, and optional bitrateDefault', () => {
			const preset = CANONICAL_PRESETS['1080p60-h264'];

			expect(preset).toHaveProperty('id');
			expect(preset).toHaveProperty('labelKey');
			expect(preset).toHaveProperty('resolution');
			expect(preset).toHaveProperty('framerate');
			expect(preset).toHaveProperty('codec');
			expect(typeof preset.id).toBe('string');
			expect(typeof preset.labelKey).toBe('string');
			expect(typeof preset.resolution).toBe('string');
			expect(typeof preset.framerate).toBe('number');
			expect(typeof preset.codec).toBe('string');
		});

		it('has bitrateDefault as optional number', () => {
			const preset = CANONICAL_PRESETS['1080p60-h264'];
			if (preset.bitrateDefault !== undefined) {
				expect(typeof preset.bitrateDefault).toBe('number');
			}
		});
	});

	describe('enum membership', () => {
		it('all presets use valid resolutions from resolutionSchema', () => {
			const validResolutions = ['480p', '720p', '1080p', '1440p', '2160p', '4k'];

			for (const preset of Object.values(CANONICAL_PRESETS)) {
				expect(validResolutions).toContain(preset.resolution);
			}
		});

		it('all presets use valid framerates from framerateSchema', () => {
			const validFramerates = [25, 29.97, 30, 50, 59.94, 60];

			for (const preset of Object.values(CANONICAL_PRESETS)) {
				expect(validFramerates).toContain(preset.framerate);
			}
		});

		it('all presets use valid codecs (h264 or h265)', () => {
			const validCodecs = [MEDIA_TYPE_H264, MEDIA_TYPE_H265];

			for (const preset of Object.values(CANONICAL_PRESETS)) {
				expect(validCodecs).toContain(preset.codec);
			}
		});

		it('preset ids match their keys in CANONICAL_PRESETS', () => {
			for (const [key, preset] of Object.entries(CANONICAL_PRESETS)) {
				expect(preset.id).toBe(key);
			}
		});
	});

	describe('presetMatchesOffered', () => {
		const offeredH264_1080p60: OfferedSet = {
			resolutions: ['480p', '720p', '1080p'],
			framerates: [25, 30, 50, 60],
			codecs: [MEDIA_TYPE_H264],
			bitrateRange: { min: 500, max: 50000, unit: 'kbps' },
			supportsAudio: true,
			supportsResolutionOverride: true,
			supportsFramerateOverride: true,
		};

		const offeredH265_4k30: OfferedSet = {
			resolutions: ['480p', '720p', '1080p', '1440p', '2160p'],
			framerates: [25, 30, 50, 60],
			codecs: [MEDIA_TYPE_H264, MEDIA_TYPE_H265],
			bitrateRange: { min: 500, max: 50000, unit: 'kbps' },
			supportsAudio: true,
			supportsResolutionOverride: true,
			supportsFramerateOverride: true,
		};

		it('returns true when preset resolution, framerate, and codec are all in offered set', () => {
			const preset = CANONICAL_PRESETS['1080p60-h264'];
			expect(presetMatchesOffered(preset, offeredH264_1080p60)).toBe(true);
		});

		it('returns false when preset resolution is not offered', () => {
			const preset = CANONICAL_PRESETS['4k30-h265'];
			expect(presetMatchesOffered(preset, offeredH264_1080p60)).toBe(false);
		});

		it('returns false when preset framerate is not offered', () => {
			const offeredNoSixty: OfferedSet = {
				...offeredH264_1080p60,
				framerates: [25, 30, 50],
			};
			const preset = CANONICAL_PRESETS['1080p60-h264'];
			expect(presetMatchesOffered(preset, offeredNoSixty)).toBe(false);
		});

		it('returns false when preset codec is not offered', () => {
			const offeredNoH265: OfferedSet = {
				...offeredH265_4k30,
				codecs: [MEDIA_TYPE_H264],
			};
			const preset = CANONICAL_PRESETS['4k30-h265'];
			expect(presetMatchesOffered(preset, offeredNoH265)).toBe(false);
		});

		it('returns true for 4k30-h265 when all three are offered', () => {
			const preset = CANONICAL_PRESETS['4k30-h265'];
			expect(presetMatchesOffered(preset, offeredH265_4k30)).toBe(true);
		});

		it('is pure — inputs are untouched', () => {
			const preset = structuredClone(CANONICAL_PRESETS['1080p60-h264']);
			const offered = structuredClone(offeredH264_1080p60);

			presetMatchesOffered(preset, offered);

			expect(preset).toEqual(CANONICAL_PRESETS['1080p60-h264']);
			expect(offered).toEqual(offeredH264_1080p60);
		});
	});
});
