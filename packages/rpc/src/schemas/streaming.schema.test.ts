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
	AUDIO_CODEC_UNSUPPORTED_TRANSPORT,
	AUDIO_SOURCE_AUTO,
	audioCodecAllowedForTransport,
	audioCodecSchema,
	audioSourceKindSchema,
	audioSourceSchema,
	type CapabilitiesMessage,
	capabilitiesMessageSchema,
	configMessageSchema,
	deviceKindSchema,
	deviceModeSchema,
	fromEngineResolution,
	normalizeBitrateRangeToKbps,
	normalizeFramerateToRung,
	normalizeResolutionToRung,
	pipelineSchema,
	type Resolution,
	streamingConfigInputSchema,
	switchInputOutputSchema,
	TRANSPORT_AUDIO_CODECS,
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
		expect(streamingConfigInputSchema.safeParse({ video_codec: 'av1' }).success).toBe(false);
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

describe('normalizeFramerateToRung (Task 4)', () => {
	test('maps the engine string fractions onto the legal rungs', () => {
		expect(normalizeFramerateToRung('30/1')).toBe(30);
		expect(normalizeFramerateToRung('30000/1001')).toBe(29.97);
		expect(normalizeFramerateToRung('60000/1001')).toBe(59.94);
		expect(normalizeFramerateToRung('25/1')).toBe(25);
		expect(normalizeFramerateToRung('50/1')).toBe(50);
		expect(normalizeFramerateToRung('60/1')).toBe(60);
	});

	test('passes a numeric value through when it is already a legal rung', () => {
		expect(normalizeFramerateToRung(30)).toBe(30);
		expect(normalizeFramerateToRung(29.97)).toBe(29.97);
		expect(normalizeFramerateToRung(59.94)).toBe(59.94);
		expect(normalizeFramerateToRung(25)).toBe(25);
	});

	test('does NOT confuse the adjacent 29.97 / 30 rungs (0.03 apart)', () => {
		expect(normalizeFramerateToRung(30)).toBe(30);
		expect(normalizeFramerateToRung('30/1')).toBe(30);
	});

	test('returns undefined for a fraction that snaps to no rung (fail-closed)', () => {
		expect(normalizeFramerateToRung('7/3')).toBeUndefined();
		expect(normalizeFramerateToRung('24000/1001')).toBeUndefined();
		expect(normalizeFramerateToRung(24)).toBeUndefined();
		expect(normalizeFramerateToRung('garbage')).toBeUndefined();
		expect(normalizeFramerateToRung('30/0')).toBeUndefined();
		expect(normalizeFramerateToRung('')).toBeUndefined();
	});
});

describe('normalizeResolutionToRung (Task 4)', () => {
	test('maps pixel forms onto the canonical rungs', () => {
		expect(normalizeResolutionToRung('3840x2160')).toBe('2160p');
		expect(normalizeResolutionToRung('1920x1080')).toBe('1080p');
		expect(normalizeResolutionToRung('1280x720')).toBe('720p');
		expect(normalizeResolutionToRung('852x480')).toBe('480p');
		expect(normalizeResolutionToRung('2560x1440')).toBe('1440p');
	});

	test('snaps an in-between pixel form DOWN to the nearest lower rung (never up)', () => {
		expect(normalizeResolutionToRung('2000x1100')).toBe('1080p');
		expect(normalizeResolutionToRung('4096x2160')).toBe('2160p');
		expect(normalizeResolutionToRung('1920x1200')).toBe('1080p');
	});

	test('accepts rung forms, collapsing 4k onto the canonical 2160p', () => {
		expect(normalizeResolutionToRung('2160p')).toBe('2160p');
		expect(normalizeResolutionToRung('1080p')).toBe('1080p');
		expect(normalizeResolutionToRung('4k')).toBe('2160p');
	});

	test('returns undefined for garbage or a sub-480p pixel form (fail-closed)', () => {
		expect(normalizeResolutionToRung('garbage')).toBeUndefined();
		expect(normalizeResolutionToRung('320x240')).toBeUndefined();
		expect(normalizeResolutionToRung('')).toBeUndefined();
		expect(normalizeResolutionToRung('1080')).toBeUndefined();
	});
});

describe('normalizeBitrateRangeToKbps (Task 4)', () => {
	test('converts an engine bps range to kbps', () => {
		expect(normalizeBitrateRangeToKbps({ min: 500_000, max: 20_000_000, unit: 'bps' })).toEqual({
			min: 500,
			max: 20000,
			unit: 'kbps',
		});
	});

	test('passes a kbps range through unchanged (only re-tags the unit)', () => {
		expect(normalizeBitrateRangeToKbps({ min: 500, max: 50000, unit: 'kbps' })).toEqual({
			min: 500,
			max: 50000,
			unit: 'kbps',
		});
	});

	test('treats an unknown unit as already-kbps (fail-safe passthrough)', () => {
		expect(normalizeBitrateRangeToKbps({ min: 2000, max: 12000, unit: '' })).toEqual({
			min: 2000,
			max: 12000,
			unit: 'kbps',
		});
	});
});

describe('deviceModeSchema + capabilitiesMessageSchema device_modes (Task 4)', () => {
	const base = {
		platform: { supports_h265: true, hardware_accelerated: true, max_resolution: '2160p' },
		encoder: { codecs: ['h264', 'h265'], bitrate_range: { min: 500, max: 50000, unit: 'kbps' } },
		sources: [],
	};

	test('parses a device mode with optional media_type', () => {
		const parsed = deviceModeSchema.parse({
			width: 1920,
			height: 1080,
			framerates: [30, 60],
			media_type: 'video/x-h264',
		});
		expect(parsed).toEqual({
			width: 1920,
			height: 1080,
			framerates: [30, 60],
			media_type: 'video/x-h264',
		});
	});

	test('rejects a device mode with a negative width (field-named issue)', () => {
		const result = deviceModeSchema.safeParse({ width: -1, height: 1080, framerates: [30] });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.path).toEqual(['width']);
		}
	});

	test('a caps-full snapshot with device_modes parses', () => {
		const parsed = capabilitiesMessageSchema.parse({
			...base,
			network_embedded_audio: true,
			device_modes: {
				'hdmi-0': {
					kind: 'hdmi',
					modes: [
						{ width: 1920, height: 1080, framerates: [30, 60] },
						{ width: 3840, height: 2160, framerates: [30] },
					],
				},
				'usb-0': {
					kind: 'uvc_h264',
					modes: [{ width: 1280, height: 720, framerates: [30, 60] }],
				},
			},
		});
		expect(parsed.network_embedded_audio).toBe(true);
		expect(parsed.device_modes?.['hdmi-0']?.kind).toBe('hdmi');
		expect(parsed.device_modes?.['hdmi-0']?.modes).toHaveLength(2);
		expect(parsed.device_modes?.['usb-0']?.modes?.[0]?.framerates).toEqual([30, 60]);
	});

	test('an old capability payload without device_modes / network_embedded_audio still parses', () => {
		const parsed = capabilitiesMessageSchema.parse(base);
		expect(parsed.device_modes).toBeUndefined();
		expect(parsed.network_embedded_audio).toBeUndefined();
	});
});

describe('pipelineSchema audio_kind + audioSourceSchema (Task 4)', () => {
	const basePipeline = {
		name: 'HDMI',
		description: 'HDMI capture',
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
	};

	test('audio_kind is additive-optional and accepts the three kinds', () => {
		expect(pipelineSchema.parse(basePipeline).audio_kind).toBeUndefined();
		for (const kind of ['selectable', 'embedded', 'none']) {
			expect(pipelineSchema.parse({ ...basePipeline, audio_kind: kind }).audio_kind).toBe(kind);
		}
	});

	test('pipelineSchema rejects an unknown audio_kind', () => {
		expect(pipelineSchema.safeParse({ ...basePipeline, audio_kind: 'muxed' }).success).toBe(false);
	});

	test('audioSourceSchema parses device + pseudo sources; labelKey is optional', () => {
		expect(audioSourceSchema.parse({ id: 'USB audio', kind: 'device' })).toEqual({
			id: 'USB audio',
			kind: 'device',
		});
		expect(
			audioSourceSchema.parse({ id: 'No audio', kind: 'none', labelKey: 'audio.sources.noAudio' }),
		).toEqual({ id: 'No audio', kind: 'none', labelKey: 'audio.sources.noAudio' });
	});

	test('audioSourceSchema rejects an unknown kind', () => {
		expect(audioSourceSchema.safeParse({ id: 'x', kind: 'analog' }).success).toBe(false);
	});
});

describe('audio Auto source additions (T1 — additive)', () => {
	test('AUDIO_SOURCE_AUTO is the "Auto" wire sentinel', () => {
		expect(AUDIO_SOURCE_AUTO).toBe('Auto');
	});

	test("audioSourceKindSchema accepts the appended 'auto' variant", () => {
		expect(audioSourceKindSchema.parse('auto')).toBe('auto');
		for (const kind of ['device', 'none', 'pipeline_default']) {
			expect(audioSourceKindSchema.parse(kind)).toBe(kind);
		}
	});

	test('audioSourceSchema carries an optional verbatim label', () => {
		expect(
			audioSourceSchema.parse({ id: 'USB audio', kind: 'device', label: 'Scarlett Solo USB' }),
		).toEqual({ id: 'USB audio', kind: 'device', label: 'Scarlett Solo USB' });
		expect(audioSourceSchema.parse({ id: 'USB audio', kind: 'device' }).label).toBeUndefined();
	});

	test('audioSourceSchema parses the Auto pseudo-source', () => {
		expect(
			audioSourceSchema.parse({ id: 'Auto', kind: 'auto', labelKey: 'audio.sources.auto' }),
		).toEqual({ id: 'Auto', kind: 'auto', labelKey: 'audio.sources.auto' });
	});

	test('audioSourceSchema rejects a bogus kind (QA failure case)', () => {
		expect(audioSourceSchema.safeParse({ id: 'x', kind: 'bogus' }).success).toBe(false);
	});
});

describe('switchInputOutputSchema — audio_follow_pending (T1/T7 — additive)', () => {
	test('parses WITHOUT audio_follow_pending (legacy)', () => {
		const parsed = switchInputOutputSchema.parse({ success: true, active_input: 'cam-0' });
		expect(parsed.audio_follow_pending).toBeUndefined();
	});

	test('parses WITH audio_follow_pending: true', () => {
		const parsed = switchInputOutputSchema.parse({
			success: true,
			active_input: 'cam-0',
			audio_follow_pending: true,
		});
		expect(parsed.audio_follow_pending).toBe(true);
	});

	test('rejects a non-boolean audio_follow_pending', () => {
		expect(
			switchInputOutputSchema.safeParse({ success: true, audio_follow_pending: 'yes' }).success,
		).toBe(false);
	});
});

describe('audioCodecSchema — pcm retired (C5)', () => {
	test('accepts opus and aac', () => {
		expect(audioCodecSchema.parse('opus')).toBe('opus');
		expect(audioCodecSchema.parse('aac')).toBe('aac');
	});

	test('no longer accepts pcm', () => {
		expect(audioCodecSchema.safeParse('pcm').success).toBe(false);
	});
});

describe('TRANSPORT_AUDIO_CODECS + audioCodecAllowedForTransport (C5)', () => {
	test('map values are exactly aac-only for every transport', () => {
		expect(TRANSPORT_AUDIO_CODECS).toEqual({
			srtla: ['aac'],
			srt: ['aac'],
			rist: ['aac'],
		});
	});

	test('aac is allowed over every relay transport', () => {
		for (const protocol of ['srtla', 'srt', 'rist'] as const) {
			expect(audioCodecAllowedForTransport('aac', protocol)).toBe(true);
		}
	});

	test('opus is disallowed over every relay transport', () => {
		for (const protocol of ['srtla', 'srt', 'rist'] as const) {
			expect(audioCodecAllowedForTransport('opus', protocol)).toBe(false);
		}
	});

	test('the unsupported-transport error code is stable', () => {
		expect(AUDIO_CODEC_UNSUPPORTED_TRANSPORT).toBe('audio_codec_unsupported_transport');
	});
});
