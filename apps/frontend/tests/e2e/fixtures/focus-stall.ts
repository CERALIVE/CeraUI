import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { errors } from '@playwright/test';
import type { Browser, CDPSession, Dialog, Page, TestInfo } from '@playwright/test';

export const focusStallModes = [
	'event', 'function', 'dialog', 'attachment-error', 'oversize', 'collector-pause', 'json-attachment-error',
] as const;
export type FocusStallMode = typeof focusStallModes[number];
export type CpuReply = { readonly requestedAt: number; readonly repliedAt: number; readonly value: unknown };
export type DebuggerRequest = { readonly at: number; readonly method: 'Debugger.enable' | 'Debugger.pause' };
type FocusStallFixture = {
	readonly stalled: Promise<void>;
	readonly collectorSessions: readonly CDPSession[];
	readonly cpuReplies: readonly CpuReply[];
	readonly debuggerRequests: readonly DebuggerRequest[];
	readonly releaseModal: () => Promise<boolean>;
	readonly dispose: () => Promise<void>;
};

export async function createFocusStallFixture(
	page: Page, browser: Browser, testInfo: TestInfo, standIn: FocusStallMode,
): Promise<FocusStallFixture> {
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.setContent(`
		<button id="previous">Previous focus</button>
		<main id="main-content" tabindex="-1" style="min-height: 100px">
			<div data-testid="live-cockpit">Live</div>
		</main>
		<div data-testid="live-bar" style="position: fixed; bottom: 0; left: 0; right: 0; height: 44px">Stop</div>
		<div role="dialog" hidden inert aria-hidden="true">Inactive overlay</div>
		<div data-boot-shell class="boot-shell" aria-busy="true" aria-live="polite" role="status"
			style="display: flex; position: fixed; inset: 0; z-index: 50"></div>
	`);
	await page.locator('#previous').focus();
	await page.locator('#main-content').evaluate((main) => {
		main.onfocus = function focusWitness() {
			main.setAttribute('data-focus-event', 'received');
		};
	});
	if (standIn === 'oversize') {
		await page.evaluate(() => {
			const canvas = document.createElement('canvas');
			canvas.width = canvas.height = 512;
			const context = canvas.getContext('2d');
			if (context === null) throw new Error('Missing canvas context');
			const image = context.createImageData(512, 512);
			let seed = 1;
			for (let i = 0; i < image.data.length; i += 4) {
				for (let channel = 0; channel < 3; channel++) {
					seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
					image.data[i + channel] = seed >>> 24;
				}
				image.data[i + 3] = 255;
			}
			context.putImageData(image, 0, 0);
			document.querySelector('[data-boot-shell]')?.append(canvas);
		});
	}
	const session = await page.context().newCDPSession(page);
	await session.send('Debugger.enable');
	let dialog: Dialog | undefined;
	let release: (() => Promise<unknown>) | undefined;
	if (standIn !== 'function' && standIn !== 'dialog') {
		// Hold native focus dispatch without a busy loop.
		await session.send('DOMDebugger.setEventListenerBreakpoint', { eventName: 'focus' });
		release = () => session.send('DOMDebugger.removeEventListenerBreakpoint', { eventName: 'focus' });
	} else if (standIn === 'function') {
		const { result } = await session.send('Runtime.evaluate', { expression: 'document.querySelector("#main-content").onfocus' });
		if (result.objectId === undefined) throw new Error('Missing focus listener object');
		const { breakpointId } = await session.send('Debugger.setBreakpointOnFunctionCall', { objectId: result.objectId });
		release = () => session.send('Debugger.removeBreakpoint', { breakpointId });
	} else {
		await page.locator('#main-content').evaluate((main) => {
			main.addEventListener('focus', () => alert('Focus diagnostic witness'), { once: true });
		});
	}
	const paused = new Promise<void>((resolve) => session.once('Debugger.paused', () => resolve()));
	const dialogOpened = new Promise<void>((resolve) => page.once('dialog', (opened) => { dialog = opened; resolve(); }));
	const context = page.context();
	const createPageSession = context.newCDPSession.bind(context);
	const createBrowserSession = browser.newBrowserCDPSession.bind(browser);
	const attach = testInfo.attach.bind(testInfo);
	// Observe real replies and request times; never substitute a protocol response.
	const collectorSessions: CDPSession[] = [];
	const cpuReplies: CpuReply[] = [];
	const debuggerRequests: DebuggerRequest[] = [];
	const observe = (created: CDPSession) => {
		collectorSessions.push(created);
		const send = created.send.bind(created);
		created.send = (method, params, options) => {
			const requestedAt = performance.now();
			if (method === 'Debugger.enable' || method === 'Debugger.pause') {
				debuggerRequests.push({ at: requestedAt, method });
			}
			if (standIn === 'event' && method === 'Tracing.start') {
				// Deliver the real reply after the old 250 ms cap but within the matcher.
				const reply = Promise.all([send(method, params, { timeout: 1_000 }), delay(350)])
					.then(([value]) => value);
				const deadline = new AbortController();
				return Promise.race([
					reply,
					delay(options?.timeout ?? 1_000, undefined, { signal: deadline.signal })
						.then(() => { throw new errors.TimeoutError('Tracing.start reply held past its deadline'); }),
				]).finally(() => deadline.abort());
			}
			return send(method, params, options).then((value) => {
				if (method === 'SystemInfo.getProcessInfo') {
					cpuReplies.push({ requestedAt, repliedAt: performance.now(), value: structuredClone(value) });
				}
				return value;
			});
		};
	};
	context.newCDPSession = async (target) => {
		const created = await createPageSession(target);
		observe(created);
		if (standIn === 'collector-pause') {
			await release?.();
			release = undefined;
			await session.send('Debugger.resume');
			await page.evaluate(() => {
				requestAnimationFrame(function collectorPauseWitness() {
					if (document.documentElement.dataset.collectorPauseDone === 'true') return;
					requestAnimationFrame(collectorPauseWitness);
				});
			});
		}
		return created;
	};
	browser.newBrowserCDPSession = async () => {
		const created = await createBrowserSession();
		observe(created);
		return created;
	};
	if (standIn === 'attachment-error' || standIn === 'json-attachment-error') {
		testInfo.attach = async (name, options) => {
			const rejected = standIn === 'attachment-error' ? 'main-focus-cdp-screenshot' : 'main-focus-state';
			if (name === rejected) {
				const error = new Error('Controlled diagnostic attachment failure');
				error.name = standIn === 'attachment-error' ? 'ScreenshotAttachmentWitnessError' : 'JsonAttachmentWitnessError';
				throw error;
			}
			return attach(name, options);
		};
	}
	const releaseModal = async () => {
		if (dialog === undefined) return false;
		await dialog.dismiss();
		dialog = undefined;
		return true;
	};
	return {
		stalled: standIn === 'dialog' ? dialogOpened : paused,
		collectorSessions, cpuReplies, debuggerRequests, releaseModal,
		dispose: async () => {
			context.newCDPSession = createPageSession;
			browser.newBrowserCDPSession = createBrowserSession;
			testInfo.attach = attach;
			if (!page.isClosed()) {
				await release?.();
				await releaseModal();
				await session.send('Debugger.disable');
				await session.detach();
			}
		},
	};
}
