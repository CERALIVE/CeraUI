/**
 * wifi-mode-outcome.ts — pure outcome predicate for the WiFi station⇆hotspot mode
 * switch (T9, ceraui-os-interaction-ux).
 *
 * Extracted verbatim from WifiSection's inline confirm so the rule is unit-testable
 * and the component holds ONE source of truth. The mode switch is owned by the
 * keyed async-operation store under `hotspot:${device}`. While the op is pending
 * the section holds the label on the CURRENT mode — a raw `wifi` broadcast must
 * never clobber it mid-switch. This predicate is the pure decision the confirm
 * `$effect` makes: has the authoritative snapshot reached the TARGET mode yet?
 *
 * It is conservative — only `"confirmed"` when the snapshot UNAMBIGUOUSLY shows the
 * target mode — so a stale or in-flight snapshot never clears the spinner early,
 * and an absent target (no switch in flight for this radio) is always `"pending"`.
 */

/** The mode a switch is driving toward. */
export type WifiModeTarget = "hotspot" | "station";

/** The two terminal-or-not states a pending mode switch derives into. */
export type WifiModeOutcome = "pending" | "confirmed";

/**
 * Derive the mode-switch outcome from the target and the live hotspot flag.
 *
 * @param target     the mode this radio is switching to (`undefined` = no switch)
 * @param isHotspot  whether the authoritative snapshot currently reports hotspot mode
 */
export function deriveWifiModeOutcome(
	target: WifiModeTarget | undefined,
	isHotspot: boolean,
): WifiModeOutcome {
	if (target === "hotspot" && isHotspot) return "confirmed";
	if (target === "station" && !isHotspot) return "confirmed";
	return "pending";
}
