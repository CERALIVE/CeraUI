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
import {
	type CapabilitiesMessage,
	capabilitiesMessageSchema,
	configMessageSchema,
	deviceKindSchema,
	fromEngineResolution,
	type Resolution,
	streamingConfigInputSchema,
	toEngineResolution,
} from './streaming.schema';

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
		expect(isAudioLiveSwitchEnabled(null as unknown)).toBe(false);
	});
});

describe('video_codec + selected_video_input (Todo 19)', () => {
	test('both fields are additive/optional on streamingConfigInputSchema', () => {
		const empty = streamingConfigInputSchema.parse({});
		expect(empty.video_codec).toBeUndefined();
		expect(empty.selected_video_input).toBeUndefined();
		const parsed = streamingConfigInputSchema.parse({
			video_codec: 'h265',
			selected_video_input: 'cam-0',
		});
		expect(parsed.video_codec).toBe('h265');
		expect(parsed.selected_video_input).toBe('cam-0');
	});

	test('both fields are additive/optional on configMessageSchema (echo)', () => {
		const empty = configMessageSchema.parse({});
		expect(empty.video_codec).toBeUndefined();
		expect(empty.selected_video_input).toBeUndefined();
		const parsed = configMessageSchema.parse({
			video_codec: 'h264',
			selected_video_input: 'hdmi-1',
		});
		expect(parsed.video_codec).toBe('h264');
		expect(parsed.selected_video_input).toBe('hdmi-1');
	});

	test('video_codec rejects a non-enum value', () => {
		expect(
			streamingConfigInputSchema.safeParse({ video_codec: 'av1' }).success,
		).toBe(false);
	});
});

describe('deviceKindSchema — additive engine-typed kinds (Todo 19)', () => {
	test('legacy kinds still parse', () => {
		for (const kind of ['hdmi', 'usb', 'network', 'test', 'audio', 'other']) {
			expect(deviceKindSchema.parse(kind)).toBe(kind);
		}
	});

	test('new engine-typed kinds parse', () => {
		for (const kind of ['uvc_h264', 'uvc_h265', 'mjpeg', 'camlink']) {
			expect(deviceKindSchema.parse(kind)).toBe(kind);
		}
	});

	test('an unknown kind still rejects', () => {
		expect(deviceKindSchema.safeParse('sdi').success).toBe(false);
	});
});

describe('resolution ↔ engine-dims map (Todo 18/19 contract)', () => {
	test('canonical tokens round-trip bijectively against cerastream Resolution::dims()', () => {
		const canonical: Array<[Resolution, string]> = [
			['480p', '852x480'],
			['720p', '1280x720'],
			['1080p', '1920x1080'],
			['1440p', '2560x1440'],
			['2160p', '3840x2160'],
		];
		for (const [token, wxh] of canonical) {
			expect(toEngineResolution(token)).toBe(wxh);
			expect(fromEngineResolution(wxh)).toBe(token);
		}
	});

	test("'4k' is an alias: maps to 3840x2160 forward, but reverse yields only '2160p'", () => {
		expect(toEngineResolution('4k')).toBe('3840x2160');
		expect(fromEngineResolution('3840x2160')).toBe('2160p');
		expect(fromEngineResolution('3840x2160')).not.toBe('4k');
	});

	test('an unknown "WxH" returns undefined', () => {
		expect(fromEngineResolution('1024x768')).toBeUndefined();
	});
});

describe('capabilitiesMessageSchema — preview passthrough (Todo 13-15)', () => {
	const base = {
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

	test('legacy snapshot without preview parses (field absent)', () => {
		const parsed = capabilitiesMessageSchema.parse(base);
		expect(parsed.preview).toBeUndefined();
	});

	test('a bound preview snapshot parses with enabled/port/bound', () => {
		const parsed = capabilitiesMessageSchema.parse({
			...base,
			preview: { enabled: true, port: 9997, bound: true },
		});
		expect(parsed.preview).toEqual({ enabled: true, port: 9997, bound: true });
	});

	test('port is optional (unbound/port-conflicted preview)', () => {
		const parsed = capabilitiesMessageSchema.parse({
			...base,
			preview: { enabled: true, bound: false },
		});
		expect(parsed.preview).toEqual({ enabled: true, bound: false });
	});
});
