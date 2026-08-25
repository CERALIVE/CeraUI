/**
 * wifi-scan-state.ts — the ONE reading of what a scan surface is currently showing.
 * Pure and rune-free.
 *
 * The list had three states and needed six. `scanning` / `error` / `empty` all
 * describe an EMPTY list, so they only ever rendered in the `{:else}` of the row
 * loop — which left the case an operator actually spends their time in
 * completely unmarked: results ON SCREEN, produced by some earlier scan cycle.
 *
 * Todo 3 made that cycle nameable. The device stamps a strictly-increasing
 * `scanGeneration` on every scan it COMPLETES, so a list on screen belongs to a
 * specific generation and a later one supersedes it. Two supersession states
 * follow, and they are the two this module adds:
 *
 *   • `refreshing` — a scan is in flight, so the visible rows are already being
 *     replaced. Tapping Connect on a row here acts on a list that is one
 *     broadcast away from changing underneath it.
 *   • `stale` — the last scan FAILED while rows were on screen, so they are the
 *     last completed generation and nothing is coming to replace them. This one
 *     rendered NOTHING at all before: `wifi-scan-error` lives in the empty-list
 *     branch, so a failing background tick left a fresh-looking list on screen,
 *     which is the exact misleading-fresh-data case `.impeccable.md` §4 forbids.
 *
 * The three EMPTY-list states are reproduced byte-identically, deliberately: the
 * empty branch is a settled contract with its own tests, and this module is an
 * addition to the surface rather than a rewrite of it.
 */

/** What the scan surface is showing, as one total answer. */
export type WifiScanState =
	/** In flight at the operator's request, nothing on screen yet. */
	| "scanning"
	/** In flight (operator's or background) while rows are on screen. */
	| "refreshing"
	/** The last scan failed and there is nothing on screen. */
	| "error"
	/** The last scan failed while rows were on screen — no replacement is coming. */
	| "stale"
	/** Settled, and the scan honestly found nothing. */
	| "empty"
	/** Settled, with results on screen. */
	| "settled";

export interface WifiScanStateInput {
	/** ANY scan is pending on this adapter — the operator's tap OR a background tick. */
	scanInFlight: boolean;
	/**
	 * The in-flight scan is the operator's own.
	 *
	 * Separate from {@link scanInFlight} because a background tick must never
	 * drive the empty-list spinner: the poll runs every 22 s, so an empty adapter
	 * would flip between "Searching…" and "No networks found" indefinitely.
	 */
	manualScan: boolean;
	/** The last scan left the op machine in `failed`. */
	scanFailed: boolean;
	/** How many rows are on screen right now. */
	resultCount: number;
}

export function deriveWifiScanState(input: WifiScanStateInput): WifiScanState {
	if (input.resultCount > 0) {
		if (input.scanInFlight) return "refreshing";
		return input.scanFailed ? "stale" : "settled";
	}
	if (input.manualScan) return "scanning";
	return input.scanFailed ? "error" : "empty";
}

const FRESHNESS_KEY: Partial<Record<WifiScanState, string>> = {
	refreshing: "wifiSelector.freshness.refreshing",
	stale: "wifiSelector.freshness.stale",
};

/**
 * The i18n dot-path qualifying the rows on screen, or `undefined` when nothing
 * should render.
 *
 * Only the two supersession states qualify anything. `settled` is the honest
 * silent case, and the three empty-list states are already a full-panel
 * rendering of their own — marking them here would say the same thing twice.
 */
export function wifiScanFreshnessKey(state: WifiScanState): string | undefined {
	return FRESHNESS_KEY[state];
}

/**
 * Whether the rendered count describes a list that is no longer authoritative.
 *
 * Drives the SAME opacity dimming every other live-data surface uses for an aged
 * reading (`Badge variant="speed"`, the per-interface staleness dim) rather than
 * a second mechanism.
 */
export function wifiScanResultsSuperseded(state: WifiScanState): boolean {
	return state === "refreshing" || state === "stale";
}
