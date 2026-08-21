/**
 * WHICH USB composition modes the operator may be offered — a PURE, rune-free
 * rule, and the sibling of `usb-mode-flow.ts` (which owns what happens once one
 * has been dispatched).
 *
 * The selector renders the certified set and NOTHING else. A device with no
 * certified target renders no selector at all — not a disabled one, because a
 * disabled control implies a capability being withheld, and here there is no
 * capability to withhold: the transition has never been reviewed for this exact
 * model and firmware, so it does not exist for this device.
 *
 * `recommended_usb_mode` is deliberately NOT what drives this. It is a per-SKU
 * ADVISORY about which composition is most stable; it says nothing about whether
 * a transition into it is certified, so a control derived from it is offered on
 * every board and refused by every device. It survives here as a PREFERENCE
 * among the certified targets, which is the only claim it can support.
 */

import type {
	UsbCompositionMode,
	UsbModeOfferSuppression,
	UsbModeOptionsOutput,
} from "@ceraui/rpc/schemas";

export type UsbModeOffer =
	/** Nothing has been asked yet, or the answer is still in flight. */
	| { readonly phase: "unknown" }
	/** The device is certified and has no certified way OUT of its current mode. */
	| { readonly phase: "settled" }
	| {
			readonly phase: "offered";
			readonly targets: readonly UsbCompositionMode[];
			readonly preferred: UsbCompositionMode;
	  }
	| { readonly phase: "withheld"; readonly reason: UsbModeOfferSuppression };

/**
 * Fold the device's answer into what the card may render.
 *
 * The active mode is filtered out defensively. The backend answers with targets
 * of transitions leading OUT of the current mode, so it cannot contain it — but
 * "switch to the mode you are already in" is the one option that must never
 * reach a button, and one `filter` is cheaper than trusting a remote invariant.
 */
export function deriveUsbModeOffer(input: {
	readonly options: UsbModeOptionsOutput | undefined;
	readonly activeMode: UsbCompositionMode | undefined;
	readonly recommendedMode: UsbCompositionMode | undefined;
}): UsbModeOffer {
	const { options, activeMode, recommendedMode } = input;
	if (options === undefined) return { phase: "unknown" };
	if (options.suppressed !== undefined) {
		return { phase: "withheld", reason: options.suppressed };
	}

	const targets = options.certified.filter((mode) => mode !== activeMode);
	const preferred = targets.find((mode) => mode === recommendedMode);
	const first = targets[0];
	if (first === undefined) return { phase: "settled" };

	return { phase: "offered", targets, preferred: preferred ?? first };
}

/**
 * The copy key for a withheld offer.
 *
 * It is a TABLE rather than an interpolation because the three tokens do not
 * share one namespace: `identity_unresolved` is a `reason.*` string (it is also
 * a `transition_failed` reason) and the other two are `error.*`. Interpolating
 * would resolve to a missing key for one of them, which renders as the raw
 * dotted path — the one thing the modem surface's a11y gate forbids outright.
 */
export function usbOfferSuppressionKey(
	reason: UsbModeOfferSuppression,
): string {
	return reason === "identity_unresolved"
		? "network.modem.usbMode.reason.identity_unresolved"
		: `network.modem.usbMode.error.${reason}`;
}

/** Whether a mode the operator has selected is still one the device offers. */
export function isOfferedTarget(
	offer: UsbModeOffer,
	mode: UsbCompositionMode | undefined,
): boolean {
	return (
		offer.phase === "offered" &&
		mode !== undefined &&
		offer.targets.includes(mode)
	);
}

/**
 * The target a dispatch would act on: the operator's own pick while it is still
 * offered, else the preference. A pick that the device has since stopped
 * offering falls back rather than being dispatched — the certified set is
 * re-read on every open, and hardware can change between them.
 */
export function resolveUsbModeTarget(
	offer: UsbModeOffer,
	selected: UsbCompositionMode | undefined,
): UsbCompositionMode | undefined {
	if (offer.phase !== "offered") return undefined;
	return isOfferedTarget(offer, selected) ? selected : offer.preferred;
}
