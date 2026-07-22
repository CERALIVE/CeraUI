/**
 * Start-lifecycle contract schema tests (device-quality-wave2 Todo 25).
 *
 * Locks the WIRE RESULT UNION (`StartResult = started | busy | cancelled |
 * failed`), the `StartFailure` shape, the stop-result union
 * (`stopping → stopped | stop_failed`), the lifecycle state set, and the
 * legal-transition table. Design-only: these types are consumed by Todos 26-29;
 * nothing is wired into a runtime path yet.
 */

import { describe, expect, test } from 'bun:test';

import {
	isLegalLifecycleTransition,
	isRetriableStartFailure,
	LEGAL_LIFECYCLE_TRANSITIONS,
	LIFECYCLE_STATES,
	lifecycleStateSchema,
	START_FAILURE_CLASSES,
	START_FAILURE_PHASES,
	START_FAILURE_RETRIABILITY,
	startFailureClassSchema,
	startFailurePhaseSchema,
	startFailureSchema,
	startResultSchema,
	stopResultSchema,
} from './streaming-lifecycle.schema';

describe('StartFailure shape', () => {
	const base = {
		attemptId: 'att_abc123',
		phase: 'connect' as const,
		class: 'engine_unavailable' as const,
		retriable: true,
	};

	test('accepts a well-formed failure (no code)', () => {
		const parsed = startFailureSchema.parse(base);
		expect(parsed.attemptId).toBe('att_abc123');
		expect(parsed.phase).toBe('connect');
		expect(parsed.class).toBe('engine_unavailable');
		expect(parsed.retriable).toBe(true);
		expect(parsed.code).toBeUndefined();
	});

	test('accepts an optional numeric engine code', () => {
		const parsed = startFailureSchema.parse({
			...base,
			phase: 'start-rpc',
			class: 'engine_internal',
			retriable: false,
			code: -32603,
		});
		expect(parsed.code).toBe(-32603);
	});

	test('accepts an optional string engine data-code', () => {
		const parsed = startFailureSchema.parse({
			...base,
			phase: 'hello',
			class: 'protocol_incompatible',
			retriable: false,
			code: 'cerastream.protocol.unsupported_version',
		});
		expect(parsed.code).toBe('cerastream.protocol.unsupported_version');
	});

	test('REJECTS an unknown phase', () => {
		expect(startFailurePhaseSchema.safeParse('warmup').success).toBe(false);
	});

	test('REJECTS an unknown class', () => {
		expect(startFailureClassSchema.safeParse('superseded').success).toBe(false);
	});

	test('REJECTS a failure missing attemptId (Todo 29 fencing needs it)', () => {
		const { attemptId: _drop, ...noId } = base;
		expect(startFailureSchema.safeParse(noId).success).toBe(false);
	});
});

describe('StartResult wire union — every variant echoes attemptId', () => {
	test('started', () => {
		const parsed = startResultSchema.parse({ result: 'started', attemptId: 'att_1' });
		expect(parsed.result).toBe('started');
		expect(parsed.attemptId).toBe('att_1');
	});

	test('busy is a FIRST-CLASS result, not a failure class', () => {
		const parsed = startResultSchema.parse({ result: 'busy', attemptId: 'att_2' });
		expect(parsed.result).toBe('busy');
		expect(parsed.attemptId).toBe('att_2');
		expect(START_FAILURE_CLASSES).not.toContain('busy');
	});

	test('cancelled is a FIRST-CLASS result (no superseded failure class)', () => {
		const parsed = startResultSchema.parse({ result: 'cancelled', attemptId: 'att_3' });
		expect(parsed.result).toBe('cancelled');
		expect(START_FAILURE_CLASSES).not.toContain('cancelled');
		expect(START_FAILURE_CLASSES).not.toContain('superseded');
	});

	test('failed carries a StartFailure whose attemptId matches the variant (fencing invariant)', () => {
		const parsed = startResultSchema.parse({
			result: 'failed',
			attemptId: 'att_4',
			failure: {
				attemptId: 'att_4',
				phase: 'start-rpc',
				class: 'start_invalid',
				retriable: false,
				code: -32602,
			},
		});
		if (parsed.result !== 'failed') throw new Error('discriminant lost');
		expect(parsed.attemptId).toBe(parsed.failure.attemptId);
	});

	test('REJECTS every variant missing attemptId', () => {
		expect(startResultSchema.safeParse({ result: 'started' }).success).toBe(false);
		expect(startResultSchema.safeParse({ result: 'busy' }).success).toBe(false);
		expect(startResultSchema.safeParse({ result: 'cancelled' }).success).toBe(false);
	});

	test('REJECTS an unknown result discriminant', () => {
		expect(startResultSchema.safeParse({ result: 'superseded', attemptId: 'att_x' }).success).toBe(
			false,
		);
	});
});

describe('StopResult wire union — stopping → stopped | stop_failed', () => {
	test('stopping', () => {
		expect(stopResultSchema.parse({ result: 'stopping' }).result).toBe('stopping');
	});

	test('stopped', () => {
		expect(stopResultSchema.parse({ result: 'stopped' }).result).toBe('stopped');
	});

	test('stop_failed carries a reason', () => {
		const parsed = stopResultSchema.parse({ result: 'stop_failed', reason: 'engine wedged' });
		if (parsed.result !== 'stop_failed') throw new Error('discriminant lost');
		expect(parsed.reason).toBe('engine wedged');
	});

	test('REJECTS an unknown stop discriminant', () => {
		expect(stopResultSchema.safeParse({ result: 'aborted' }).success).toBe(false);
	});
});

describe('lifecycle state set + legal transitions', () => {
	test('the state set is exactly the six documented states', () => {
		expect([...LIFECYCLE_STATES].sort()).toEqual(
			['idle', 'reconciling', 'starting', 'stop_failed', 'stopping', 'streaming'].sort(),
		);
	});

	test('every state parses', () => {
		for (const s of LIFECYCLE_STATES) {
			expect(lifecycleStateSchema.parse(s)).toBe(s);
		}
	});

	test('the happy path is legal (idle→starting→streaming→stopping→idle)', () => {
		expect(isLegalLifecycleTransition('idle', 'starting')).toBe(true);
		expect(isLegalLifecycleTransition('starting', 'streaming')).toBe(true);
		expect(isLegalLifecycleTransition('streaming', 'stopping')).toBe(true);
		expect(isLegalLifecycleTransition('stopping', 'idle')).toBe(true);
	});

	test('start failure/cancel returns to idle (starting→idle is legal)', () => {
		expect(isLegalLifecycleTransition('starting', 'idle')).toBe(true);
	});

	test('boot reconciliation adopts the engine truth (reconciling→streaming|idle)', () => {
		expect(isLegalLifecycleTransition('idle', 'reconciling')).toBe(true);
		expect(isLegalLifecycleTransition('reconciling', 'streaming')).toBe(true);
		expect(isLegalLifecycleTransition('reconciling', 'idle')).toBe(true);
	});

	test('stop_failed can retry the stop or reconcile to idle', () => {
		expect(isLegalLifecycleTransition('stopping', 'stop_failed')).toBe(true);
		expect(isLegalLifecycleTransition('stop_failed', 'stopping')).toBe(true);
		expect(isLegalLifecycleTransition('stop_failed', 'idle')).toBe(true);
	});

	test('an illegal jump is rejected (idle→streaming skips starting)', () => {
		expect(isLegalLifecycleTransition('idle', 'streaming')).toBe(false);
	});

	test('a self-loop is not a transition', () => {
		expect(isLegalLifecycleTransition('idle', 'idle')).toBe(false);
	});

	test('every declared transition uses only real states', () => {
		for (const [from, to] of LEGAL_LIFECYCLE_TRANSITIONS) {
			expect(LIFECYCLE_STATES).toContain(from);
			expect(LIFECYCLE_STATES).toContain(to);
		}
	});
});

describe('retriability — every class has an explicit WHY', () => {
	test('every taxonomy class has a retriability entry with a rationale', () => {
		for (const cls of START_FAILURE_CLASSES) {
			const entry = START_FAILURE_RETRIABILITY[cls];
			expect(entry).toBeDefined();
			expect(typeof entry.why).toBe('string');
			expect(entry.why.length).toBeGreaterThan(10);
		}
	});

	test('engine_unavailable + engine_restarting are always retriable', () => {
		expect(isRetriableStartFailure('engine_unavailable', 'connect')).toBe(true);
		expect(isRetriableStartFailure('engine_restarting', 'connect')).toBe(true);
	});

	test('start_timeout is retriable ONLY on the connect phase', () => {
		expect(isRetriableStartFailure('start_timeout', 'connect')).toBe(true);
		expect(isRetriableStartFailure('start_timeout', 'hello')).toBe(false);
		expect(isRetriableStartFailure('start_timeout', 'subscribe')).toBe(false);
		expect(isRetriableStartFailure('start_timeout', 'start-rpc')).toBe(false);
		expect(isRetriableStartFailure('start_timeout', 'playing-wait')).toBe(false);
	});

	test('protocol_incompatible / start_invalid / engine_internal are never retriable', () => {
		for (const phase of START_FAILURE_PHASES) {
			expect(isRetriableStartFailure('protocol_incompatible', phase)).toBe(false);
			expect(isRetriableStartFailure('start_invalid', phase)).toBe(false);
			expect(isRetriableStartFailure('engine_internal', phase)).toBe(false);
		}
	});
});
