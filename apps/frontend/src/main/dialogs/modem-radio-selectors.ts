/**
 * THE THREE RADIO SELECTORS, RESOLVED BY ONE RULE.
 *
 * Network mode, the band lock and the 5G preference all answer the same shape of
 * question — may this radio setting be offered, and if not, why not — and until
 * now each answered it its own way. Two of them were routed through
 * `CapabilitySection` with a two-state `cardView(present)` helper and the third
 * was a bare `<div>` with a `Select` inside it, so the four-state ladder the
 * primitive exists to state ONCE was, for these three, stated nowhere.
 *
 * WHAT THAT COST, AND IT IS NOT THEORETICAL
 * -----------------------------------------
 * `deriveBandOffer(undefined)` answers `phase: "unknown"` — "not asked yet, in
 * flight, or the read THREW" — and `cardView(false)` renders `absent`, i.e. ZERO
 * nodes. So a `modems.getBands` rejection produced no control AND no message:
 * the operator was shown the exact same surface as a modem that positively has
 * no band support. `deriveUsbModeOffer` has the identical `unknown` phase behind
 * the identical `catch { options = undefined }`, with the identical result.
 *
 * "We could not establish this" and "this device cannot do it" are different
 * facts. Rendering the first as the second is the one substitution the ladder
 * exists to prevent, and it is what this module fixes.
 *
 * THE LADDER, AS IT APPLIES HERE
 * ------------------------------
 *   absent    — the device answered and there is positively nothing to offer.
 *               ZERO nodes: no heading, no reason, no ghost control.
 *   unknown   — nothing has been established. A `role="status"` line carrying
 *               the reason, and NO control of any kind.
 *   blocked   — the capability exists and is refused right now, with the reason
 *               on screen beside the control.
 *   available — the control renders, live.
 *
 * `blocked` RENDERS TWO DIFFERENT SHAPES, AND BOTH ARE CORRECT.
 * `CapabilitySection` renders a `control` snippet at `blocked` (disabled) and
 * suppresses `children` there. So a selector whose offer is ONE control — the
 * network-mode `Select` — renders that control DISABLED beside its reason, which
 * is `DESIGN.md` CT-2 verbatim. A selector whose offer is a LIST — the band chips,
 * the 5G postures — passes no `control`, so `blocked` is a heading plus the
 * refusal and no list at all. That is the shape `RouterDongleDialog`'s refused
 * net-mode catalog already uses, and it is why a refusal here never has to be
 * downgraded to `absent` to avoid claiming a disabled control exists.
 *
 * Pure and rune-free, like `modem-bands.ts` and `modem-five-g.ts` beside it, so
 * every row of the table below is provable without mounting a dialog.
 */

import type {
	Modem,
	ModemBandsOutput,
	ModemBandsRefusal,
	SupportClaimState,
} from "@ceraui/rpc/schemas";

import {
	type CapabilityView,
	deriveCapabilityView,
	readingView,
} from "$lib/modem/sections";
import { deriveBandOffer } from "./modem-bands";
import type { FiveGView } from "./modem-five-g";

/**
 * ONE machine condition, ONE operator sentence: a radio setting that cannot be
 * changed until a card is in the slot says so the same way wherever it appears.
 */
export const RADIO_NO_SIM_REASON_KEY = "network.modem.radioNoSim";

/**
 * The band read has not answered — because it has not run, is in flight, or
 * threw. All three are the same fact from the operator's side: nobody has
 * established what this modem's band support is, so nothing may be claimed
 * about it in either direction.
 */
export const BAND_NOT_ESTABLISHED_KEY =
	"network.modem.bands.reason.not_established";

/** The modem published no radio-technology catalog at all. */
export const NETWORK_TYPE_UNKNOWN_KEY = "network.modem.networkTypeUnknown";

/** The certified USB-composition set could not be established. */
export const USB_MODE_OPTIONS_UNKNOWN_KEY =
	"network.modem.usbMode.optionsUnknown";

/**
 * Which state each band refusal renders as.
 *
 * The three that resolve `unknown` are all statements about the READ or about a
 * gate this build controls; only `unsupported` is a statement about the DEVICE,
 * and only a statement about the device may render nothing at all.
 *
 * `uncertified` is `blocked`, NOT `absent`, and that is the correction this
 * table carries. modem-stack's `control/src/band/certification.ts` refuses the
 * WRITE with `band-certification-required` — the modem advertises bands and the
 * catalog has not proven set/readback/reset on this model and firmware. A
 * capability that exists and is refused right now is the textbook `blocked`
 * case; rendering it as `absent` told the operator their modem has no bands,
 * which is the opposite of what the device reported.
 */
const BAND_REFUSAL_MODE = {
	unsupported: "absent",
	uncertified: "blocked",
	module_disabled: "unknown",
	unknown_modem: "unknown",
	read_failed: "unknown",
} as const satisfies Readonly<
	Record<ModemBandsRefusal, "absent" | "unknown" | "blocked">
>;

/**
 * The band-lock section's state, from the DEVICE's own answer.
 *
 * It takes the raw RPC result rather than the folded `BandOffer` for one
 * reason: the offer carries the resolved reason KEY but not the refusal TOKEN,
 * and the token is what decides between `absent`, `unknown` and `blocked`. The
 * key still comes from `deriveBandOffer`, so the copy table stays in the module
 * that owns it and cannot drift into a second copy here.
 */
export function bandCapabilityView(
	result: ModemBandsOutput | undefined,
): CapabilityView {
	const offer = deriveBandOffer(result);
	if (offer.phase === "offered") {
		// The modem answered with a certified set, so THIS sub-question really is
		// a reading: an EMPTY set is a real answer and there is nothing to render.
		// Only the arms below can be unknown.
		return readingView(offer.offerable.length > 0);
	}

	const refusal = result?.success === false ? result.error : undefined;
	const reasonKey = offer.reasonKey;
	if (refusal === undefined || reasonKey === undefined) {
		return { mode: "unknown", reasonKey: BAND_NOT_ESTABLISHED_KEY };
	}

	const mode = BAND_REFUSAL_MODE[refusal];
	return mode === "absent" ? { mode: "absent" } : { mode, reasonKey };
}

/**
 * The network-mode selector's state.
 *
 * `supported` is the modem's OWN mode catalog, folded by the backend from
 * `Modem.SupportedModes`. Three readings, and the middle one is the correction:
 *
 *   field ABSENT       — we were told nothing. `unknown`.
 *   `supported: []`    — the device answered and named no selectable type.
 *                        `absent`, because a dropdown that opens onto nothing is
 *                        a control that cannot act. It used to render exactly
 *                        that, under copy about scanning for OPERATORS, which is
 *                        a different question entirely.
 *   one or more        — the control renders. ONE entry is a first-class answer,
 *                        not a degenerate one: the bench Fibocom FM350-GL
 *                        advertises exactly one combination
 *                        (`allowed: 2g, 3g, 4g, 5g; preferred: none`), and
 *                        showing the operator that single truthful reading is
 *                        the whole point of not inventing a second.
 */
export function networkModeCapabilityView(
	networkType: Modem["network_type"] | undefined,
	noSim: boolean,
): CapabilityView {
	if (networkType === undefined) {
		return { mode: "unknown", reasonKey: NETWORK_TYPE_UNKNOWN_KEY };
	}
	// The schema types `supported` as required, but the `modems` broadcast is
	// CAST rather than parsed (`subscriptions.svelte.ts` `case "modems"`), so
	// nothing enforces that at runtime — a partial block reached this line and
	// took the whole control plane down through the top-level render boundary.
	// No catalog is the same epistemic state as an absent block: `unknown`.
	if (!Array.isArray(networkType.supported)) {
		return { mode: "unknown", reasonKey: NETWORK_TYPE_UNKNOWN_KEY };
	}
	if (networkType.supported.length === 0) return { mode: "absent" };
	return noSim
		? { mode: "blocked", reasonKey: RADIO_NO_SIM_REASON_KEY }
		: { mode: "available" };
}

/**
 * The 5G-preference section's state.
 *
 * The DEVICE's published block wins when it carries postures: the backend emits
 * `modem.five_g_preference` only where the capability ladder says the control
 * may be offered, so its presence is stronger evidence than the claim it was
 * derived from. Re-deriving the gate here could only disagree with the
 * backend's, and every way it could disagree is a lie.
 *
 * With NO block the claim is what separates the two silences. A modem that
 * advertised no posture at all is `absent` — the FM350's answer, and the reason
 * its selector correctly does not render. A modem whose gate is off, or whose
 * capability nobody has probed, is `unknown` WITH its reason: hiding those would
 * make an operator hunt for a control that is one Settings toggle away.
 */
export function fiveGCapabilityView(
	view: FiveGView,
	claim: SupportClaimState | undefined,
	noSim: boolean,
): CapabilityView {
	if (view.kind === "offered") {
		return noSim
			? { mode: "blocked", reasonKey: RADIO_NO_SIM_REASON_KEY }
			: { mode: "available" };
	}
	const resolved = deriveCapabilityView(claim);
	return resolved.mode === "unknown" ? resolved : { mode: "absent" };
}
