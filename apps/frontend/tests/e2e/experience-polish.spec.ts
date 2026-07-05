/**
 * Experience-polish spec (Wave 10) — @functional.
 *
 * Covers the Live destination's idle surface: when the stream is idle the view
 * renders the Go-Live idle cockpit (GoLiveCard readiness + config) and NOT the
 * live cockpit / live ingest table — no live telemetry values leak while idle
 * (Live-Data Discipline). The standalone idle-ingest card (`ingest-idle-ready`)
 * was absorbed into GoLiveCard's readiness gates by the Wave 3 T10/T11
 * restructure. The HUD accessibility checks (Todo 30) live in a11y.spec.ts,
 * where the dedicated axe/a11y CI gate runs.
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

		// Idle, server configured: the Go-Live idle cockpit renders the StreamSetupChain
		// setup rows instead of a live ingest table. The standalone `ingest-idle-ready`
		// card was absorbed into the setup rows by the Wave 3 T10/T11 restructure. The
		// default multi-modem-wifi scenario has ready bonded links, so the network row
		// resolves ok (mirrors conditional-display.spec.ts state 2a); the no-links
		// blocked variant is covered by conditional-display.spec.ts state 2b.
		const card = page.getByTestId('stream-setup-chain');
		await expect(card).toBeVisible();
		const networkRow = card.locator('[data-testid="setup-row"][data-row="network"]');
		await expect(networkRow).toHaveAttribute('data-state', 'ok');
		// No live telemetry table while idle (Live-Data Discipline — no stale values).
		await expect(page.getByTestId('ingest-row')).toHaveCount(0);
	});
});
