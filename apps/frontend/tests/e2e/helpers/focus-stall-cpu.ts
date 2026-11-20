import { expect } from '@playwright/test';
import type { CpuReply, DebuggerRequest, FocusStallMode } from '../fixtures/focus-stall.js';

type CpuProcess = {
	readonly pid: number;
	readonly type: string;
	readonly cpuTimeSeconds: number;
	readonly pageRenderer: boolean;
};
type CpuSample = {
	readonly elapsedMs: number;
	readonly sampledAtMonotonicMs: number;
	readonly processes: readonly CpuProcess[];
};
type CpuDelta = {
	readonly pid: number;
	readonly type: string;
	readonly pageRenderer: boolean;
	readonly cpuTimeSecondsDelta: number;
};
type CpuDiagnostic = {
	readonly outOfPage: {
		readonly processSamples: readonly [
			{ readonly status: 'ok'; readonly value: CpuSample },
			{ readonly status: 'ok'; readonly value: CpuSample },
		];
		readonly cpuInterval: { readonly intervalMs: number; readonly processDeltas: readonly CpuDelta[] };
	};
};
type WireReply = { readonly processInfo: readonly { readonly id: number; readonly type: string; readonly cpuTime: number }[] };

function assertCpuShape(value: unknown): asserts value is CpuDiagnostic {
	expect(value).toMatchObject({
		outOfPage: {
			processSamples: [0, 1].map(() => ({
				status: 'ok',
				value: {
					elapsedMs: expect.any(Number), sampledAtMonotonicMs: expect.any(Number),
					processes: expect.any(Array),
				},
			})),
			cpuInterval: {
				intervalMs: expect.any(Number), processDeltas: expect.any(Array),
				calculation: 'second.elapsedMs - first.elapsedMs',
				order: 'consecutive process samples before Debugger.enable and Debugger.pause',
				collectorPauseOverlapMs: 0,
			},
		},
	});
}

function assertWireReply(value: unknown): asserts value is WireReply {
	expect(value).toMatchObject({ processInfo: expect.any(Array) });
}

export function expectFocusStallCpu(
	diagnostic: unknown, standIn: FocusStallMode,
	replies: readonly CpuReply[], debuggerRequests: readonly DebuggerRequest[],
): void {
	assertCpuShape(diagnostic);
	const threads = process.platform === 'linux' ? {
		status: 'ok',
		value: expect.arrayContaining([expect.objectContaining({
			tid: expect.any(Number),
			stat: {
				status: 'ok',
				value: {
					state: expect.stringMatching(/^[RSDZTtXxKWPI]$/),
					userTicks: expect.any(Number), systemTicks: expect.any(Number),
				},
			},
		})]),
	} : { status: 'error' };
	expect(diagnostic).toMatchObject({
		outOfPage: {
			processSamples: [0, 1].map(() => ({
				status: 'ok',
				value: {
					elapsedMs: expect.any(Number),
					processes: expect.arrayContaining([
						expect.objectContaining({
							pid: expect.any(Number), type: 'browser', cpuTimeSeconds: expect.any(Number),
							pageRenderer: false, threads: expect.objectContaining(threads),
						}),
						expect.objectContaining({
							pid: expect.any(Number), type: 'renderer', cpuTimeSeconds: expect.any(Number),
							pageRenderer: standIn === 'dialog' ? expect.any(Boolean) : true,
							threads: expect.objectContaining(threads),
						}),
					]),
				},
			})),
		},
	});
	expect(replies).toHaveLength(2);
	expect(debuggerRequests.length).toBeGreaterThan(0);
	const firstDebuggerAt = Math.min(...debuggerRequests.map((request) => request.at));
	const [first, second] = diagnostic.outOfPage.processSamples.map((sample) => sample.value);
	const interval = diagnostic.outOfPage.cpuInterval;
	expect(Number.isFinite(interval.intervalMs)).toBe(true);
	expect(interval.intervalMs).toBeGreaterThan(0);
	expect(interval.intervalMs).toBe(second.elapsedMs - first.elapsedMs);
	expect(interval.intervalMs).toBe(second.sampledAtMonotonicMs - first.sampledAtMonotonicMs);
	const observed = replies.map((reply) => {
		assertWireReply(reply.value);
		return { ...reply, value: reply.value };
	});
	for (const [index, sample] of [first, second].entries()) {
		const reply = observed[index];
		expect(sample.processes.some((p) => p.type === 'browser' && p.cpuTimeSeconds > 0)).toBe(true);
		expect(sample.processes.some((p) => p.type === 'renderer' && p.cpuTimeSeconds > 0)).toBe(true);
		expect(sample.sampledAtMonotonicMs).toBeGreaterThanOrEqual(reply.repliedAt);
		expect(sample.sampledAtMonotonicMs).toBeLessThan(firstDebuggerAt);
		expect(reply.repliedAt).toBeLessThan(firstDebuggerAt);
		for (const p of sample.processes) {
			expect(Number.isInteger(p.pid) && p.pid > 0).toBe(true);
			expect(Number.isFinite(p.cpuTimeSeconds) && p.cpuTimeSeconds >= 0).toBe(true);
			const wire = reply.value.processInfo.find((item) => item.id === p.pid);
			expect(wire).toMatchObject({ id: p.pid, type: p.type, cpuTime: p.cpuTimeSeconds });
		}
	}
	expect(first.sampledAtMonotonicMs).toBeLessThanOrEqual(observed[1].requestedAt);
	expect(observed[1].repliedAt - observed[0].repliedAt).toBeGreaterThan(0);
	// Derive deltas from the real CDP replies, not from the collector's labels.
	const expectedDeltas = observed[1].value.processInfo.flatMap((current) => {
		const reported = second.processes.find((p) => p.pid === current.id);
		const previous = observed[0].value.processInfo.find((p) => p.id === current.id && p.type === current.type);
		return reported && previous ? [{
			pid: current.id, type: current.type, pageRenderer: reported.pageRenderer,
			cpuTimeSecondsDelta: current.cpuTime - previous.cpuTime,
		}] : [];
	});
	expect(expectedDeltas.some((p) => p.type === 'browser')).toBe(true);
	expect(expectedDeltas.some((p) => p.type === 'renderer')).toBe(true);
	expect(interval.processDeltas).toEqual(expectedDeltas);
	for (const delta of interval.processDeltas) {
		expect(Number.isFinite(delta.cpuTimeSecondsDelta) && delta.cpuTimeSecondsDelta >= 0).toBe(true);
	}
}
