import { describe, expect, it } from 'bun:test';

import {
	CHANGE_CONFIG_MAX_START_ATTEMPTS,
	CHANGE_CONFIG_MAX_TEARDOWNS,
	CHANGE_CONFIG_ONE_START_MS,
	CHANGE_CONFIG_PHASE_DEADLINES_MS,
	CHANGE_CONFIG_WORST_CASE_BOUND_MS,
	CONFIG_CHANGE_PHASES,
	CONFIG_CHANGE_REASON_TEARDOWN_TIMEOUT,
	configChangeResultSchema,
	configChangeStateSchema,
	isTerminalConfigChangePhase,
} from './config-change.schema';

describe('change-config worst-case bound', () => {
	it('totals the 65 000 ms cerastream schema.md §11 publishes', () => {
		expect(CHANGE_CONFIG_WORST_CASE_BOUND_MS).toBe(65_000);
	});

	it('is NOT the intuitive attempt × 2 reading (60 000) an earlier draft published', () => {
		const oneAttempt = CHANGE_CONFIG_PHASE_DEADLINES_MS.teardown + CHANGE_CONFIG_ONE_START_MS;
		expect(oneAttempt * 2).toBe(60_000);
		expect(CHANGE_CONFIG_WORST_CASE_BOUND_MS).not.toBe(oneAttempt * 2);
	});

	it('derives from three teardowns and two starts, not a typed literal', () => {
		expect(CHANGE_CONFIG_MAX_TEARDOWNS).toBe(3);
		expect(CHANGE_CONFIG_MAX_START_ATTEMPTS).toBe(2);
		expect(CHANGE_CONFIG_ONE_START_MS).toBe(25_000);
		expect(CHANGE_CONFIG_WORST_CASE_BOUND_MS).toBe(
			CHANGE_CONFIG_MAX_TEARDOWNS * CHANGE_CONFIG_PHASE_DEADLINES_MS.teardown +
				CHANGE_CONFIG_MAX_START_ATTEMPTS * CHANGE_CONFIG_ONE_START_MS,
		);
	});

	it('carries every phase budget schema.md §11 declares', () => {
		expect(CHANGE_CONFIG_PHASE_DEADLINES_MS).toEqual({
			teardown: 5_000,
			build: 8_000,
			connect: 8_000,
			play: 6_000,
			gate: 3_000,
		});
	});
});

describe('config-change phase model', () => {
	it('mirrors the engine phase enum exactly', () => {
		expect([...CONFIG_CHANGE_PHASES]).toEqual([
			'applying',
			'applied',
			'reverted',
			'rollback_failed',
		]);
	});

	it('treats applying as non-terminal and every outcome as terminal', () => {
		expect(isTerminalConfigChangePhase('applying')).toBe(false);
		expect(isTerminalConfigChangePhase('applied')).toBe(true);
		expect(isTerminalConfigChangePhase('reverted')).toBe(true);
		expect(isTerminalConfigChangePhase('rollback_failed')).toBe(true);
	});

	it('requires an attemptId on every broadcast phase so the UI can fence', () => {
		expect(() => configChangeStateSchema.parse({ phase: 'applying' })).toThrow();
		expect(
			configChangeStateSchema.parse({
				attemptId: 'a1',
				phase: 'rollback_failed',
				reason: CONFIG_CHANGE_REASON_TEARDOWN_TIMEOUT,
			}),
		).toEqual({
			attemptId: 'a1',
			phase: 'rollback_failed',
			reason: 'teardown_timeout',
		});
	});

	it('accepts every result variant and rejects an unknown one', () => {
		expect(configChangeResultSchema.parse({ result: 'applied', attemptId: 'a1' })).toEqual({
			result: 'applied',
			attemptId: 'a1',
		});
		expect(configChangeResultSchema.parse({ result: 'busy' })).toEqual({ result: 'busy' });
		expect(() => configChangeResultSchema.parse({ result: 'applying', attemptId: 'a1' })).toThrow();
	});
});
