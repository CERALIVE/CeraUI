/**
 * Broadcast envelope schema tests
 * TDD: RED first — test optional seq and ack fields
 */
import { describe, it, expect } from 'bun:test';
import { broadcastEnvelopeSchema } from '../schemas/broadcast.schema';

describe('broadcastEnvelopeSchema', () => {
	it('should parse a message without seq field', () => {
		const message = {
			type: 'status',
			data: { is_streaming: true },
		};
		const result = broadcastEnvelopeSchema.safeParse(message);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.seq).toBeUndefined();
		}
	});

	it('should parse a message with seq field', () => {
		const message = {
			type: 'status',
			data: { is_streaming: true },
			seq: 42,
		};
		const result = broadcastEnvelopeSchema.safeParse(message);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.seq).toBe(42);
		}
	});

	it('should parse a message without ack field', () => {
		const message = {
			type: 'status',
			data: { is_streaming: true },
		};
		const result = broadcastEnvelopeSchema.safeParse(message);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.ack).toBeUndefined();
		}
	});

	it('should parse a message with ack field', () => {
		const message = {
			type: 'status',
			data: { is_streaming: true },
			ack: { id: 'msg-123' },
		};
		const result = broadcastEnvelopeSchema.safeParse(message);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.ack?.id).toBe('msg-123');
		}
	});

	it('should parse a message with both seq and ack', () => {
		const message = {
			type: 'status',
			data: { is_streaming: true },
			seq: 42,
			ack: { id: 'msg-123' },
		};
		const result = broadcastEnvelopeSchema.safeParse(message);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.seq).toBe(42);
			expect(result.data.ack?.id).toBe('msg-123');
		}
	});
});
