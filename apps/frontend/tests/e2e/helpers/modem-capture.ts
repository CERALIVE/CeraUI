import type { Page } from '@playwright/test';

/**
 * Shared browser-side modem-broadcast capture for the backend-scenario fixture
 * self-tests. Extracted here so the modem-pin-locked (override) and the default
 * (multi-modem-wifi) proofs — which MUST live in separate spec files because a
 * worker-scoped `test.use({ backendScenario })` override forces its own worker
 * and can only be set at file top level — share ONE capture implementation.
 *
 * `buildModemsMessage()` rides the `status` event (backend modem-status.ts), so
 * every modems payload arrives as `frame.status.modems`; we merge per-modem-id so
 * a later status-only frame never clobbers the full entry that carried `sim_lock`.
 */

/**
 * Serialized into the page via `page.addInitScript`, so it MUST be fully
 * self-contained — no outer-scope references (Playwright injects `fn.toString()`).
 */
export function installModemCapture(): void {
	const w = window as unknown as {
		__modems?: Record<string, { sim_lock?: { required?: string } }>;
		__modemCaptureInstalled?: boolean;
		WebSocket: typeof WebSocket;
	};
	if (w.__modemCaptureInstalled) return;
	w.__modemCaptureInstalled = true;
	w.__modems = {};
	const Real = w.WebSocket;
	class HookedWS extends Real {
		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols);
			this.addEventListener('message', (ev: MessageEvent) => {
				try {
					const frame = JSON.parse(ev.data);
					const modems = frame?.status?.modems;
					if (modems && typeof modems === 'object') {
						const cur = w.__modems ?? {};
						const next: Record<string, { sim_lock?: { required?: string } }> = {
							...cur,
						};
						for (const [id, entry] of Object.entries(modems)) {
							next[id] = { ...(cur[id] ?? {}), ...(entry as object) };
						}
						w.__modems = next;
					}
				} catch {
					/* non-JSON frame */
				}
			});
		}
	}
	w.WebSocket = HookedWS as unknown as typeof WebSocket;
}

/** Read the captured `sim_lock.required` for modem 0, or null if absent. */
export function readModem0Lock(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		const w = window as unknown as {
			__modems?: Record<string, { sim_lock?: { required?: string } }>;
		};
		return w.__modems?.['0']?.sim_lock?.required ?? null;
	});
}

/** True once the modems snapshot has delivered modem 0 (so an absent lock is a real negative). */
export function modem0Present(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const w = window as unknown as { __modems?: Record<string, unknown> };
		return Boolean(w.__modems?.['0']);
	});
}
