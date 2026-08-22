/**
 * What the hotspot dialog may OFFER, and what it may only STATE — pure,
 * rune-free.
 *
 * Both answers come from the device's own derivation and nothing else. The
 * security offering is `hotspot.available_security`, which the backend derives
 * per-adapter from the live capability read and then REJECTS anything absent
 * from; the width is `hotspot.max_width_mhz`, which the same read produced.
 * There is no per-board table here and there must never be one — a kernel that
 * reports less offers less, automatically.
 *
 * Three rules from `DESIGN.md` §1 shape the result, and the first two are the
 * ones that are easy to collapse:
 *
 *   • CT-1 — a positively-unsupported mode contributes ZERO nodes. A radio whose
 *     capability read proved no SAE does not get a greyed WPA3 row; it gets no
 *     WPA3 row. A disabled control there would claim a capability is being
 *     withheld when the hardware simply lacks it (CT-4).
 *   • ABSENT IS NOT EMPTY. A device that predates the offering omits the map
 *     entirely, and that must render as the dialog rendered BEFORE this existed
 *     — no selector, no read-only line, no "unavailable" placeholder. An empty
 *     offering would be a claim; an absent one is silence.
 *   • ONE OPTION IS NOT A CHOICE. With a single offered mode there is nothing to
 *     select, so the mode is STATED rather than presented as a control the
 *     operator can move. That is the `captureModeOptions` rule, and it keeps the
 *     shipped fleet (WPA2-only, because NM 1.42 publishes no SAE key) from
 *     growing a one-item radiogroup.
 *
 * The width is DISPLAY ONLY and has no selector by construction: this module
 * exposes no setter for it, because NetworkManager 1.42 publishes no hotspot
 * channel-width property, so a control could not act.
 */
import type {
	HotspotConfig,
	HotspotSecurityId,
	WifiAdapterCapabilities,
	WifiCapabilityBand,
} from "@ceraui/rpc/schemas";

/** Display order for the security modes. Weakest first, never wire order. */
const SECURITY_ORDER: readonly HotspotSecurityId[] = ["wpa2", "wpa3-sae"];

/**
 * Bands a hotspot may be configured on. 6 GHz is absent BY CONSTRUCTION rather
 * than by filtering — `802-11-wireless.band` has no value for it, so the wire
 * type carries no such key.
 */
const HOTSPOT_BAND_ORDER = ["2.4", "5"] as const;
type HotspotWidthBand = (typeof HOTSPOT_BAND_ORDER)[number];

const BAND_LABEL_KEY: Record<HotspotWidthBand, string> = {
	"2.4": "network.wifiCapability.band24",
	"5": "network.wifiCapability.band5",
};

export interface HotspotSecurityOption {
	readonly id: HotspotSecurityId;
	/** The device's own name for the mode (`WPA2 (Personal)`), rendered verbatim. */
	readonly name: string;
}

export type HotspotSecurityChoice =
	/** Two or more offered modes: a real selector. */
	| {
			readonly kind: "select";
			readonly options: readonly HotspotSecurityOption[];
			readonly selected: HotspotSecurityId;
	  }
	/** Exactly one offered mode: stated, never presented as a choice. */
	| { readonly kind: "stated"; readonly option: HotspotSecurityOption };

/**
 * The security control, or `undefined` when the dialog must render nothing.
 *
 * `undefined` is the REGRESSION LOCK: an older backend sends no
 * `available_security`, and the dialog then shows exactly the name/password/
 * channel set it always did.
 */
export function deriveHotspotSecurityChoice(
	hotspot: HotspotConfig | undefined,
): HotspotSecurityChoice | undefined {
	const offered = hotspot?.available_security;
	if (!offered) return undefined;

	const options: HotspotSecurityOption[] = [];
	for (const id of SECURITY_ORDER) {
		const entry = offered[id];
		if (entry) options.push({ id, name: entry.name });
	}
	// A device that derived an offering and named nothing in it is drift, not an
	// empty offering — say nothing rather than render an empty control.
	if (options.length === 0) return undefined;

	const first = options[0];
	if (!first) return undefined;
	if (options.length === 1) return { kind: "stated", option: first };

	// An unset selection is WPA2, which is what the device itself resolves an
	// absent mode to — so the control never opens on a value the device would
	// not honour.
	const configured = hotspot?.security;
	const selected =
		configured && options.some((o) => o.id === configured)
			? configured
			: "wpa2";
	return { kind: "select", options, selected };
}

/** The mode a save must carry, or `undefined` when the dialog offers no choice. */
export function selectableHotspotSecurity(
	choice: HotspotSecurityChoice | undefined,
): HotspotSecurityId | undefined {
	return choice?.kind === "select" ? choice.selected : undefined;
}

export interface HotspotBandWidth {
	readonly band: WifiCapabilityBand;
	readonly labelKey: string;
	readonly widthMhz: number;
}

export interface HotspotRadioTruth {
	/** Absent when the device reported no capability block for this adapter. */
	readonly generationLabelKey?: string;
	/** Only the hotspot-eligible bands the radio actually reported a width for. */
	readonly bands: readonly HotspotBandWidth[];
}

/**
 * The READ-ONLY radio line, or `undefined` when there is nothing measured to
 * state. Never a placeholder: a device that reported neither a width nor a
 * generation gets no line at all.
 */
export function deriveHotspotRadioTruth(
	hotspot: HotspotConfig | undefined,
	capabilities: WifiAdapterCapabilities | undefined,
): HotspotRadioTruth | undefined {
	const widths = hotspot?.max_width_mhz;
	const bands: HotspotBandWidth[] = [];
	for (const band of HOTSPOT_BAND_ORDER) {
		const widthMhz = widths?.[band];
		if (typeof widthMhz !== "number" || widthMhz <= 0) continue;
		bands.push({ band, labelKey: BAND_LABEL_KEY[band], widthMhz });
	}

	const generation = capabilities?.generation;
	if (bands.length === 0 && generation === undefined) return undefined;

	return {
		...(generation === undefined
			? {}
			: {
					generationLabelKey: `network.wifiCapability.generation.${generation}`,
				}),
		bands,
	};
}
