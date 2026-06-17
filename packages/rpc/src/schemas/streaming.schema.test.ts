/**
 * Streaming schema tests (Task 2 — audio_live_switch capability flag)
 *
 * Covers:
 *  (a) legacy snapshot without audio_live_switch parses successfully
 *  (b) snapshot with audio_live_switch: true parses and selector returns true
 *  (c) snapshot with audio_live_switch: false parses and selector returns false
 *  (d) selector returns false when caps is undefined
 *  (e) bindings-skew test: schema_version unchanged, field is optional
 */
import { describe, expect, test } from 'bun:test';

import { isAudioLiveSwitchEnabled } from '../capabilities/audio';
import { type CapabilitiesMessage, capabilitiesMessageSchema } from './streaming.schema';

describe('capabilitiesMessageSchema — audio_live_switch field', () => {
	test('(a) legacy snapshot without audio_live_switch parses successfully', () => {
		const legacySnapshot = {
			platform: {
				supports_h265: true,
				hardware_accelerated: true,
				max_resolution: '2160p',
			},
			encoder: {
				codecs: ['H264', 'H265'],
				bitrate_range: { min: 500, max: 50000, unit: 'kbps' },
			},
			sources: [
				{
					id: 'hdmi',
					supports_audio: true,
					supports_resolution_override: true,
					supports_framerate_override: true,
					default_resolution: '1920x1080',
					default_framerate: 30,
				},
			],
		};

		const parsed = capabilitiesMessageSchema.parse(legacySnapshot);
		expect(parsed.audio_live_switch).toBeUndefined();
		expect(isAudioLiveSwitchEnabled(parsed)).toBe(false);
	});

	test('(b) snapshot with audio_live_switch: true parses and selector returns true', () => {
		const snapshotWithTrue: CapabilitiesMessage = {
			platform: {
				supports_h265: true,
				hardware_accelerated: true,
				max_resolution: '2160p',
			},
			encoder: {
				codecs: ['H264', 'H265'],
				bitrate_range: { min: 500, max: 50000, unit: 'kbps' },
			},
			sources: [
				{
					id: 'hdmi',
					supports_audio: true,
					supports_resolution_override: true,
					supports_framerate_override: true,
					default_resolution: '1920x1080',
					default_framerate: 30,
				},
			],
			audio_live_switch: true,
		};

		const parsed = capabilitiesMessageSchema.parse(snapshotWithTrue);
		expect(parsed.audio_live_switch).toBe(true);
		expect(isAudioLiveSwitchEnabled(parsed)).toBe(true);
	});

	test('(c) snapshot with audio_live_switch: false parses and selector returns false', () => {
		const snapshotWithFalse: CapabilitiesMessage = {
			platform: {
				supports_h265: true,
				hardware_accelerated: true,
				max_resolution: '2160p',
			},
			encoder: {
				codecs: ['H264', 'H265'],
				bitrate_range: { min: 500, max: 50000, unit: 'kbps' },
			},
			sources: [
				{
					id: 'hdmi',
					supports_audio: true,
					supports_resolution_override: true,
					supports_framerate_override: true,
					default_resolution: '1920x1080',
					default_framerate: 30,
				},
			],
			audio_live_switch: false,
		};

		const parsed = capabilitiesMessageSchema.parse(snapshotWithFalse);
		expect(parsed.audio_live_switch).toBe(false);
		expect(isAudioLiveSwitchEnabled(parsed)).toBe(false);
	});

	test('(d) selector returns false when caps is undefined', () => {
		expect(isAudioLiveSwitchEnabled(undefined)).toBe(false);
	});

	test('(e) field is optional — does not break bindings-skew test', () => {
		const minimalSnapshot = {
			platform: {
				supports_h265: false,
				hardware_accelerated: false,
				max_resolution: '1920x1080',
			},
			encoder: {
				codecs: ['H264'],
				bitrate_range: { min: 500, max: 6000, unit: 'kbps' },
			},
			sources: [
				{
					id: 'test',
					supports_audio: false,
					supports_resolution_override: false,
					supports_framerate_override: false,
					default_resolution: '1920x1080',
					default_framerate: 30,
				},
			],
		};

		const parsed = capabilitiesMessageSchema.parse(minimalSnapshot);
		expect(parsed).toBeDefined();
		expect(parsed.audio_live_switch).toBeUndefined();
	});
});

describe('isAudioLiveSwitchEnabled selector', () => {
	test('returns true only when audio_live_switch is explicitly true', () => {
		const caps: CapabilitiesMessage = {
			platform: {
				supports_h265: true,
				hardware_accelerated: true,
				max_resolution: '2160p',
			},
			encoder: {
				codecs: ['H264'],
				bitrate_range: { min: 500, max: 50000, unit: 'kbps' },
			},
			sources: [],
			audio_live_switch: true,
		};

		expect(isAudioLiveSwitchEnabled(caps)).toBe(true);
	});

	test('returns false when audio_live_switch is false', () => {
		const caps: CapabilitiesMessage = {
			platform: {
				supports_h265: true,
				hardware_accelerated: true,
				max_resolution: '2160p',
			},
			encoder: {
				codecs: ['H264'],
				bitrate_range: { min: 500, max: 50000, unit: 'kbps' },
			},
			sources: [],
			audio_live_switch: false,
		};

		expect(isAudioLiveSwitchEnabled(caps)).toBe(false);
	});

	test('returns false when audio_live_switch is absent (legacy)', () => {
		const caps: CapabilitiesMessage = {
			platform: {
				supports_h265: true,
				hardware_accelerated: true,
				max_resolution: '2160p',
			},
			encoder: {
				codecs: ['H264'],
				bitrate_range: { min: 500, max: 50000, unit: 'kbps' },
			},
			sources: [],
		};

		expect(isAudioLiveSwitchEnabled(caps)).toBe(false);
	});

	test('returns false when caps is null or undefined', () => {
		expect(isAudioLiveSwitchEnabled(undefined)).toBe(false);
		expect(isAudioLiveSwitchEnabled(null as any)).toBe(false);
	});
});
