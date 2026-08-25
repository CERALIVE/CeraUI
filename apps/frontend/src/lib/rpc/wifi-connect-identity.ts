/**
 * wifi-connect-identity.ts — a connect is confirmed by PROFILE IDENTITY, never
 * by SSID equality (F-06).
 *
 * The retired rule asked "is a network with the target SSID active now?". An
 * SSID is not an identity: NetworkManager happily holds several saved profiles
 * carrying the same one (a re-joined café chain, a hidden twin, a profile the
 * operator re-created with a new password), and any of them coming up satisfied
 * that question. So an activation the operator never asked for resolved their
 * pending connect, closed the dialog, and reported success for a profile that
 * was never dispatched.
 *
 * This module states the identity instead, and it follows the same philosophy
 * todo 3 established for scans: confirm on a DURABLE IDENTITY the device itself
 * publishes, never on content that merely looks right.
 *
 *   saved connect  → the profile UUID that was dispatched. `WifiInterface.conn`
 *                    is the interface's ACTIVE connection uuid (set by
 *                    `wifi-connections.ts` as `wifiInterface.conn = uuid`), so
 *                    the comparison is exact and needs nothing else.
 *   fresh connect  → no uuid exists yet, so the dispatch carries a correlation
 *                    id and the identity is the profile the DEVICE minted for
 *                    that SSID: the interface's active connection must BE the
 *                    saved uuid now recorded under the target SSID, and must
 *                    have moved off whatever was active at dispatch.
 *
 * It is deliberately conservative — the sibling rule `wifi-outcomes.ts` states
 * the same discipline — because this is a SECONDARY confirm. The discrete
 * `wifi { connect } / { new }` result frame still resolves the keyed op through
 * `subscriptions.svelte.ts`, so a snapshot that cannot prove identity yet costs
 * nothing but another tick, while a snapshot that guesses costs the operator a
 * false success.
 *
 * Pure and rune-free, so the whole rule is unit-testable without mounting the
 * dialog.
 */

/** The identity a dispatched connect is remembered by. */
export interface PendingWifiConnect {
	/**
	 * The SSID being joined. RENDERING ONLY — it names the row that should show
	 * the spinner. It is never the confirmation key, which is the whole point of
	 * this module.
	 */
	ssid: string;
	/**
	 * The saved profile uuid this connect dispatched. Present for a saved
	 * connect, absent for a fresh one (no profile exists yet).
	 */
	uuid?: string;
	/**
	 * The correlation id minted for a FRESH connect. It fences one dispatch from
	 * the next so a late snapshot belonging to a superseded attempt cannot
	 * confirm the current one.
	 */
	correlationId?: string;
	/**
	 * The interface's active-connection uuid captured AT DISPATCH. A fresh
	 * connect has landed only once the active connection has moved off it.
	 */
	baselineConn?: string;
}

/** The minimal `WifiInterface` shape this rule reads. */
export interface WifiConnectIdentityIface {
	/** The ACTIVE connection's uuid (`""` / absent when nothing is connected). */
	conn?: string;
	/** SSID → saved profile uuid, as the device records it. */
	saved?: Record<string, string>;
}

/** Terminal-or-not verdict, matching the `wifi-outcomes.ts` sibling vocabulary. */
export type WifiConnectIdentityOutcome = "pending" | "confirmed";

/** The minimal row shape the render-side matcher reads. */
export interface WifiConnectRow {
	ssid: string;
	/** The saved profile uuid for this row, when it has one. */
	uuid?: string | undefined;
}

let correlationSeq = 0;

/**
 * Mint a correlation id for a fresh connect. Monotonic within the session and
 * stamped with the wall clock, so it is unique across a reload too. It is an
 * OPAQUE fence — nothing derives meaning from its shape.
 */
export function mintWifiConnectCorrelationId(): string {
	correlationSeq += 1;
	return `wifi-connect-${Date.now()}-${correlationSeq}`;
}

/**
 * Has the dispatched connect landed, judged on IDENTITY?
 *
 * Returns `"confirmed"` only when the interface's own active-connection uuid
 * proves the dispatched profile is the one that came up. Everything else —
 * including "a network with that SSID is active" — stays `"pending"`.
 */
export function deriveWifiConnectIdentityOutcome(
	pending: PendingWifiConnect | undefined,
	iface: WifiConnectIdentityIface | undefined,
): WifiConnectIdentityOutcome {
	if (!pending || !iface) return "pending";

	// `""` is the backend's "nothing is connected" value, not a uuid.
	const activeConn = iface.conn;
	if (!activeConn) return "pending";

	// Saved connect: the uuid IS the identity, so this is a single comparison.
	// A sibling profile sharing the SSID has a DIFFERENT uuid and therefore
	// cannot confirm — which is the entire defect this closes.
	if (pending.uuid !== undefined) {
		return activeConn === pending.uuid ? "confirmed" : "pending";
	}

	// Fresh connect. Without a correlation id there is no dispatch to fence
	// against, so nothing may be claimed.
	if (pending.correlationId === undefined) return "pending";

	// The active connection must have MOVED. Still sitting on the uuid that was
	// active at dispatch means the join has not landed, whatever the scan list
	// says about the target SSID.
	if (activeConn === pending.baselineConn) return "pending";

	// …and it must be the profile the device minted for OUR ssid. An absent
	// entry means the device has not recorded the new profile yet; a different
	// uuid means something else came up.
	const mintedUuid = iface.saved?.[pending.ssid];
	return mintedUuid !== undefined && mintedUuid === activeConn
		? "confirmed"
		: "pending";
}

/**
 * Does `row` name the connect currently in flight? The render-side twin of the
 * rule above: a saved dispatch matches its own uuid, and a fresh dispatch
 * matches an UNSAVED row carrying the target SSID (a saved row of the same SSID
 * would be a different profile, and would have taken the saved path).
 */
export function isPendingConnectRow(
	pending: PendingWifiConnect | undefined,
	row: WifiConnectRow,
): boolean {
	if (!pending) return false;
	if (pending.uuid !== undefined) return row.uuid === pending.uuid;
	return row.uuid === undefined && row.ssid === pending.ssid;
}
