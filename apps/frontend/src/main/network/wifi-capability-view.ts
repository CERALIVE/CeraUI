/**
 * The render rule for a Wi-Fi adapter's capability report — pure, rune-free.
 *
 * Every value it produces is READ BACK from the device's own nl80211 answer
 * (`wifiInterfaceSchema.capabilities`, itself parsed from `iw phy` / `iw reg`).
 * NOTHING here infers a capability from a marketing name, an adapter's position
 * in the list, or a board id. In particular the Wi-Fi generation is the wire's
 * `capabilities.generation` and nothing else: the shipped RTL8852BE prints
 * all-zero EHT structures, so a UI that keyed the badge on "does it mention EHT"
 * would stamp Wi-Fi 7 on a Wi-Fi 6 radio.
 *
 * The consequence worth stating: a kernel that reports LESS reports fewer
 * options here, automatically. There is no per-board table to fall out of date.
 *
 * Two rules from `DESIGN.md` §1 shape what is emitted:
 *
 *   • CT-1 — a POSITIVELY UNSUPPORTED thing contributes ZERO nodes. A radio with
 *     no 6 GHz band gets no 6 GHz entry at all, not a greyed one; a radio that
 *     cannot run station+AP concurrently gets no combo note.
 *   • CT-2 — a thing that IS supported but is currently BLOCKED stays visible,
 *     marked unavailable, with a reason the operator can act on. A 6 GHz radio
 *     under a domain that forbids 6 GHz is exactly that case.
 *
 * Those two are genuinely different facts and must not be collapsed: "this
 * radio cannot do 6 GHz" and "this radio can, and your region does not allow it"
 * call for opposite operator actions.
 */
import type {
	WifiAdapterCapabilities,
	WifiCapabilityBand,
	WifiGeneration,
	WifiSaeSupport,
} from "@ceraui/rpc/schemas";
import { WORLD_REGULATORY_DOMAIN } from "@ceraui/rpc/schemas";

/** Display order for the bands. Ascending frequency, never wire order. */
export const CAPABILITY_BAND_ORDER: readonly WifiCapabilityBand[] = [
	"2.4",
	"5",
	"6",
];

/**
 * i18n key per band. A dotted path segment cannot carry the `2.4` label's own
 * dot, so the key is spelled out rather than interpolated from the wire value.
 */
const BAND_LABEL_KEY: Record<WifiCapabilityBand, string> = {
	"2.4": "network.wifiCapability.band24",
	"5": "network.wifiCapability.band5",
	"6": "network.wifiCapability.band6",
};

/**
 * Why a band the radio CARRIES is nonetheless unavailable right now.
 *
 * `regulatory-domain` is actionable — the operator picks a country and the
 * kernel re-derives what is legal. `self-managed` is NOT: a firmware-regulated
 * wiphy (MediaTek/Intel parts) intersects or ignores a country hint entirely, so
 * offering the country dialog there would be a control that cannot act.
 */
export type BandBlockReason = "regulatory-domain" | "self-managed";

export interface WifiBandOption {
	readonly band: WifiCapabilityBand;
	readonly labelKey: string;
	/** False only when the radio carries the band and something forbids it now. */
	readonly available: boolean;
	/** Widest operating channel the radio itself advertised. Omitted when unreported. */
	readonly maxWidthMhz?: number;
	/** Present only alongside `available: false`. */
	readonly blockedBy?: BandBlockReason;
}

export interface WifiCapabilityView {
	/** The wiphy this describes — a diagnostic tag, never operator-facing copy. */
	readonly phy: string;
	readonly generation: WifiGeneration;
	readonly generationLabelKey: string;
	/** Only the bands the radio actually carries, ascending (CT-1). */
	readonly bands: readonly WifiBandOption[];
	/** The blocked subset of `bands`, so a caller need not re-filter (CT-2). */
	readonly blockedBands: readonly WifiBandOption[];
	/** Absent when the radio cannot do station+AP concurrently (CT-1). */
	readonly comboNoteKey?: string;
	readonly wpa3Sae: WifiSaeSupport;
	/** Regulatory domain OBSERVED for this wiphy, never the country requested. */
	readonly country: string;
	readonly countryIsWorld: boolean;
	readonly selfManagedRegulatory: boolean;
}

/**
 * Turn the wire block into what the row renders — or `undefined` when the device
 * did not compute one.
 *
 * ABSENCE IS THE REGRESSION LOCK. `capabilities` is optional on the wire (no
 * `iw` on the image, an unresolvable wiphy, a dump that failed its parser), and
 * an older backend never sends it at all. `undefined` here means the row renders
 * EXACTLY what it rendered before this module existed — never a blank section,
 * never a "capabilities unavailable" placeholder, which would put a permanent
 * apology on every device running a backend that predates todo 2.
 */
export function deriveWifiCapabilityView(
	capabilities: WifiAdapterCapabilities | undefined,
): WifiCapabilityView | undefined {
	if (!capabilities) return undefined;

	const { regulatory } = capabilities;
	const carried = new Set(capabilities.bands);

	const bands: WifiBandOption[] = [];
	for (const band of CAPABILITY_BAND_ORDER) {
		// CT-1: a band the radio does not carry contributes nothing at all.
		if (!carried.has(band)) continue;

		const blockedBy = blockReasonFor(band, regulatory);
		const maxWidthMhz = capabilities.maxWidthMhz[band];
		bands.push({
			band,
			labelKey: BAND_LABEL_KEY[band],
			available: blockedBy === undefined,
			...(maxWidthMhz === undefined ? {} : { maxWidthMhz }),
			...(blockedBy === undefined ? {} : { blockedBy }),
		});
	}

	const combo = capabilities.staApCombo;
	return {
		phy: capabilities.phy,
		// The ONE source for the badge. Never re-derived from bands, widths, or
		// the presence of an EHT structure.
		generation: capabilities.generation,
		generationLabelKey: `network.wifiCapability.generation.${capabilities.generation}`,
		bands,
		blockedBands: bands.filter((option) => !option.available),
		...(combo.supported
			? {
					comboNoteKey: combo.sameChannelOnly
						? "network.wifiCapability.combo.sameChannel"
						: "network.wifiCapability.combo.anyChannel",
				}
			: {}),
		wpa3Sae: capabilities.wpa3Sae,
		country: regulatory.country,
		countryIsWorld: regulatory.country === WORLD_REGULATORY_DOMAIN,
		selfManagedRegulatory: regulatory.self_managed,
	};
}

/**
 * 6 GHz is the only band the wire can report as carried-but-forbidden, because
 * `is6GhzLegal` is the only per-band legality flag nl80211 gives us. 2.4/5 GHz
 * are never gated here — inventing a block for them would be a claim the device
 * never made.
 */
function blockReasonFor(
	band: WifiCapabilityBand,
	regulatory: WifiAdapterCapabilities["regulatory"],
): BandBlockReason | undefined {
	if (band !== "6" || regulatory.is6GhzLegal) return undefined;
	return regulatory.self_managed ? "self-managed" : "regulatory-domain";
}

/**
 * Whether the blocked band the operator is looking at is one THEY can unblock.
 *
 * Only a `regulatory-domain` block is: the country dialog hands a country to the
 * kernel, which re-derives legality. A self-managed wiphy carries its own rules,
 * so the dialog would change nothing there and must not be offered.
 */
export function blockIsOperatorActionable(option: WifiBandOption): boolean {
	return option.blockedBy === "regulatory-domain";
}

/**
 * The i18n key for a WPA3 chip, or `undefined` when nothing should render.
 *
 * `unsupported` is a POSITIVE answer that this radio cannot do WPA3, so it
 * follows the band rule and draws nothing (CT-1) — the strip lists what the
 * hardware HAS. `unknown` is the opposite and MUST render (CT-3): a full-MAC
 * driver can offload SAE and advertise nothing, so absence of an advertisement
 * is not proof of absence, and rendering it as `unsupported` would be a claim
 * the device never made.
 */
export function wpa3ChipKey(support: WifiSaeSupport): string | undefined {
	if (support === "unsupported") return undefined;
	return `network.wifiCapability.wpa3.${support}`;
}
