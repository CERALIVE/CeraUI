/**
 * What the band-lock control may offer, and what a click on a band means.
 *
 * Pure and rune-free, like `modem-detail.ts` and `usb-mode-offer.ts`, so the
 * decisions are testable without mounting a dialog — and so the ONE place that
 * decides whether a control renders is not a `{#if}` chain in markup.
 *
 * THREE phases, and the two that render nothing are NOT the same fact. This is
 * deliberately the same shape `deriveUsbModeOffer` uses, for the same reason:
 * "the device said no" and "we never got an answer" have different honest
 * renderings, and collapsing them makes the UI assert a device fact it does not
 * have.
 */

import type {
	ModemBands,
	ModemBandsOutput,
	ModemBandsRefusal,
} from "@ceraui/rpc/schemas";
import { BAND_ANY } from "@ceraui/rpc/schemas";

export type BandOfferPhase = "offered" | "withheld" | "unknown";

export interface BandOffer {
	readonly phase: BandOfferPhase;
	/** The bands a control may offer. Never `supported` — see `offerable`. */
	readonly offerable: readonly string[];
	readonly current: readonly string[];
	readonly unlocked: boolean;
	/** i18n dot-path, present only in `withheld`. Never a raw wire token. */
	readonly reasonKey?: string;
}

const WITHHELD: Readonly<Record<ModemBandsRefusal, string>> = {
	unsupported: "network.modem.bands.reason.unsupported",
	uncertified: "network.modem.bands.reason.uncertified",
	module_disabled: "network.modem.bands.reason.module_disabled",
	unknown_modem: "network.modem.bands.reason.unknown_modem",
	read_failed: "network.modem.bands.reason.read_failed",
};

const NOTHING: BandOffer = {
	phase: "unknown",
	offerable: [],
	current: [],
	unlocked: true,
};

/**
 * `undefined` — not asked yet, in flight, or the read threw — is `unknown`, and
 * `unknown` renders NOTHING and claims NOTHING. Reporting it as `uncertified`
 * would state a fact about the modem's certification that nobody established.
 */
export function deriveBandOffer(
	result: ModemBandsOutput | undefined,
): BandOffer {
	if (result === undefined) return NOTHING;
	if (!result.success || result.bands === undefined) {
		const key = result.error === undefined ? undefined : WITHHELD[result.error];
		return key === undefined
			? NOTHING
			: { ...NOTHING, phase: "withheld", reasonKey: key };
	}
	const bands: ModemBands = result.bands;
	return {
		phase: "offered",
		offerable: bands.offerable,
		current: bands.current,
		unlocked: bands.unlocked,
	};
}

/**
 * Toggle one band in a draft selection.
 *
 * `any` is EXCLUSIVE in both directions: picking it clears every specific band
 * (it means "let the modem choose"), and picking a specific band drops it. A
 * selection holding `any` alongside a band is not a lock the modem can be asked
 * for, so it must not be expressible.
 *
 * Deselecting the last remaining band yields `['any']` rather than an empty
 * set — an empty selection is not a state a radio can be in, and offering Apply
 * on one would only produce a refusal.
 */
export function toggleBand(
	selection: readonly string[],
	band: string,
): readonly string[] {
	if (band === BAND_ANY) return [BAND_ANY];
	const without = selection.filter(
		(entry) => entry !== BAND_ANY && entry !== band,
	);
	if (selection.includes(band)) {
		return without.length > 0 ? without : [BAND_ANY];
	}
	return [...without, band];
}

/** Whether the draft differs from what the modem currently reports. */
export function bandSelectionChanged(
	current: readonly string[],
	selection: readonly string[],
): boolean {
	if (current.length !== selection.length) return true;
	const held = new Set(current);
	return !selection.every((band) => held.has(band));
}

/** The selection a freshly-opened control starts from. */
export function initialBandSelection(offer: BandOffer): readonly string[] {
	return offer.current.length > 0 ? [...offer.current] : [BAND_ANY];
}
