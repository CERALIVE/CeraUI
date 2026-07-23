/**
 * Applied-state output schema tests
 * TDD: RED first — test that command procedures return applied state post-clamp
 */
import { describe, expect, it } from 'bun:test';
import {
	bitrateOutputSchema,
	netifConfigOutputSchema,
	streamingSetConfigOutputSchema,
	streamingStartOutputSchemaExtended,
} from './schemas';

describe('Applied-state output schemas', () => {
	describe('streamingSetConfigOutputSchema', () => {
		it('should include applied config fields', () => {
			const output = {
				success: true,
				applied: {
					delay: 100,
					srt_latency: 1000,
					pipeline: 'hdmi',
					acodec: 'opus',
					relay_server: 'relay.example.com',
					relay_account: 'account123',
					srtla_addr: '192.168.1.1',
					srtla_port: 6000,
					srt_streamid: 'stream123',
					asrc: 'default',
					bitrate_overlay: true,
					max_br: 5000,
					autostart: false,
					resolution: '1080p',
					framerate: 30,
				},
			};
			const result = streamingSetConfigOutputSchema.safeParse(output);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.applied).toBeDefined();
				expect(result.data.applied?.max_br).toBe(5000);
				expect(result.data.applied?.pipeline).toBe('hdmi');
			}
		});

		it('should allow partial applied fields', () => {
			const output = {
				success: true,
				applied: {
					max_br: 3000,
					pipeline: 'test',
				},
			};
			const result = streamingSetConfigOutputSchema.safeParse(output);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.applied?.max_br).toBe(3000);
			}
		});

		it('should allow empty applied object', () => {
			const output = {
				success: true,
				applied: {},
			};
			const result = streamingSetConfigOutputSchema.safeParse(output);
			expect(result.success).toBe(true);
		});
	});

	describe('streamingStartOutputSchemaExtended', () => {
		it('should include applied config fields', () => {
			const output = {
				success: true,
				is_streaming: true,
				result: 'started',
				attemptId: 'att_schema_test',
				applied: {
					max_br: 8000,
					pipeline: 'hdmi',
					acodec: 'aac',
				},
			};
			const result = streamingStartOutputSchemaExtended.safeParse(output);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.applied).toBeDefined();
				expect(result.data.applied?.max_br).toBe(8000);
			}
		});

		it.each(['busy', 'cancelled'] as const)('preserves the typed %s result', (lifecycleResult:
			| 'busy'
			| 'cancelled') => {
			const result = streamingStartOutputSchemaExtended.parse({
				success: false,
				is_streaming: false,
				result: lifecycleResult,
				attemptId: 'att_schema_test',
			});
			expect(result).toMatchObject({
				result: lifecycleResult,
				attemptId: 'att_schema_test',
			});
		});

		it('strips internal lifecycle metadata from an established failure response', () => {
			const result = streamingStartOutputSchemaExtended.parse({
				success: false,
				is_streaming: false,
				error: 'source_lost',
				result: 'failed',
				attemptId: 'att_schema_test',
				failure: { class: 'start_invalid' },
			});
			expect(result).toEqual({
				success: false,
				is_streaming: false,
				error: 'source_lost',
			});
		});
	});

	describe('bitrateOutputSchema', () => {
		it('should carry success + the applied bitrate after clamp', () => {
			const output = {
				success: true,
				applied: 5000,
			};
			const result = bitrateOutputSchema.safeParse(output);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.success).toBe(true);
				expect(result.data.applied).toBe(5000);
			}
		});

		it('should carry a structured error on failure', () => {
			const output = {
				success: false,
				error: { message: 'Engine rejected the bitrate change' },
			};
			const result = bitrateOutputSchema.safeParse(output);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.success).toBe(false);
				expect(result.data.error?.message).toBeDefined();
			}
		});
	});

	describe('netifConfigOutputSchema', () => {
		it('should include applied config fields', () => {
			const output = {
				success: true,
				applied: {
					name: 'eth0',
					ip: '192.168.1.100',
					enabled: true,
				},
			};
			const result = netifConfigOutputSchema.safeParse(output);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.applied).toBeDefined();
				expect(result.data.applied?.ip).toBe('192.168.1.100');
			}
		});

		it('should allow partial applied fields', () => {
			const output = {
				success: true,
				applied: {
					enabled: true,
				},
			};
			const result = netifConfigOutputSchema.safeParse(output);
			expect(result.success).toBe(true);
		});
	});
});
