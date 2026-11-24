import { readFile, readdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import type { CDPSession, Page } from '@playwright/test';

type Reading<T> = { status: 'ok'; value: T } | { status: 'timeout' | 'error'; error: string };
type Cleanup = {
	kind: 'page' | 'browser';
	resume?: Reading<unknown>;
	disable?: Reading<unknown>;
	detach: Reading<void>;
};

async function bounded<T>(read: () => Promise<T>, timeoutMs: number): Promise<Reading<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			read().then((value) => ({ status: 'ok' as const, value })),
			new Promise<Reading<T>>((resolve) => {
				timer = setTimeout(() => resolve({ status: 'timeout', error: 'Diagnostic deadline exceeded' }), timeoutMs);
			}),
		]);
	} catch (error) {
		// Protocol errors can include evaluated source; retain only their class.
		return {
			status: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'error',
			error: error instanceof Error ? error.name : 'UnknownError',
		};
	} finally {
		clearTimeout(timer);
	}
}

export function diagnosticUrl(value: string): string {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}${url.pathname}` : url.protocol;
	} catch {
		return '';
	}
}

async function threadState(pid: number) {
	const tids = await readdir(`/proc/${pid}/task`);
	return Promise.all(tids.map(async (tid) => {
		const stat = await bounded(async () => {
			const raw = await readFile(`/proc/${pid}/task/${tid}/stat`, 'utf8');
			// comm is parenthesized and can contain spaces or closing parentheses.
			const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
			return { state: fields[0], userTicks: Number(fields[11]), systemTicks: Number(fields[12]) };
		}, 200);
		return { tid: Number(tid), stat };
	}));
}

export async function captureFocusStall(page: Page) {
	const started = performance.now();
	const deadline = started + 2_500;
	const read = <T>(operation: () => Promise<T>, limit = 300) =>
		bounded(operation, Math.max(1, Math.min(limit, deadline - performance.now())));
	const sessions: { kind: 'page' | 'browser'; session: CDPSession }[] = [];
	// The returned array is filled by finally before the caller receives the evidence.
	const cleanup: Cleanup[] = [];
	let finished = false;
	const open = async (kind: 'page' | 'browser', create: () => Promise<CDPSession>) => read(async () => {
		const session = await create();
		if (finished) {
			await bounded(() => session.detach(), 150);
		} else {
			sessions.push({ kind, session });
		}
		return session;
	});
	const browser = page.context().browser();
	try {
		const [pageSession, browserSession] = await Promise.all([
			open('page', () => page.context().newCDPSession(page)),
			open('browser', async () => {
				if (browser === null) throw new Error('Browser unavailable');
				return browser.newBrowserCDPSession();
			}),
		]);
		const session = pageSession.status === 'ok' ? pageSession.value : undefined;
		const host = browserSession.status === 'ok' ? browserSession.value : undefined;
		const target = session === undefined ? pageSession : await read(() => session.send('Target.getTargetInfo'));
		// Both commands and trace delivery spend the same matcher budget.
		const matchDeadline = Math.min(deadline, performance.now() + 600);
		const matchRemaining = () => Math.max(1, Math.ceil(matchDeadline - performance.now()));
		const rendererMatch = await read(async () => {
			if (session === undefined || target.status !== 'ok' || !('targetInfo' in target.value)) throw new Error('Page target unavailable');
			const frameId = target.value.targetInfo.targetId;
			let rendererPid: number | null = null;
			// Browser-owned trace metadata maps the exact page frame to its OS PID,
			// unlike choosing an arbitrary renderer from getProcessInfo.
			session.on('Tracing.dataCollected', ({ value }) => {
				for (const event of value) {
					if (event.name !== 'TracingStartedInBrowser') continue;
					const args: unknown = event.args;
					if (typeof args !== 'object' || args === null || !('data' in args)) continue;
					const data = args.data;
					if (typeof data !== 'object' || data === null || !('frames' in data)) continue;
					const frames: unknown = data.frames;
					if (!Array.isArray(frames)) continue;
					for (const frame of frames) {
						if (typeof frame === 'object' && frame !== null &&
							frame.frame === frameId && typeof frame.processId === 'number' && Number.isInteger(frame.processId)) {
							rendererPid = frame.processId;
						}
					}
				}
			});
			await session.send('Tracing.start', {
				traceConfig: { includedCategories: ['disabled-by-default-devtools.timeline'], excludedCategories: ['*'] },
			}, { timeout: matchRemaining() });
			const complete = new Promise<void>((resolve) => session.once('Tracing.tracingComplete', () => resolve()));
			await session.send('Tracing.end', {}, { timeout: matchRemaining() });
			await complete;
			if (performance.now() >= matchDeadline) throw new DOMException('Diagnostic deadline exceeded', 'TimeoutError');
			return { frameId, rendererPid };
		}, matchRemaining());
		const rendererPid = rendererMatch.status === 'ok' ? rendererMatch.value.rendererPid : null;
		const sample = () => read(async () => {
			if (host === undefined) throw new Error('Browser session unavailable');
			const { processInfo } = await host.send('SystemInfo.getProcessInfo', {}, { timeout: 250 });
			const processes = processInfo.filter((item) => item.type === 'browser' || item.type === 'renderer');
			const sampledAtMonotonicMs = performance.now();
			return {
				elapsedMs: sampledAtMonotonicMs - started,
				sampledAtMonotonicMs,
				processes: await Promise.all(processes.map(async ({ id, type, cpuTime }) => ({
					pid: id, type, cpuTimeSeconds: cpuTime,
					pageRenderer: id === rendererPid,
					threads: await read(() => threadState(id), 250),
				}))),
			};
		}, 400);
		const first = await sample();
		const second = await sample();
		const cpuInterval = {
			intervalMs: first.status === 'ok' && second.status === 'ok'
				? second.value.elapsedMs - first.value.elapsedMs : null,
			calculation: 'second.elapsedMs - first.elapsedMs',
			order: 'consecutive process samples before Debugger.enable and Debugger.pause',
			collectorPauseOverlapMs: 0,
			processDeltas: first.status === 'ok' && second.status === 'ok'
				? second.value.processes.flatMap((current) => {
					const previous = first.value.processes.find((item) => item.pid === current.pid && item.type === current.type);
					return previous ? [{
						pid: current.pid, type: current.type, pageRenderer: current.pageRenderer,
						cpuTimeSecondsDelta: current.cpuTimeSeconds - previous.cpuTimeSeconds,
					}] : [];
				}) : null,
		};
		// Capture before our own pause can block screenshot delivery.
		const screenshot = await read(async () => {
			if (session === undefined) throw new Error('Page session unavailable');
			const { data } = await session.send('Page.captureScreenshot', { format: 'png' }, { timeout: 600 });
			const limitBytes = 262_144;
			const bytes = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
			// Reject oversized captures before allocating or attaching their decoded bytes.
			return bytes > limitBytes
				? { truncated: true as const, bytes, limitBytes }
				: { truncated: false as const, bytes, limitBytes, body: Buffer.from(data, 'base64') };
		}, 650);
		const debuggerReading = await read(async () => {
				if (session === undefined) throw new Error('Page session unavailable');
				let pauseRequested = false;
				let paused: { reason: string; pauseRequested: boolean; callFrames: { functionName: string; url: string; scriptId: string; lineNumber: number; columnNumber: number | undefined }[] } | undefined;
				const pause = new Promise<void>((resolve) => {
					session.on('Debugger.paused', (event) => {
						paused = {
							reason: event.reason,
							pauseRequested,
							callFrames: event.callFrames.map((frame) => ({
								functionName: frame.functionName,
								url: diagnosticUrl(frame.url),
								scriptId: frame.location.scriptId,
								lineNumber: frame.location.lineNumber,
								columnNumber: frame.location.columnNumber,
							})),
						};
						resolve();
					});
				});
				await session.send('Debugger.enable', {}, { timeout: 300 });
				if (paused === undefined) {
					pauseRequested = true;
					await session.send('Debugger.pause', {}, { timeout: 300 });
				}
				await pause;
				return paused;
			}, 800);
		return {
			status: 'ok' as const,
			budgetMs: 2_500,
			rendererMatch,
			processSamples: [first, second],
			cpuInterval,
			debugger: debuggerReading,
			screenshot,
			cleanup,
		};
	} finally {
		finished = true;
		await Promise.all(sessions.map(async ({ kind, session }) => {
			const resume = kind === 'page'
				? await bounded(() => session.send('Debugger.resume', {}, { timeout: 100 }), 150) : undefined;
			const disable = kind === 'page'
				? await bounded(() => session.send('Debugger.disable', {}, { timeout: 100 }), 150) : undefined;
			const detach = await bounded(() => session.detach(), 150);
			cleanup.push({ kind, resume, disable, detach });
		}));
	}
}
