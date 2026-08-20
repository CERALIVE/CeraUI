/**
 * The render half of the `five-g-pref` capability module. Pure and rune-free,
 * like `modem-detail.ts` and `router-signal.ts` beside it.
 *
 * It answers exactly two questions — may a control be drawn, and what does each
 * option say — and it answers the first from the DEVICE's own published block
 * rather than by re-deriving the support ladder here. A second derivation would
 * be free to disagree with the backend's, and every way it could disagree is a
 * lie: an offered posture the device refuses, or a hidden one the radio supports.
 */

import type {
	FiveGPreference,
	Modem,
	ModemFiveGPreference,
} from "@ceraui/rpc/schemas";

export type FiveGOptionView = {
	readonly preference: FiveGPreference;
	readonly labelKey: string;
	readonly descriptionKey: string;
	/** The posture the radio is on NOW. A control for it is a no-op. */
	readonly active: boolean;
};

export type FiveGView =
	| { readonly kind: "hidden" }
	| {
			readonly kind: "offered";
			readonly options: readonly FiveGOptionView[];
			readonly active: FiveGPreference | null;
			/** Stated, never omitted — see `nrModeSelection` on the device side. */
			readonly nrModeReasonKey: string;
	  };

const LABEL_KEY: Record<FiveGPreference, string> = {
	"5g-only": "network.modem.fiveG.option.fiveGOnly",
	"prefer-5g": "network.modem.fiveG.option.preferFiveG",
	"prefer-4g": "network.modem.fiveG.option.preferFourG",
	"5g-off": "network.modem.fiveG.option.fiveGOff",
};

const DESCRIPTION_KEY: Record<FiveGPreference, string> = {
	"5g-only": "network.modem.fiveG.description.fiveGOnly",
	"prefer-5g": "network.modem.fiveG.description.preferFiveG",
	"prefer-4g": "network.modem.fiveG.description.preferFourG",
	"5g-off": "network.modem.fiveG.description.fiveGOff",
};

const NR_MODE_REASON_KEY = "network.modem.fiveG.nrMode.notExposed";

/**
 * A modem row from a device that publishes no block renders NOTHING —
 * fail-CLOSED, because absence of a claim is not a claim, and offering a
 * radio-mutating control to a device that never described itself is the one
 * outcome the capability framework exists to prevent.
 *
 * An EMPTY `offered` list is likewise hidden: the device advertised no posture,
 * so there is no choice to make, and a control with one impossible option is
 * worse than none.
 */
export function fiveGView(block: ModemFiveGPreference | undefined): FiveGView {
	if (block === undefined || block.offered.length === 0) {
		return { kind: "hidden" };
	}
	return {
		kind: "offered",
		options: block.offered.map((preference) => ({
			preference,
			labelKey: LABEL_KEY[preference],
			descriptionKey: DESCRIPTION_KEY[preference],
			active: block.active === preference,
		})),
		active: block.active,
		nrModeReasonKey: NR_MODE_REASON_KEY,
	};
}

export function fiveGViewForModem(modem: Modem | undefined): FiveGView {
	return fiveGView(modem?.five_g_preference);
}

/**
 * Copy for a failed write.
 *
 * Every arm is keyed, because the device's tokens are machine-stable and an
 * operator with no console cannot act on `readback_mismatch`. The two readback
 * arms are deliberately DIFFERENT sentences: one means the radio took the
 * request and landed elsewhere, the other that nothing can be claimed about
 * where it landed at all.
 */
export function fiveGFailureKey(error: string | undefined): string {
	switch (error) {
		case "unknown_modem":
		case "not_offered":
		case "write_failed":
		case "readback_mismatch":
		case "readback_failed":
			return `network.modem.fiveG.error.${error}`;
		default:
			return "network.modem.fiveG.error.generic";
	}
}
