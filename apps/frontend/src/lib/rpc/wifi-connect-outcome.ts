/**
 * Pure WiFi-connect outcome classifier — T5 (ceraui-os-interaction-ux)
 *
 * Maps a raw `wifi` broadcast frame onto the terminal verdict the
 * WifiSelectorDialog needs: did the connect attempt confirm, fail, or is it
 * still pending? Kept rune-free and side-effect-free so it can be unit-tested
 * directly and reused by the subscriptions handler.
 *
 * The single subtlety it encodes is the array-ack vs boolean-result split:
 *   - `wifi { connect: [uuid] }`  → dispatch ack (IGNORE — stays pending)
 *   - `wifi { connect: boolean }` → the real result (true=confirmed, false=failed)
 *   - `wifi { new: { success } }` / `{ new: { error } }` → new-network result
 * A secondary confirm uses the available-network snapshot: if the target SSID is
 * now `active`, treat it as confirmed even without a discrete result frame.
 */

/** The terminal verdict for a WiFi connect attempt. */
export type WifiConnectOutcome = "pending" | "confirmed" | "failed";

/** The minimal shape of a `wifi` broadcast frame this classifier reads. */
export interface WifiConnectEvent {
	connect?: boolean | string[];
	new?: { success?: boolean; error?: string };
}

/**
 * Derive the connect outcome from a `wifi` frame + the current network snapshot.
 *
 * @param wifiEvent          the raw `wifi` broadcast payload
 * @param _deviceId          the interface device id (kept for call-site symmetry)
 * @param targetSsid         the SSID the operator is connecting to
 * @param availableNetworks  the latest scan snapshot (drives the secondary confirm)
 */
export function deriveWifiConnectOutcome(
	wifiEvent: WifiConnectEvent,
	_deviceId: string,
	targetSsid: string,
	availableNetworks: ReadonlyArray<{ ssid: string; active: boolean }>,
): WifiConnectOutcome {
	// Boolean connect result (NOT the array ack, which is only a dispatch echo).
	if (typeof wifiEvent.connect === "boolean") {
		return wifiEvent.connect ? "confirmed" : "failed";
	}
	// New-network result.
	if (wifiEvent.new?.success) return "confirmed";
	if (wifiEvent.new?.error) return "failed";
	// Secondary confirm: the snapshot already shows the target SSID as active.
	if (availableNetworks.some((n) => n.ssid === targetSsid && n.active)) {
		return "confirmed";
	}
	return "pending";
}
