import { errors, expect, type Page, test } from '@playwright/test';

export async function focusMainContent(page: Page, configuration: string): Promise<void> {
	const probe = async <T>(name: string, read: () => Promise<T>) => {
		try {
			return { status: 'ok' as const, value: await test.step(name, read, { timeout: 1_000 }) };
		} catch (error) {
			return {
				status: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' as const : 'error' as const,
				error: error instanceof Error ? error.message : String(error),
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
			url: location.href,
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
			const javascript = await probe('Renderer JavaScript liveness', () => page.evaluate(() => performance.now()));
			const animationFrame = await probe('Renderer animation-frame liveness', () => page.evaluate(
				() => new Promise<number>((resolve) => requestAnimationFrame(resolve)),
			));
			const after = await readState();
			error.message += `\n${configuration}: JavaScript=${javascript.status}, animationFrame=${animationFrame.status}, pageState=${after.status}; see main-focus-state.`;
			// A stalled renderer cannot answer another DOM read; retain the last responsive state too.
			await test.info().attach('main-focus-state', {
				body: JSON.stringify({
					configuration,
					focusTimeoutMs: 5_000,
					url: page.url(),
					viewport: page.viewportSize(),
					before,
					liveness: { javascript, animationFrame },
					after,
				}, null, 2),
				contentType: 'application/json',
			});
			throw error;
		}
		await expect(main).toBeFocused();
	});
}
