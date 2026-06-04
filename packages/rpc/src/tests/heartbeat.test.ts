/**
 * Heartbeat ping/pong schema tests
 * TDD: RED first — test ping/pong parsing
 */
import { describe, it, expect } from 'bun:test';
import { pingSchema, pongSchema } from '../schemas/heartbeat.schema';

describe('pingSchema', () => {
	it('should parse a valid ping message with timestamp', () => {
		const ping = { t: 1234567890 };
		const result = pingSchema.safeParse(ping);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.t).toBe(1234567890);
		}
	});

	it('should reject ping without timestamp', () => {
		const ping = {};
		const result = pingSchema.safeParse(ping);
		expect(result.success).toBe(false);
	});

	it('should reject ping with non-integer timestamp', () => {
		const ping = { t: 1234567890.5 };
		const result = pingSchema.safeParse(ping);
		expect(result.success).toBe(false);
	});

	it('should reject ping with negative timestamp', () => {
		const ping = { t: -1 };
		const result = pingSchema.safeParse(ping);
		expect(result.success).toBe(false);
	});

	it('should reject ping with zero timestamp', () => {
		const ping = { t: 0 };
		const result = pingSchema.safeParse(ping);
		expect(result.success).toBe(false);
	});
});

describe('pongSchema', () => {
	it('should parse a valid pong message', () => {
		const pong = { pong: true };
		const result = pongSchema.safeParse(pong);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.pong).toBe(true);
		}
	});

	it('should reject pong without pong field', () => {
		const pong = {};
		const result = pongSchema.safeParse(pong);
		expect(result.success).toBe(false);
	});

	it('should reject pong with false value', () => {
		const pong = { pong: false };
		const result = pongSchema.safeParse(pong);
		expect(result.success).toBe(false);
	});

	it('should reject pong with non-boolean value', () => {
		const pong = { pong: 'true' };
		const result = pongSchema.safeParse(pong);
		expect(result.success).toBe(false);
	});
});
