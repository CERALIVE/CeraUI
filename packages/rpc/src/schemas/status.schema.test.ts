import { describe, expect, test } from 'bun:test';

import {
	activeEncodeSchema,
	networkIngestSchema,
	statusMessageSchema,
	statusResponseSchema,
} from './status.schema';

describe('activeEncodeSchema (Todo 19 — realized runtime encode)', () => {
	test('parses a full active_encode payload', () => {
		const parsed = activeEncodeSchema.parse({
			codec: 'h265',
			resolution: '1920x1080',
			framerate: 30,
			active_input: 'cam-0',
			decoder: 'nvv4l2decoder',
		});
		expect(parsed).toEqual({
			codec: 'h265',
			resolution: '1920x1080',
			framerate: 30,
			active_input: 'cam-0',
			decoder: 'nvv4l2decoder',
		});
	});

	test('active_input and decoder are optional', () => {
		const parsed = activeEncodeSchema.parse({
			codec: 'h264',
			resolution: '852x480',
			framerate: 60,
		});
		expect(parsed.active_input).toBeUndefined();
		expect(parsed.decoder).toBeUndefined();
	});

	test('rejects a payload missing a required field', () => {
		expect(activeEncodeSchema.safeParse({ codec: 'h264', framerate: 30 }).success).toBe(false);
	});
});

describe('statusResponseSchema — active_encode field (additive)', () => {
	test('parses with active_encode absent (legacy engine)', () => {
		const parsed = statusResponseSchema.parse({ is_streaming: true });
		expect(parsed.active_encode).toBeUndefined();
	});

	test('parses with active_encode present', () => {
		const parsed = statusResponseSchema.parse({
			is_streaming: true,
			active_encode: { codec: 'h265', resolution: '3840x2160', framerate: 30 },
		});
		expect(parsed.active_encode?.codec).toBe('h265');
	});

	test('active_encode is nullable (same pattern as buffering)', () => {
		const parsed = statusResponseSchema.parse({
			is_streaming: true,
			active_encode: null,
		});
		expect(parsed.active_encode).toBeNull();
	});
});

describe('networkIngestSchema (Task 16 — network-ingest gateway status)', () => {
	test('round-trips both protocols active with LAN urls', () => {
		const parsed = networkIngestSchema.parse({
			rtmp: { service_active: true, url: 'rtmp://192.168.1.100:1935/publish/live' },
			srt: { service_active: true, url: 'srt://192.168.1.100:4001' },
		});
		expect(parsed).toEqual({
			rtmp: { service_active: true, url: 'rtmp://192.168.1.100:1935/publish/live' },
			srt: { service_active: true, url: 'srt://192.168.1.100:4001' },
		});
	});

	test('a protocol excluded by board caps is null', () => {
		const parsed = networkIngestSchema.parse({
			rtmp: { service_active: false, url: 'rtmp://192.168.1.100:1935/publish/live' },
			srt: null,
		});
		expect(parsed.srt).toBeNull();
		expect(parsed.rtmp?.service_active).toBe(false);
	});

	test('rejects a protocol entry missing service_active', () => {
		expect(
			networkIngestSchema.safeParse({
				rtmp: { url: 'rtmp://192.168.1.100:1935/publish/live' },
				srt: null,
			}).success,
		).toBe(false);
	});
});

describe('audio_sources field (Task 4 — typed audio sources beside legacy asrcs)', () => {
	const baseStatus = {
		is_streaming: false,
		available_updates: null,
		updating: false,
		ssh: { user: 'user', user_pass: false, active: false },
		wifi: {},
		asrcs: ['USB audio', 'No audio', 'Pipeline default'],
		modems: {},
	};

	test('statusMessageSchema parses WITHOUT audio_sources (legacy — asrcs only)', () => {
		const parsed = statusMessageSchema.parse(baseStatus);
		expect(parsed.audio_sources).toBeUndefined();
		expect(parsed.asrcs).toEqual(['USB audio', 'No audio', 'Pipeline default']);
	});

	test('statusMessageSchema parses WITH audio_sources beside asrcs', () => {
		const parsed = statusMessageSchema.parse({
			...baseStatus,
			audio_sources: [
				{ id: 'USB audio', kind: 'device' },
				{ id: 'No audio', kind: 'none', labelKey: 'audio.sources.noAudio' },
				{
					id: 'Pipeline default',
					kind: 'pipeline_default',
					labelKey: 'audio.sources.pipelineDefault',
				},
			],
		});
		expect(parsed.audio_sources).toHaveLength(3);
		expect(parsed.audio_sources?.[0]).toEqual({ id: 'USB audio', kind: 'device' });
		expect(parsed.audio_sources?.[1]?.kind).toBe('none');
	});

	test('statusResponseSchema carries audio_sources additively (absent + present)', () => {
		expect(statusResponseSchema.parse({ is_streaming: true }).audio_sources).toBeUndefined();
		const parsed = statusResponseSchema.parse({
			is_streaming: true,
			audio_sources: [{ id: 'USB audio', kind: 'device' }],
		});
		expect(parsed.audio_sources?.[0]?.id).toBe('USB audio');
	});

	test('rejects an audio source missing kind', () => {
		expect(
			statusResponseSchema.safeParse({
				is_streaming: true,
				audio_sources: [{ id: 'USB audio' }],
			}).success,
		).toBe(false);
	});
});

describe('statusResponseSchema — network_ingest field (additive)', () => {
	test('parses with network_ingest absent (older backend)', () => {
		const parsed = statusResponseSchema.parse({ is_streaming: true });
		expect(parsed.network_ingest).toBeUndefined();
	});

	test('parses with network_ingest present', () => {
		const parsed = statusResponseSchema.parse({
			is_streaming: true,
			network_ingest: {
				rtmp: { service_active: true, url: 'rtmp://192.168.1.100:1935/publish/live' },
				srt: null,
			},
		});
		expect(parsed.network_ingest?.rtmp?.url).toBe('rtmp://192.168.1.100:1935/publish/live');
		expect(parsed.network_ingest?.srt).toBeNull();
	});

	test('network_ingest is nullable (same pattern as buffering/active_encode)', () => {
		const parsed = statusResponseSchema.parse({
			is_streaming: true,
			network_ingest: null,
		});
		expect(parsed.network_ingest).toBeNull();
	});
});
