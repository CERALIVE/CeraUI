import { errors, expect, test } from '@playwright/test';

import { focusMainContent } from './helpers/focus-main-content.js';

test('a stalled main focus fails within its step budget and retains page state @a11y @desktop-only', async ({ page }, testInfo) => {
	test.setTimeout(15_000);
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
		main.addEventListener('focus', () => main.setAttribute('data-focus-event', 'received'), { once: true });
	});

	const session = await page.context().newCDPSession(page);
	await session.send('Debugger.enable');
	// A public DOM-event breakpoint holds native focus inside its event dispatch, without a busy loop.
	await session.send('DOMDebugger.setEventListenerBreakpoint', { eventName: 'focus' });
	const paused = new Promise<void>((resolve) => session.once('Debugger.paused', () => resolve()));
	try {
		const focus = focusMainContent(page, 'live 1280x900 stalled-renderer witness');
		await paused;
		await expect(focus).rejects.toBeInstanceOf(errors.TimeoutError);
		await expect(focus).rejects.toThrow('locator.focus: Timeout 5000ms exceeded');
		await expect(focus).rejects.toThrow('JavaScript=timeout, animationFrame=timeout, pageState=timeout');
		const attachment = testInfo.attachments.find((item) => item.name === 'main-focus-state');
		if (attachment?.body === undefined) throw new Error('Missing main-focus-state diagnostic attachment');
		const diagnostic: unknown = JSON.parse(attachment.body.toString('utf8'));
		expect(diagnostic).toMatchObject({
			configuration: 'live 1280x900 stalled-renderer witness',
			viewport: { width: 1280, height: 900 },
			focusTimeoutMs: 5_000,
			before: {
				status: 'ok',
				value: {
					readyState: 'complete',
					appMounted: null,
					viewport: { width: 1280, height: 900, scrollX: 0, scrollY: 0 },
					activeElement: { id: 'previous' },
					target: { connected: true, visible: true, tabindex: '-1', inert: false, ariaHidden: false },
					liveBar: { connected: true, visible: true, testId: 'live-bar' },
					bootShell: {
						name: 'boot-shell',
						present: true,
						inHitTestStack: true,
						element: {
							name: 'boot-shell', tag: 'DIV', role: 'status',
							connected: true, visible: true, hidden: false, inert: false, ariaHidden: false,
							display: 'flex', position: 'fixed', zIndex: '50',
							rect: { x: 0, y: 0, width: 1280, height: 900 },
						},
					},
					ancestors: expect.arrayContaining([expect.objectContaining({ tag: 'BODY', connected: true })]),
					hitTestPoint: { x: expect.any(Number), y: expect.any(Number) },
					elementsAtPoint: expect.arrayContaining([
						expect.objectContaining({ id: 'main-content' }),
						expect.objectContaining({ name: 'boot-shell' }),
					]),
					cockpit: 'live-cockpit',
					surfaces: [
						{ tag: 'DIV', role: 'dialog', visible: false, hidden: true, inert: true, ariaHidden: true, display: 'none', position: 'static', zIndex: 'auto' },
						{ name: 'boot-shell', tag: 'DIV', role: 'status', visible: true },
					],
				},
			},
			liveness: {
				javascript: { status: 'timeout', error: expect.stringContaining('1000ms') },
				animationFrame: { status: 'timeout', error: expect.stringContaining('1000ms') },
			},
			after: { status: 'timeout', error: expect.stringContaining('1000ms') },
		});
	} finally {
		if (!page.isClosed()) {
			await session.send('DOMDebugger.removeEventListenerBreakpoint', { eventName: 'focus' });
			await session.send('Debugger.resume');
			await session.detach();
		}
	}
	await expect(page.locator('#main-content')).toHaveAttribute('data-focus-event', 'received');
});
