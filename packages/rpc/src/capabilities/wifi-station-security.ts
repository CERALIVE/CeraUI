/**
 * The WPA3-SAE station-join rule — pure, browser-safe, shared by BOTH consumers.
 *
 * It lives here for the same reason `device-mode-truth.ts` and
 * `sim-bond-eligibility.ts` do: two layers decide the same question and they
 * must agree BY CONSTRUCTION.
 *
 *   • the frontend `WifiSelectorDialog` decides what an operator is OFFERED;
 *   • the backend `wifi.ts` decides which `key-mgmt` the NetworkManager profile
 *     is WRITTEN with.
 *
 * A row offered for a network the device would then join as WPA2 (and fail) is
 * a lie told to the operator; a row refused for a network the device would have
 * joined fine is a working adapter withheld. Do NOT fork a per-consumer copy.
 *
 * ── The evidence, and why `unknown` FAILS OPEN ─────────────────────────────
 *
 * `wpa3Sae` is a TRI-STATE and only `supported` is proof (see
 * `wifiSaeSupportSchema`). The shipped fleet answers `unknown`: NetworkManager
 * 1.42.4 publishes no SAE/WPA3 key in `WIFI-PROPERTIES` at all, so the nmcli
 * cross-check can only ever CONTRADICT an advertisement, never confirm one.
 *
 * The two directions are therefore deliberately asymmetric:
 *
 *   • OFFERING a WPA3 HOTSPOT requires positive proof — `offeredHotspotSecurity`
 *     ships `wpa3-sae` only on `supported`, because hosting an AP on a radio
 *     nobody has shown can do it is a guess.
 *   • JOINING a WPA3 network requires only the absence of DISPROOF. An
 *     unprovable radio gets to try, and the device's own typed auth failure is
 *     what tells the truth on refusal — never a client-side guess. Refusing on
 *     `unknown` would take WPA3 away from the entire shipped fleet on the
 *     strength of a capability read that structurally cannot answer.
 *
 * So exactly one state withholds the control: `unsupported`, which is a
 * POSITIVE statement that this radio cannot do SAE.
 */
import type { WifiSaeSupport } from '../schemas/wifi.schema';

/**
 * What an nmcli `SECURITY` column says about a scanned network, reduced to the
 * only distinction a station join turns on.
 *
 * `sae-transition` is deliberately its OWN value rather than a flavour of
 * `sae-only`: a WPA2/WPA3 transition-mode AP accepts a plain WPA2 association,
 * so a SAE-incapable adapter joins it perfectly well and NetworkManager's own
 * negotiation picks the right leg. Collapsing the two would both pin a profile
 * to `sae` where `wpa-psk` is what will be used, and refuse a network every
 * adapter in the fleet can join.
 */
export type WifiStationSecurityKind = 'open' | 'sae-only' | 'sae-transition' | 'other';

/** Why a scanned network cannot be offered to THIS adapter. */
export type WifiJoinRefusal = 'sae-unsupported';

/**
 * The SAE marker. nmcli prints `WPA3` for an RSN SAE AKM; some builds print the
 * suffixed `WPA3-Personal`, and a few print the bare AKM name `SAE`. All three
 * are accepted — a spelling this rule fails to recognise silently degrades a
 * WPA3 join to the WPA2 path, which is the failure mode it exists to prevent.
 */
const SAE_TOKEN_RE = /^(?:WPA3(?:-.*)?|SAE)$/;

/**
 * A pre-WPA3 marker. Its presence beside a SAE marker is what makes a network
 * transition-mode rather than SAE-only.
 */
const LEGACY_TOKEN_RE = /^(?:WPA[12]?(?:-.*)?|WEP)$/;

/**
 * An 802.1X marker, matched against the ALREADY-UPPERCASED token. WPA3-Enterprise
 * is NOT SAE — its key management is `wpa-eap`/`wpa-eap-suite-b-192` — so pinning
 * it to `sae` would write a profile the AP refuses. It is excluded rather than
 * mapped, because this build ships no enterprise credential surface.
 */
const ENTERPRISE_TOKEN_RE = /^(?:802\.1X|.*-ENTERPRISE)$/;

/**
 * Classify the free-form nmcli `SECURITY` token list.
 *
 * The input is deliberately a free-form string ({@link
 * WifiSecurity} is `z.string()`): an enum rejected real open and enterprise
 * rows on the bench, and a token this build has never seen must degrade to
 * `other` rather than fail a scan.
 */
export function classifyWifiStationSecurity(security: string | undefined): WifiStationSecurityKind {
	const tokens = (security ?? '')
		.split(/\s+/)
		.map((token) => token.trim().toUpperCase())
		.filter((token) => token.length > 0);

	if (tokens.length === 0) return 'open';

	const hasSae = tokens.some((token) => SAE_TOKEN_RE.test(token));
	if (!hasSae) return 'other';

	if (tokens.some((token) => ENTERPRISE_TOKEN_RE.test(token))) return 'other';
	if (tokens.some((token) => LEGACY_TOKEN_RE.test(token))) return 'sae-transition';

	return 'sae-only';
}

/**
 * True when the NetworkManager profile for this network MUST pin
 * `key-mgmt sae`.
 *
 * SAE-only, and nothing else. A transition-mode network keeps NetworkManager's
 * own auto behaviour, which is what lets one profile serve both legs.
 */
export function requiresSaeKeyMgmt(security: string | undefined): boolean {
	return classifyWifiStationSecurity(security) === 'sae-only';
}

/**
 * Whether this adapter may be offered a join for this network, and why not.
 *
 * FAIL-OPEN by contract: `undefined` (no capability read), `unknown` and
 * `supported` all permit the attempt. Only a POSITIVE `unsupported` withholds
 * it, and only for a network that has no non-SAE leg to fall back on.
 */
export function wifiJoinRefusal(
	security: string | undefined,
	wpa3Sae: WifiSaeSupport | undefined,
): WifiJoinRefusal | undefined {
	if (wpa3Sae !== 'unsupported') return undefined;
	return requiresSaeKeyMgmt(security) ? 'sae-unsupported' : undefined;
}
