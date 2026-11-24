import { expect, test } from '@playwright/test';
import { captureFocusStall } from './helpers/focus-stall-evidence.js';

test('a late renderer trace leaves both CPU samples unlabelled and detaches @a11y @desktop-only', async ({
	page, browser,
}, testInfo) => {
	await page.setContent('<title>Focus diagnostic target</title>');
	// Give Debugger.pause a script to stop, so cleanup must actually resume it.
	await page.evaluate(() => {
		requestAnimationFrame(function pauseWitness() {
			if (document.documentElement.dataset.pauseWitnessDone !== 'true') requestAnimationFrame(pauseWitness);
		});
	});
	const context = page.context();
	const openPageSession = context.newCDPSession.bind(context);
	const openBrowserSession = browser.newBrowserCDPSession.bind(browser);
	const traceComplete = Promise.withResolvers<void>();
	const heldEvents: (() => void)[] = [];
	const deliveredEvents: string[] = [];

	context.newCDPSession = async (target) => {
		const session = await openPageSession(target);
		if (!('emit' in session) || typeof session.emit !== 'function') {
			throw new Error('The CDP session cannot dispatch trace events');
		}
		const emit = session.emit;
		session.emit = (event: string | symbol, ...args: unknown[]) => {
			if (event === 'Tracing.dataCollected' || event === 'Tracing.tracingComplete') {
				heldEvents.push(() => {
					deliveredEvents.push(event);
					emit.call(session, event, ...args);
				});
				if (event === 'Tracing.tracingComplete') traceComplete.resolve();
				return true;
			}
			return emit.call(session, event, ...args) === true;
		};
		return session;
	};
	browser.newBrowserCDPSession = async () => {
		const session = await openBrowserSession();
		const send = session.send.bind(session);
		session.send = async (method, params, options) => {
			const reply = await send(method, params, options);
			// Sampling begins only after the matcher settled. Release Chromium's
			// real trace before handing back the first real process sample.
			if (method === 'SystemInfo.getProcessInfo' && deliveredEvents.length === 0) {
				await traceComplete.promise;
				for (const deliver of heldEvents.splice(0)) deliver();
			}
			return reply;
		};
		return session;
	};

	try {
		const { rendererMatch, processSamples, debugger: debuggerReading, cleanup } = await captureFocusStall(page);
		const labels = processSamples.map((sample) => (
			sample.status === 'ok'
				? sample.value.processes.filter((process) => process.pageRenderer).map((process) => process.pid)
				: sample.status
		));
		await testInfo.attach('late-renderer-trace', {
			body: JSON.stringify({ rendererMatch, deliveredEvents, labels, debuggerReading, cleanup }),
			contentType: 'application/json',
		});
		expect.soft(labels, 'neither CPU sample uses late trace attribution').toEqual([[], []]);
		expect.soft(deliveredEvents).toContain('Tracing.dataCollected');
		expect.soft(deliveredEvents.at(-1)).toBe('Tracing.tracingComplete');
		expect.soft(rendererMatch).toEqual({ status: 'timeout', error: 'Diagnostic deadline exceeded' });
		expect.soft(debuggerReading, 'the collector paused the witness script').toMatchObject({
			status: 'ok',
			value: { pauseRequested: true, callFrames: expect.arrayContaining([
				expect.objectContaining({ functionName: 'pauseWitness' }),
			]) },
		});
		expect.soft(cleanup.find(({ kind }) => kind === 'page'), 'page cleanup').toMatchObject({
			resume: { status: 'ok' }, disable: { status: 'ok' }, detach: { status: 'ok' },
		});
		expect.soft(cleanup.find(({ kind }) => kind === 'browser'), 'browser cleanup').toMatchObject({
			resume: undefined, disable: undefined, detach: { status: 'ok' },
		});
		await expect(page).toHaveTitle('Focus diagnostic target');
		await page.evaluate(() => { document.documentElement.dataset.pauseWitnessDone = 'true'; });
	} finally {
		context.newCDPSession = openPageSession;
		browser.newBrowserCDPSession = openBrowserSession;
	}
});
