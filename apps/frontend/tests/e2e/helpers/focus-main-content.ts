import { errors, expect, type Page, test } from '@playwright/test';
import { captureFocusStall, diagnosticUrl } from './focus-stall-evidence.js';

export async function focusMainContent(page: Page, configuration: string): Promise<void> {
	const probe = async <T>(name: string, read: () => Promise<T>) => {
		try {
			return { status: 'ok' as const, value: await test.step(name, read, { timeout: 1_000 }) };
		} catch (error) {
			return {
				status: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' as const : 'error' as const,
				error: error instanceof Error ? error.message : String(error),
				errorName: error instanceof Error ? error.name : 'UnknownError',
			};
		}
	};
	const readState = () => probe('Capture main focus state', () => page.evaluate(() => {
		const describe = (element: Element | null) => {
			if (element === null) return null;
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return {
				name: element.hasAttribute('data-boot-shell') ? 'boot-shell' : null,
				tag: element.tagName,
				id: element.id,
				testId: element.getAttribute('data-testid'),
				role: element.getAttribute('role'),
				connected: element.isConnected,
				visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse',
				tabindex: element.getAttribute('tabindex'),
				hidden: element.closest('[hidden]') !== null,
				inert: element.closest('[inert]') !== null,
				ariaHidden: element.closest('[aria-hidden="true"]') !== null,
				display: style.display,
				position: style.position,
				zIndex: style.zIndex,
				visibility: style.visibility,
				rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
			};
		};
		const target = document.querySelector('#main-content');
		const ancestors = [];
		for (let ancestor = target?.parentElement; ancestor; ancestor = ancestor.parentElement) {
			ancestors.push(describe(ancestor));
		}
		const rect = target?.getBoundingClientRect();
		const point = rect && { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
		const elementsAtPoint = point ? document.elementsFromPoint(point.x, point.y) : [];
		const bootShell = document.querySelector('[data-boot-shell]');
		return {
			url: location.protocol === 'http:' || location.protocol === 'https:'
				? `${location.origin}${location.pathname}` : location.protocol,
			readyState: document.readyState,
			online: navigator.onLine,
			appMounted: '__ceraAppMounted' in window ? window.__ceraAppMounted : null,
			viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
			activeElement: describe(document.activeElement),
			target: describe(target),
			liveBar: describe(document.querySelector('[data-testid="live-bar"]')),
			bootShell: {
				name: 'boot-shell',
				present: bootShell !== null,
				element: describe(bootShell),
				inHitTestStack: bootShell !== null && elementsAtPoint.includes(bootShell),
			},
			ancestors,
			hitTestPoint: point ?? null,
			elementsAtPoint: elementsAtPoint.map(describe),
			surfaces: [...document.querySelectorAll(
				'[role="dialog"], [aria-modal="true"], [data-boot-shell], form:has(#password), [data-testid="updating-overlay"], [data-testid="offline-page"], [data-testid="auth-timeout"], [data-testid="auth-check-spinner"], #js-failed, #pwa-preloader, #offline-fallback',
			)].map(describe),
			cockpit: document.querySelector('[data-testid="idle-cockpit"], [data-testid="live-cockpit"]')?.getAttribute('data-testid') ?? null,
		};
	}));

	await test.step(`Focus main content: ${configuration}`, async () => {
		const before = await readState();
		const main = page.locator('#main-content');
		await expect(main).toBeVisible();
		await expect(main).toHaveAttribute('tabindex', '-1');
		try {
			await main.focus({ timeout: 5_000 });
		} catch (error) {
			if (!(error instanceof errors.TimeoutError)) throw error;
			try {
				const [javascript, animationFrame, after] = await Promise.all([
					probe('Renderer JavaScript liveness', () => page.evaluate(() => performance.now())),
					probe('Renderer animation-frame liveness', () => page.evaluate(
						() => new Promise<number>((resolve) => requestAnimationFrame(resolve)),
					)),
					readState(),
				]);
				const outOfPage = await captureFocusStall(page);
				const screenshot = await (async () => {
					if (outOfPage.screenshot.status !== 'ok') return outOfPage.screenshot;
					const captured = outOfPage.screenshot.value;
					if (captured.truncated) return {
						status: 'truncated' as const, truncated: true,
						originalBytes: captured.bytes, bytes: 0, limitBytes: captured.limitBytes,
					};
					const attachment = await probe('Attach CDP focus screenshot', () => test.info().attach('main-focus-cdp-screenshot', {
						body: captured.body,
						contentType: 'image/png',
					}));
					return attachment.status === 'ok'
						? {
							status: 'ok' as const, attachment: 'main-focus-cdp-screenshot',
							bytes: captured.bytes, limitBytes: captured.limitBytes, truncated: false,
						}
						: {
							status: attachment.status, error: attachment.errorName,
							capture: { status: 'ok', bytes: captured.bytes, limitBytes: captured.limitBytes },
							attachment: { status: attachment.status, error: attachment.errorName },
						};
				})();
				error.message += `\n${configuration}: JavaScript=${javascript.status}, animationFrame=${animationFrame.status}, pageState=${after.status}; see main-focus-state.`;
				// A stalled renderer cannot answer another DOM read; retain the last responsive state too.
				const jsonAttachment = await probe('Attach main focus state', () => test.info().attach('main-focus-state', {
					body: JSON.stringify({
						configuration,
						focusTimeoutMs: 5_000,
						url: diagnosticUrl(page.url()),
						viewport: page.viewportSize(),
						before,
						liveness: { javascript, animationFrame },
						after,
						outOfPage: {
							...outOfPage,
							screenshot,
						},
					}, null, 2),
					contentType: 'application/json',
				}));
				if (jsonAttachment.status !== 'ok') {
					error.message += `\nmain-focus-state attachment=${jsonAttachment.status} ${jsonAttachment.errorName}; diagnostic JSON unavailable.`;
				}
			} finally {
				// Attachment, protocol and teardown failures must never replace the focus timeout.
				throw error;
			}
		}
		await expect(main).toBeFocused();
	});
}
