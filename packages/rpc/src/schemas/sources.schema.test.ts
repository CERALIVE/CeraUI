/**
 * StreamSource schema tests (Todo 1 — device-first source model)
 *
 * Covers:
 *  - parse each of the 4 origins (capture / coarse / virtual / network)
 *  - reject an unknown origin
 *  - capture without displayName fails (field-named issue path)
 *  - coarse without labelKey fails
 *  - network `url` is nullable
 *  - sourcesMessageSchema wraps hardware + the source list
 */
import { describe, expect, test } from 'bun:test';

import {
	type StreamSource,
	sourceOriginSchema,
	sourcesMessageSchema,
	streamSourceSchema,
} from './sources.schema';

const base = {
	id: 'x',
	pipelineId: 'p',
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	audioKind: 'selectable' as const,
	available: true,
};

describe('sourceOriginSchema', () => {
	test('accepts the 4 origins and rejects anything else', () => {
		for (const origin of ['capture', 'coarse', 'virtual', 'network']) {
			expect(sourceOriginSchema.parse(origin)).toBe(origin);
		}
		expect(sourceOriginSchema.safeParse('sdi').success).toBe(false);
	});
});

describe('streamSourceSchema — parses each origin', () => {
	test('capture: a concrete engine device (kind + displayName + devicePath)', () => {
		const capture = {
			...base,
			id: 'video0',
			pipelineId: 'hdmi',
			origin: 'capture' as const,
			kind: 'uvc_h264' as const,
			displayName: 'RØDE HDMI to USB-C: RØDE HDMI',
			devicePath: '/dev/video0',
			modes: [{ width: 1920, height: 1080, framerates: [30, 60] }],
		};
		const parsed = streamSourceSchema.parse(capture);
		expect(parsed.origin).toBe('capture');
		if (parsed.origin === 'capture') {
			expect(parsed.kind).toBe('uvc_h264');
			expect(parsed.displayName).toBe('RØDE HDMI to USB-C: RØDE HDMI');
			expect(parsed.devicePath).toBe('/dev/video0');
			expect(parsed.modes).toHaveLength(1);
		}
	});

	test('coarse: a capability source with only a labelKey', () => {
		const coarse = {
			...base,
			id: 'hdmi',
			pipelineId: 'hdmi',
			origin: 'coarse' as const,
			labelKey: 'settings.sources.hdmi',
		};
		const parsed = streamSourceSchema.parse(coarse);
		expect(parsed.origin).toBe('coarse');
		if (parsed.origin === 'coarse') {
			expect(parsed.labelKey).toBe('settings.sources.hdmi');
		}
	});

	test('virtual: the test pattern', () => {
		const virtual = {
			...base,
			id: 'test',
			pipelineId: 'test',
			origin: 'virtual' as const,
			labelKey: 'settings.sources.test',
			supportsAudio: false,
		};
		const parsed = streamSourceSchema.parse(virtual);
		expect(parsed.origin).toBe('virtual');
		if (parsed.origin === 'virtual') {
			expect(parsed.labelKey).toBe('settings.sources.test');
		}
	});

	test('network: a LAN rtmp ingest source with a url', () => {
		const network = {
			...base,
			id: 'rtmp',
			pipelineId: 'rtmp',
			origin: 'network' as const,
			labelKey: 'settings.sources.rtmp',
			requiresGateway: 'rtmp' as const,
			url: 'rtmp://192.168.0.10:1935/publish/live',
			audioKind: 'embedded' as const,
		};
		const parsed = streamSourceSchema.parse(network);
		expect(parsed.origin).toBe('network');
		if (parsed.origin === 'network') {
			expect(parsed.requiresGateway).toBe('rtmp');
			expect(parsed.url).toBe('rtmp://192.168.0.10:1935/publish/live');
		}
	});

	test('network: url is nullable (gateway not yet up)', () => {
		const network = {
			...base,
			id: 'srt',
			pipelineId: 'srt',
			origin: 'network' as const,
			labelKey: 'settings.sources.srt',
			requiresGateway: 'srt' as const,
			url: null,
			available: false,
			unavailableReason: 'live.education.reason.gatewayInactive',
			audioKind: 'embedded' as const,
		};
		const parsed = streamSourceSchema.parse(network);
		expect(parsed.origin).toBe('network');
		if (parsed.origin === 'network') {
			expect(parsed.url).toBeNull();
			expect(parsed.available).toBe(false);
			expect(parsed.unavailableReason).toBe('live.education.reason.gatewayInactive');
		}
	});

	test('the optional lost flag parses on a capture source', () => {
		const capture = {
			...base,
			origin: 'capture' as const,
			kind: 'hdmi' as const,
			displayName: 'HDMI',
			devicePath: '/dev/video1',
			lost: true,
		};
		const parsed = streamSourceSchema.parse(capture);
		expect(parsed.lost).toBe(true);
	});
});

describe('streamSourceSchema — rejects', () => {
	test('rejects an unknown origin', () => {
		const result = streamSourceSchema.safeParse({
			...base,
			origin: 'sdi',
			labelKey: 'settings.sources.hdmi',
		});
		expect(result.success).toBe(false);
	});

	test('capture without displayName fails (issue path names the field)', () => {
		const result = streamSourceSchema.safeParse({
			...base,
			origin: 'capture',
			kind: 'hdmi',
			devicePath: '/dev/video0',
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.some((i) => i.path.join('.') === 'displayName')).toBe(true);
		}
	});

	test('capture without kind fails (kind is required only here)', () => {
		const result = streamSourceSchema.safeParse({
			...base,
			origin: 'capture',
			displayName: 'HDMI',
			devicePath: '/dev/video0',
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.some((i) => i.path.join('.') === 'kind')).toBe(true);
		}
	});

	test('coarse without labelKey fails', () => {
		const result = streamSourceSchema.safeParse({
			...base,
			id: 'hdmi',
			pipelineId: 'hdmi',
			origin: 'coarse',
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.some((i) => i.path.join('.') === 'labelKey')).toBe(true);
		}
	});

	test('a source missing the required audioKind base field fails', () => {
		const { audioKind: _omit, ...noAudioKind } = base;
		const result = streamSourceSchema.safeParse({
			...noAudioKind,
			origin: 'virtual',
			labelKey: 'settings.sources.test',
		});
		expect(result.success).toBe(false);
	});
});

describe('sourcesMessageSchema', () => {
	test('wraps hardware + the StreamSource list', () => {
		const sources: StreamSource[] = [
			{
				...base,
				id: 'test',
				pipelineId: 'test',
				origin: 'virtual',
				labelKey: 'settings.sources.test',
			},
			{
				...base,
				id: 'video0',
				pipelineId: 'hdmi',
				origin: 'capture',
				kind: 'hdmi',
				displayName: 'HDMI Capture',
				devicePath: '/dev/video0',
			},
		];
		const parsed = sourcesMessageSchema.parse({ hardware: 'rk3588', sources });
		expect(parsed.hardware).toBe('rk3588');
		expect(parsed.sources).toHaveLength(2);
		expect(parsed.sources[0]?.origin).toBe('virtual');
		expect(parsed.sources[1]?.origin).toBe('capture');
	});

	test('rejects an unknown hardware type', () => {
		expect(sourcesMessageSchema.safeParse({ hardware: 'nvidia', sources: [] }).success).toBe(false);
	});
});
