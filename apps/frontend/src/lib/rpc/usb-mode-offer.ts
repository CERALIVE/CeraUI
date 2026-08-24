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

import {
	USB_MODE_LIFTABLE_SUPPRESSIONS,
	type UsbCompositionMode,
	type UsbModeOfferSuppression,
	type UsbModeOptionsOutput,
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
	/** A property of the device: no control at all, and the reason beside it. */
	| { readonly phase: "withheld"; readonly reason: UsbModeOfferSuppression }
	/**
	 * A condition the operator can LIFT. The control area stays visible and
	 * disabled, carrying the reason — the same distinction the provisioning gate
	 * has always drawn, now available for every liftable suppression rather than
	 * for the one the frontend could read out of `config` on its own.
	 */
	| { readonly phase: "blocked"; readonly reason: UsbModeOfferSuppression };

const LIFTABLE = new Set<string>(USB_MODE_LIFTABLE_SUPPRESSIONS);

/** Whether a suppression describes a condition, rather than the device itself. */
export function isLiftableSuppression(
	reason: UsbModeOfferSuppression,
): boolean {
	return LIFTABLE.has(reason);
}

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
		return isLiftableSuppression(options.suppressed)
			? { phase: "blocked", reason: options.suppressed }
			: { phase: "withheld", reason: options.suppressed };
	}

	const targets = options.certified.filter((mode) => mode !== activeMode);
	const preferred = targets.find((mode) => mode === recommendedMode);
	const first = targets[0];
	if (first === undefined) return { phase: "settled" };

	return { phase: "offered", targets, preferred: preferred ?? first };
}

/**
 * The copy key for a suppressed offer.
 *
 * It is a TABLE rather than an interpolation for two independent reasons, and
 * either alone would be enough. The tokens do not share one namespace —
 * `identity_unresolved` is a `reason.*` string (it is also a `transition_failed`
 * reason) while the rest are `error.*` — and the four runtime tokens are
 * HYPHENATED on the wire, because they are modem-stack's own literals, while
 * every message key in this catalog is snake_case. Interpolating either shape
 * resolves to a missing key, which renders as the raw dotted path: the one thing
 * the modem surface's a11y gate forbids outright.
 *
 * `provisioning-disabled` deliberately resolves onto the EXISTING
 * `error.provisioning_disabled` sentence rather than a runtime-specific twin.
 * One machine token gets one operator sentence, whichever surface produced it.
 */
const SUPPRESSION_KEYS: Readonly<Record<UsbModeOfferSuppression, string>> = {
	identity_unresolved: "network.modem.usbMode.reason.identity_unresolved",
	uncertified: "network.modem.usbMode.error.uncertified",
	unavailable_in_emulated_mode:
		"network.modem.usbMode.error.unavailable_in_emulated_mode",
	"unknown-vendor": "network.modem.usbMode.error.unknown_vendor",
	"no-return-path": "network.modem.usbMode.error.no_return_path",
	"blocked-by-state": "network.modem.usbMode.error.blocked_by_state",
	"provisioning-disabled": "network.modem.usbMode.error.provisioning_disabled",
};

export function usbOfferSuppressionKey(
	reason: UsbModeOfferSuppression,
): string {
	return SUPPRESSION_KEYS[reason];
}

/**
 * The second, explanatory line for a suppressed offer — what still works, or
 * what the operator can do about it.
 *
 * Absent for the two suppressions whose head sentence is already the whole
 * answer: `identity_unresolved` names its own remedy, and
 * `unavailable_in_emulated_mode` has no operator action at all.
 */
const SUPPRESSION_BODY_KEYS: Readonly<
	Partial<Record<UsbModeOfferSuppression, string>>
> = {
	uncertified: "network.modem.usbMode.uncertifiedBody",
	"unknown-vendor": "network.modem.usbMode.unknownVendorBody",
	"no-return-path": "network.modem.usbMode.noReturnPathBody",
	"blocked-by-state": "network.modem.usbMode.blockedByStateBody",
	"provisioning-disabled": "network.modem.usbMode.provisioningBody",
};

export function usbOfferSuppressionBodyKey(
	reason: UsbModeOfferSuppression,
): string | undefined {
	return SUPPRESSION_BODY_KEYS[reason];
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
