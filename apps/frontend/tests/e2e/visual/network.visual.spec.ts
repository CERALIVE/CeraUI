import { expect, test } from '../fixtures/index.js';
import { NetworkPage } from '../pages/network.js';

/**
 * THE CAPTURE IS FULL-PAGE, and that is load-bearing rather than incidental.
 *
 * It was a bare `toHaveScreenshot()`, i.e. VIEWPORT-scoped — 1280×800, which on
 * this destination reaches only Bonded Links and the top of Internet Sharing.
 * WiFi, Cellular and Ethernet all sit below that fold, so the three cards this
 * baseline is nominally the regression gate for were never in it: the WifiSection
 * and EthernetSection restructures (todos 32/33) left the committed PNG
 * byte-identical, and a re-generation run reported nothing to update. A baseline
 * that cannot see the surface it guards is not a gate.
 *
 * `fullPage: true` makes the desktop baseline 1280×2761 and the mobile one
 * 390×4014, covering Bonded Links → Internet Sharing → WiFi → Cellular →
 * Ethernet → Hotspot → Bluetooth. Verified stable: three consecutive verify runs
 * on both projects passed with no pixel drift, on top of the two stabilizers
 * below and `mask.css`.
 */

/**
 * BondedLinksSection's per-link telemetry cell is a push-vs-capture race with NO
 * settled side: it renders a Skeleton while the feed is `undefined` and "--" once
 * a `status` frame delivers `null`. Which one a capture sees depends on whether
 * this page was the FIRST to authenticate against its worker backend — the feed
 * broadcasts on-change only, never changes from `null`, and `buildInitialStatus()`
 * omits it — so a later page never learns the feed arrived and keeps the skeleton
 * indefinitely. Measured: 1247 differing px between two runs of identical code.
 *
 * mask.css neutralises neither state (its `[data-live-value]` rule does not reach
 * these cells), so the cells are pinned here instead, to the Skeleton's own
 * mt-0.5/h-3.5/w-10 metrics — the same "hide only the value cells, keep the
 * section chrome" remedy mask.css already applies to Device Stats for exactly
 * this class of race. Column widths then follow the stable RTT/NAK/WEIGHT labels.
 *
 * Duplicated verbatim in signal-indicator.visual.spec.ts, which captures the same
 * section. The honest fix is backend-side (hydrate `linkTelemetry` in the
 * post-auth snapshot, as `sharing_diag` already does) and is out of scope here.
 */
const TELEMETRY_STABILIZE =
	'[data-testid="link-telemetry"] dd{visibility:hidden !important;display:block !important;overflow:hidden !important;margin-block-start:0.125rem !important;block-size:0.875rem !important;inline-size:2.5rem !important}';

/**
 * CollisionBands is BISTABLE on worker-backend lifetime, not late: probed once a
 * second for twelve seconds, the same-subnet band is present the whole time on a
 * fresh backend and absent the whole time on a warm one. `same_subnet_group` rides
 * the on-change `netif` push, so only the first page to authenticate against a
 * worker ever observes it. Both states are stable, so no wait can pick one — and
 * the band's presence shifts every section below it by its own height.
 *
 * It is therefore removed from LAYOUT for this capture (`display:none`, not the
 * `visibility:hidden` used above — an absent band has no box to preserve), which
 * makes the two states render identically. The bands keep their own dedicated
 * coverage in CollisionBands.bondMapping.test.ts; nothing else on this page is
 * affected.
 */
const COLLISION_BANDS_STABILIZE =
	'[data-testid="same-subnet-info"],[data-testid="policy-route-warning"]{display:none !important}';

test.describe('@visual Network destination snapshots', () => {
	test('@visual network destination baseline', { tag: '@visual' }, async ({ authedPage: page }) => {
		const network = new NetworkPage(page);
		await network.open();

		await page.addStyleTag({ content: `${TELEMETRY_STABILIZE}${COLLISION_BANDS_STABILIZE}` });
		await expect(page).toHaveScreenshot('network-desktop.png', {
			fullPage: true,
			stylePath: new URL('./mask.css', import.meta.url).pathname,
			maxDiffPixels: 100,
		});
	});
});
