/**
 * Experience-polish spec (Wave 10) — @functional.
 *
 * Covers the Live destination's idle ingest empty-state (Todo 29): when a server
 * is configured but the stream is idle with no bonded links, the ingest area
 * shows a calm, informational card pointing to Network — with NO live telemetry
 * values (Live-Data Discipline). The HUD accessibility checks (Todo 30) live in
 * a11y.spec.ts, where the dedicated axe/a11y CI gate runs.
 */
import { expect, test as base } from './fixtures/index.js';
import { ShellPage } from './pages/shell.js';

// Pin the Live view into its idle-with-server state deterministically, regardless
// of the dev backend's config.json or what a concurrent spec broadcasts:
//   • force every incoming status frame to is_streaming:false (idle), and
//   • ensure every config frame carries an srtla_addr (a server IS configured, so
//     the view is past the "choose a destination" empty-state and renders ingest).
// Same page-fixture override pattern as live.spec.ts.
function pinIdleWithServer(): void {
	const Native = window.WebSocket;
	class Hooked extends Native {
		set onmessage(handler: ((this: WebSocket, ev: MessageEvent) => unknown) | null) {
			if (handler === null) {
				super.onmessage = handler;
				return;
			}
			super.onmessage = (ev: MessageEvent) => {
				try {
					const parsed = JSON.parse(ev.data);
					let mutated = false;
					if (parsed?.status?.is_streaming) {
						parsed.status.is_streaming = false;
						mutated = true;
					}
					if (parsed?.config && !parsed.config.srtla_addr && !parsed.config.relay_server) {
						parsed.config.srtla_addr = '127.0.0.1';
						mutated = true;
					}
					if (mutated) {
						handler.call(this, new MessageEvent('message', { data: JSON.stringify(parsed) }));
						return;
					}
				} catch {
					/* non-JSON frame — pass through */
				}
				handler.call(this, ev);
			};
		}

		get onmessage(): ((this: WebSocket, ev: MessageEvent) => unknown) | null {
			return super.onmessage;
		}
	}
	window.WebSocket = Hooked as typeof WebSocket;
}

const test = base.extend({
	page: async ({ page }, use) => {
		await page.addInitScript(pinIdleWithServer);
		await use(page);
	},
});

test.describe('Experience polish', () => {
	test('Live shows the idle ingest state when not streaming', async ({
		authedPage: page,
	}) => {
		await new ShellPage(page).navigate('live');

		// Idle, server configured: the calm informational idle card is shown
		// instead of a live ingest table. The default multi-modem-wifi scenario has
		// ready bonded links, so the link-aware idle panel (Todo 22) shows the
		// links-ready card; the empty variant (no links) is covered by
		// conditional-display.spec.ts state 2b.
		const idle = page.getByTestId('ingest-idle-ready');
		await expect(idle).toBeVisible();
		// No live telemetry table while idle (Live-Data Discipline — no stale values).
		await expect(page.getByTestId('ingest-row')).toHaveCount(0);
	});
});
