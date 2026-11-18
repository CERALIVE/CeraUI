import { errors, expect, test } from '@playwright/test';
import { createFocusStallFixture, focusStallModes } from './fixtures/focus-stall.js';
import { focusMainContent } from './helpers/focus-main-content.js';
import { expectFocusStallCpu } from './helpers/focus-stall-cpu.js';

for (const standIn of focusStallModes) {
test(`a stalled main focus fails within its step budget and retains page state (${standIn}) @a11y @desktop-only`, async ({ page, browser }, testInfo) => {
	test.setTimeout(15_000);
	const fixture = await createFocusStallFixture(page, browser, testInfo, standIn);
	try {
		const focus = focusMainContent(page, 'live 1280x900 stalled-renderer witness');
		await fixture.stalled;
		await expect(focus).rejects.toBeInstanceOf(errors.TimeoutError);
		await expect(focus).rejects.toThrow('locator.focus: Timeout 5000ms exceeded');
		await expect(focus).rejects.toThrow('JavaScript=timeout, animationFrame=timeout, pageState=timeout');
		const attachment = testInfo.attachments.find((item) => item.name === 'main-focus-state');
		let diagnostic: unknown;
		if (standIn === 'json-attachment-error') {
			expect(attachment).toBeUndefined();
			await expect(focus).rejects.toThrow('main-focus-state attachment=error JsonAttachmentWitnessError; diagnostic JSON unavailable.');
		} else {
			if (attachment?.body === undefined) throw new Error('Missing main-focus-state diagnostic attachment');
			diagnostic = JSON.parse(attachment.body.toString('utf8'));
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
		expect(diagnostic).toMatchObject({
			outOfPage: {
				status: 'ok',
				budgetMs: 2_500,
				rendererMatch: standIn === 'dialog' ? {
					status: expect.stringMatching(/^(ok|timeout|error)$/),
				} : {
					status: 'ok',
					value: { frameId: expect.any(String), rendererPid: expect.any(Number) },
				},
				debugger: standIn === 'dialog'
					? { status: 'timeout' }
					: { status: 'ok', value: { reason: expect.any(String), callFrames: expect.any(Array) } },
				cleanup: expect.arrayContaining([
					expect.objectContaining({
						kind: 'page',
						detach: expect.objectContaining({
							status: standIn === 'dialog' ? expect.stringMatching(/^(ok|timeout)$/) : 'ok',
						}),
					}),
					expect.objectContaining({ kind: 'browser', detach: { status: 'ok' } }),
				]),
			},
		});
			expectFocusStallCpu(diagnostic, standIn, fixture.cpuReplies, fixture.debuggerRequests);
		}
		const png = testInfo.attachments.find((item) => item.name === 'main-focus-cdp-screenshot');
		if (standIn === 'attachment-error') {
			expect(png).toBeUndefined();
			expect(diagnostic).toMatchObject({
				outOfPage: {
					screenshot: {
						status: 'error', error: 'ScreenshotAttachmentWitnessError',
						capture: { status: 'ok', bytes: expect.any(Number), limitBytes: 262_144 },
						attachment: { status: 'error', error: 'ScreenshotAttachmentWitnessError' },
					},
				},
			});
		} else if (standIn === 'oversize') {
			expect(png).toBeUndefined();
			expect(diagnostic).toMatchObject({
				outOfPage: {
					screenshot: {
						status: 'truncated', truncated: true, originalBytes: expect.any(Number),
						bytes: 0, limitBytes: 262_144,
					},
				},
			});
		} else if (standIn === 'dialog') {
			expect(diagnostic).toMatchObject({
				outOfPage: { screenshot: { status: expect.stringMatching(/^(ok|timeout|error)$/) } },
			});
		} else {
			expect(png?.body).toBeDefined();
		}
		if (png?.body !== undefined) {
			expect(png.contentType).toBe('image/png');
			expect([...png.body.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
			expect(png.body.length).toBeLessThanOrEqual(262_144);
			if (standIn !== 'json-attachment-error') {
				expect(diagnostic).toMatchObject({
					outOfPage: { screenshot: { status: 'ok', attachment: 'main-focus-cdp-screenshot', bytes: png.body.length } },
				});
			}
		}
		if (standIn === 'function' || standIn === 'collector-pause') {
			expect(diagnostic).toMatchObject({
				outOfPage: {
					debugger: {
						value: {
							callFrames: expect.arrayContaining([expect.objectContaining({
								functionName: standIn === 'collector-pause' ? 'collectorPauseWitness' : 'focusWitness',
								url: expect.any(String),
								scriptId: expect.any(String),
								lineNumber: expect.any(Number),
								columnNumber: expect.any(Number),
							})]),
						},
					},
				},
			});
		}
		if (standIn === 'collector-pause') {
			expect(diagnostic).toMatchObject({
				outOfPage: { debugger: { value: { pauseRequested: true } } },
			});
		}
		await test.step('Attach independently observed CPU replies', () => testInfo.attach('main-focus-cpu-witness', {
			body: JSON.stringify({
				replies: fixture.cpuReplies, debuggerRequests: fixture.debuggerRequests,
				jsonDelivered: attachment?.body !== undefined,
			}),
			contentType: 'application/json',
		}), { timeout: 1_000 });
		// Prove collector cleanup before the observer's teardown can resume anything.
		const modalReleasedBeforeProof = await fixture.releaseModal();
		expect(fixture.collectorSessions).toHaveLength(2);
		for (const collected of fixture.collectorSessions) {
			await expect.poll(async () => {
				try {
					await collected.send('Target.getTargetInfo', {}, { timeout: 250 });
					return 'open';
				} catch (error) {
					if (error instanceof Error && /Session closed|Target page, context or browser has been closed/.test(error.message)) return 'closed';
					throw error;
				}
			}, { timeout: 1_000 }).toBe('closed');
		}
		await expect(page.locator('#main-content')).toHaveAttribute('data-focus-event', 'received', { timeout: 1_000 });
		await test.step('Renderer answers before observer cleanup', () => page.evaluate(() => {
			document.documentElement.dataset.collectorPauseDone = 'true';
		}), { timeout: 1_000 });
		await test.step('Attach independent collector cleanup proof', () => testInfo.attach('main-focus-cleanup-witness', {
			body: JSON.stringify({
				closedCollectorSessions: fixture.collectorSessions.length,
				rendererAnsweredBeforeObserverCleanup: true,
				modalReleasedBeforeProof,
			}),
			contentType: 'application/json',
		}), { timeout: 1_000 });
	} finally {
		await fixture.dispose();
	}
	await expect(page.locator('#main-content')).toHaveAttribute('data-focus-event', 'received');
});
}
