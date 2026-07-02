import { describe, expect, test } from 'bun:test';

import { activeEncodeSchema, statusResponseSchema } from './status.schema';

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
