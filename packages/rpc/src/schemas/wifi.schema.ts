/**
 * WiFi Zod schemas
 */
import { z } from 'zod';

// Length-only bounds. The hotspot SSID accepts any unicode (no charset
// restriction) and matches the backend's own min-1 check in wifi-hotspot.ts.
export const HOTSPOT_NAME_MIN = 1;
export const HOTSPOT_NAME_MAX = 32;
export const HOTSPOT_PASSWORD_MIN = 8;
export const HOTSPOT_PASSWORD_MAX = 63;
export const WIFI_PASSWORD_MIN = 8;

// Raw nmcli SECURITY token list (e.g. "WPA2", "WPA1 WPA2 802.1X", "" for open).
// The backend passes it through verbatim and the UI matches via substring, so the
// contract is a free-form string — an enum rejected real and mock open/enterprise rows.
export const wifiSecuritySchema = z.string();
export type WifiSecurity = z.infer<typeof wifiSecuritySchema>;

// WiFi band names enum
export const wifiBandSchema = z.enum(['auto', 'auto_50', 'auto_24']);
export type WifiBand = z.infer<typeof wifiBandSchema>;

// A hotspot channel selection: a band-wide auto entry, or a concrete channel
// (`ch_13`) the DEVICE derived at runtime from `iw phy` after applying the
// regulatory domain. The set of legal `ch_N` values is NOT expressible here —
// it depends on the live regdomain and the radio — so this is a SHAPE check
// only. The authoritative acceptance test is the device's own offered set,
// echoed on `hotspotConfigSchema.available_channels`.
export const wifiChannelIdSchema = z
	.string()
	.regex(/^(?:auto|auto_24|auto_50|ch_[1-9][0-9]{0,2})$/, {
		message: 'Channel must be auto, auto_24, auto_50, or a derived ch_<number>',
	});
export type WifiChannelId = z.infer<typeof wifiChannelIdSchema>;

// The kernel's "world" domain: the conservative default when no country is set.
export const WORLD_REGULATORY_DOMAIN = '00';

// ISO-3166-1 alpha-2, or the world domain.
export const REGULATORY_COUNTRY_RE = /^(?:[A-Z]{2}|00)$/;

export const regulatoryCountrySchema = z.string().regex(REGULATORY_COUNTRY_RE, {
	message: 'Country must be an ISO-3166-1 alpha-2 code, or 00 for world',
});
export type RegulatoryCountry = z.infer<typeof regulatoryCountrySchema>;

// An absent `country` clears the selection and returns the radio to world.
export const setWifiCountryInputSchema = z.object({
	country: regulatoryCountrySchema.optional(),
});
export type SetWifiCountryInput = z.infer<typeof setWifiCountryInputSchema>;

export const setWifiCountryOutputSchema = z.object({
	success: z.boolean(),
	// The country actually persisted (post-normalization), absent when cleared.
	applied: regulatoryCountrySchema.optional(),
	// The regulatory domain the KERNEL reports after the change — it can differ
	// from `applied` on an image with no regulatory database, which is precisely
	// the condition the operator needs to see rather than a silent no-op.
	effective: z.string().optional(),
	error: z.enum(['unavailable_in_emulated_mode', 'invalid_country', 'apply_failed']).optional(),
});
export type SetWifiCountryOutput = z.infer<typeof setWifiCountryOutputSchema>;

// ─── per-adapter capability truth (nl80211 / `iw phy`) ──────────────────────
//
// THE RULE: these values are READ BACK from the kernel's own nl80211 answer for
// a specific wiphy, never inferred from a marketing name, a NetworkManager flag,
// or the position of an adapter in a list. NetworkManager's WIFI-PROPERTIES is
// deliberately coarse (WPA/RSN, AP, band presence) — it carries no HE/EHT, no
// channel widths, and no SAE proof — so it is a CROSS-CHECK here and never the
// source.
//
// `wifiBandSchema` above is NOT extended by any of this. That enum is the
// hotspot's NetworkManager band selector, and NM's `802-11-wireless.band` has no
// 6 GHz value at all; 6 GHz here is capability / scan / STA-display truth ONLY.

// The bands a radio can carry, as capability truth. Distinct from
// `wifiBandSchema` on purpose — see the note above.
export const wifiCapabilityBandSchema = z.enum(['2.4', '5', '6']);
export type WifiCapabilityBand = z.infer<typeof wifiCapabilityBandSchema>;

// Derived from the kernel's own capability structures, never from a name:
//   HE present                 ⇒ wifi6
//   HE present + a 6 GHz band  ⇒ wifi6e
//   EHT present AND NON-ZERO   ⇒ wifi7
// An all-zero EHT structure is a KERNEL STUB, not a Wi-Fi 7 radio: the shipped
// RTL8852BE prints `EHT MAC Capabilities (0x0000)` with every MCS/NSS at 0.
export const wifiGenerationSchema = z.enum(['wifi4', 'wifi5', 'wifi6', 'wifi6e', 'wifi7']);
export type WifiGeneration = z.infer<typeof wifiGenerationSchema>;

// WPA3-SAE is TRI-STATE and `unknown` is a first-class answer. Absence of an
// SAE advertisement is NOT proof of absence (a full-MAC driver may offload SAE
// and advertise nothing), so an unprovable radio reports `unknown` rather than
// a guess in either direction.
export const wifiSaeSupportSchema = z.enum(['supported', 'unsupported', 'unknown']);
export type WifiSaeSupport = z.infer<typeof wifiSaeSupportSchema>;

// Max operating channel width the radio itself advertises, per band. A band the
// radio does not carry is OMITTED — never zero-filled, which would read as a
// measured "no width".
export const wifiBandMaxWidthSchema = z.object({
	'2.4': z.number().int().positive().optional(),
	'5': z.number().int().positive().optional(),
	'6': z.number().int().positive().optional(),
});
export type WifiBandMaxWidth = z.infer<typeof wifiBandMaxWidthSchema>;

// STA+AP concurrency, read from the wiphy's `valid interface combinations`.
// `sameChannelOnly` is what `#channels <= 1` means: the AP is pinned to whatever
// channel the station leg is already on.
export const wifiStaApComboSchema = z.object({
	supported: z.boolean(),
	sameChannelOnly: z.boolean(),
});
export type WifiStaApCombo = z.infer<typeof wifiStaApComboSchema>;

// The regulatory state OBSERVED for this wiphy after any apply — never the
// country that was requested. A self-managed wiphy (firmware-regulated Intel /
// MediaTek parts) intersects or ignores a user hint entirely, so applied ≠
// effective has to stay visible.
//
// `self_managed` is emitted as an EXPLICIT `false` when false. It is a
// recoverable field, and the frontend status merge preserves an omitted optional
// key — a present-only-when-true flag can be raised and never lowered (the
// `policy_route_missing` latch).
export const wifiRegulatoryStateSchema = z.object({
	country: z.string(),
	is6GhzLegal: z.boolean(),
	self_managed: z.boolean(),
});
export type WifiRegulatoryState = z.infer<typeof wifiRegulatoryStateSchema>;

export const wifiAdapterCapabilitiesSchema = z.object({
	// The wiphy this describes (`phy0`), resolved from
	// /sys/class/net/<ifname>/phy80211 — never from an adapter's position.
	phy: z.string(),
	generation: wifiGenerationSchema,
	bands: z.array(wifiCapabilityBandSchema),
	maxWidthMhz: wifiBandMaxWidthSchema,
	// The AP interface type intersected with the bands the radio carries.
	apModes: z.array(wifiCapabilityBandSchema),
	staApCombo: wifiStaApComboSchema,
	wpa3Sae: wifiSaeSupportSchema,
	regulatory: wifiRegulatoryStateSchema,
});
export type WifiAdapterCapabilities = z.infer<typeof wifiAdapterCapabilitiesSchema>;

// ─── live link telemetry (`iw dev <ifname> link`) ───────────────────────────
//
// What the STATION LEG negotiated, which is a different fact from what the
// radio CAN do. A Wi-Fi 7 adapter associated to an 802.11ac access point is
// running VHT right now, and `wifiAdapterCapabilitiesSchema.generation` would
// still — correctly — say `wifi7`. Collapsing the two would report the radio's
// ceiling as the operator's live connection.
//
// Read back from the kernel's own link report and never inferred from the
// capability block.
export const wifiLinkTelemetrySchema = z.object({
	// The generation the LINK negotiated, decided by the rate line's own
	// EHT-/HE-/VHT- tokens. Never the adapter's `capabilities.generation`.
	generation: wifiGenerationSchema,
	// OMITTED when the kernel printed no width token at all — a 20 MHz HT link
	// prints none, so a defaulted 20 would be a value nothing measured.
	channelWidthMhz: z.number().int().positive().optional(),
	// Strictly positive: `iw` prints `0.0 MBit/s` for a link that has not
	// negotiated, and a zero reads as a stalled connection rather than as an
	// unreported one — the same rule `hotspotClientSchema` states for a station.
	bitrateMbps: z.number().positive(),
});
export type WifiLinkTelemetry = z.infer<typeof wifiLinkTelemetrySchema>;

// ─── hotspot security offering ──────────────────────────────────────────────
//
// The two security modes a CeraLive hotspot may be configured with. WPA2 is
// always offered; `wpa3-sae` is offered ONLY when the adapter's own capability
// read proved SAE on THIS radio (`wifiAdapterCapabilitiesSchema.wpa3Sae ===
// 'supported'`) — `unknown` is not proof, so it never offers WPA3.
//
// There is deliberately NO `wpa2-wpa3-mixed` member. A transition-mode profile
// has never been brought up on a board against NM 1.42, and an option that
// cannot be shown to work is not shipped. Adding one is a separate, evidenced
// change — not a widening of this enum.
export const hotspotSecurityIdSchema = z.enum(['wpa2', 'wpa3-sae']);
export type HotspotSecurityId = z.infer<typeof hotspotSecurityIdSchema>;

// READ-ONLY display truth: the widest channel the radio advertises for each band
// a hotspot may use. It is NOT a configurable width — NetworkManager 1.42
// exposes no hotspot channel-width property at all, so a settable field here
// would be a control that cannot act.
//
// 2.4/5 GHz ONLY, and that is a hard limit rather than a consequence of what
// this radio happens to carry: `802-11-wireless.band` has no 6 GHz value, so a
// 6 GHz hotspot is unrepresentable however capable the adapter is. The key is
// absent from the schema entirely, so it cannot be emitted by mistake.
export const hotspotBandMaxWidthSchema = z.object({
	'2.4': z.number().int().positive().optional(),
	'5': z.number().int().positive().optional(),
});
export type HotspotBandMaxWidth = z.infer<typeof hotspotBandMaxWidthSchema>;

// ─── joined-client roster ───────────────────────────────────────────────────
//
// One station the AP interface's own `iw dev <ifname> station dump` named. The
// MAC is the only required field BY DESIGN: everything else is a reading the
// station may not have produced yet, and an absent bitrate must render as
// absent rather than as a measured zero (which reads as a stalled client).
export const hotspotClientSchema = z.object({
	mac: z.string(),
	signal_dbm: z.number().optional(),
	tx_bitrate_mbps: z.number().positive().optional(),
	rx_bitrate_mbps: z.number().positive().optional(),
});
export type HotspotClient = z.infer<typeof hotspotClientSchema>;

// How many station rows ride the wire. `count` stays the TRUE total, so a
// capped roster is visibly capped rather than silently truncated — the same
// shape, for the same reason, as the SMS inbox's own cap.
export const HOTSPOT_CLIENTS_ROW_CAP = 32;

// `count` is deliberately NOT `stations.length`: the rows are a bounded window
// onto a total that may exceed it. A device that has never been read omits this
// block entirely — `count: 0` is a MEASURED "nobody is connected" and must stay
// distinguishable from "we never asked".
export const hotspotClientsSchema = z.object({
	count: z.number().int().nonnegative(),
	stations: z.array(hotspotClientSchema).max(HOTSPOT_CLIENTS_ROW_CAP),
});
export type HotspotClients = z.infer<typeof hotspotClientsSchema>;

// ─── the operator-facing per-adapter mode ───────────────────────────────────
//
// THREE modes an operator can ask a radio for, and they are DELIBERATELY not a
// third value of `wifiInterfaceSchema.mode`. That field reports what the radio
// IS — `station` or `hotspot` — and a hybrid radio really is a station that
// additionally hosts an AP on a second, virtual `clap-<parent>` netdev. So the
// three-way selector maps onto the EXISTING model rather than widening it:
//
//   station  ->  mode: 'station'
//   hotspot  ->  mode: 'hotspot'   (exclusive AP on the physical interface)
//   hybrid   ->  mode: 'station'   + a concurrent AP on `clap-<parent>`
//
// Getting that wrong would be observable: `mode === 'station'` during a
// concurrent AP is a pinned device assertion, and every bond/probe/telemetry
// rule that keys on the physical radio still being a station depends on it.
export const wifiAdapterModeSchema = z.enum(['station', 'hotspot', 'hybrid']);
export type WifiAdapterMode = z.infer<typeof wifiAdapterModeSchema>;

// Why a mode is not on offer for THIS radio. Each names a different thing an
// operator can do about it, so none is collapsible into a generic "no":
//
//   unsupported        the radio cannot host an access point at all
//   capability-absent  the wiphy ANSWERED, and its interface combinations
//                      forbid a managed + AP pair — a proven negative
//   capability-unknown nothing has proven it either way (no `iw`, an
//                      unresolvable wiphy, a dump that failed its parser)
//
// `capability-unknown` is NOT `capability-absent`: absence of evidence is not
// evidence of absence, and telling an operator their radio cannot do something
// we never managed to ask about is the dishonesty this vocabulary exists to
// prevent.
export const wifiAdapterModeUnavailableReasonSchema = z.enum([
	'unsupported',
	'capability-absent',
	'capability-unknown',
]);
export type WifiAdapterModeUnavailableReason = z.infer<
	typeof wifiAdapterModeUnavailableReasonSchema
>;

// One row of the offered set. `available` is an EXPLICIT boolean, never a
// present-only-when-true flag: an unavailable mode must render disabled WITH
// its reason, never be hidden, so a consumer has to be able to see the refusal.
export const wifiAdapterModeOptionSchema = z.object({
	mode: wifiAdapterModeSchema,
	available: z.boolean(),
	reason: wifiAdapterModeUnavailableReasonSchema.optional(),
});
export type WifiAdapterModeOption = z.infer<typeof wifiAdapterModeOptionSchema>;

// What one adapter answers about its own mode.
//
// `mode` is OBSERVED (what the radio is doing right now) and `desired` is the
// PERSISTED operator preference. They are separate because they legitimately
// disagree: during a transition, and after a boot reconciliation that could not
// reach the operator's choice. Collapsing them would report an unreached
// preference as achieved.
//
// `options` is TOTAL — all three modes, always — so a consumer never has to
// decide whether a missing entry means "unavailable" or "not reported".
export const wifiAdapterModeEntrySchema = z.object({
	ifname: z.string(),
	mode: wifiAdapterModeSchema,
	desired: wifiAdapterModeSchema.optional(),
	options: z.array(wifiAdapterModeOptionSchema),
});
export type WifiAdapterModeEntry = z.infer<typeof wifiAdapterModeEntrySchema>;

// Keyed by the same numeric device id `wifiStatusSchema` is keyed on.
export const wifiAdapterModeStatusSchema = z.record(z.string(), wifiAdapterModeEntrySchema);
export type WifiAdapterModeStatus = z.infer<typeof wifiAdapterModeStatusSchema>;

// `.strict()` because this switches a radio between operating modes — an
// unknown extra key must be REJECTED rather than silently ignored.
export const setWifiAdapterModeInputSchema = z
	.object({
		device: z.string(),
		mode: wifiAdapterModeSchema,
	})
	.strict();
export type SetWifiAdapterModeInput = z.infer<typeof setWifiAdapterModeInputSchema>;

/*
  Why a mode change did not complete. The first five are `hotspotToggleError`'s
  own members, deliberately reused rather than re-spelled — a mode change IS a
  hotspot start/stop underneath, so a refusal must read identically whichever
  control produced it. `capability-unproven` is the one addition: `hybrid` was
  asked for on a radio whose AP+STA combination has not been proven.
*/
export const wifiAdapterModeErrorSchema = z.enum([
	'DEVICE_BUSY',
	'no-device',
	'unsupported',
	'capability-unproven',
	'activation-failed',
	'not-confirmed',
	'deactivation-failed',
]);
export type WifiAdapterModeError = z.infer<typeof wifiAdapterModeErrorSchema>;

/*
  The reply to `wifi.setAdapterMode`.

  `accepted` carries exactly `hotspotToggleOutputSchema.accepted`'s meaning: the
  transition was admitted and a TERMINAL `wifi` -> `adapter_mode` frame follows.
  It is never a claim that the radio has reached the mode.
*/
export const setWifiAdapterModeOutputSchema = z.object({
	success: z.boolean(),
	accepted: z.literal(true).optional(),
	// The mode actually persisted. Absent on a refusal, because a refused
	// transition must not echo the value back as though it had been recorded.
	applied: wifiAdapterModeSchema.optional(),
	error: wifiAdapterModeErrorSchema.optional(),
});
export type SetWifiAdapterModeOutput = z.infer<typeof setWifiAdapterModeOutputSchema>;

// A pending or terminal mode-change frame — the deferred half of an `accepted`
// reply. Exactly one `pending: true` frame is emitted per admitted transition,
// followed by exactly one terminal frame (`success` or `error`).
export const wifiAdapterModeResultSchema = z.object({
	device: z.union([z.number(), z.string()]),
	mode: wifiAdapterModeSchema.optional(),
	pending: z.literal(true).optional(),
	success: z.boolean().optional(),
	error: wifiAdapterModeErrorSchema.optional(),
});
export type WifiAdapterModeResult = z.infer<typeof wifiAdapterModeResultSchema>;

// Available WiFi network schema
export const availableWifiNetworkSchema = z.object({
	active: z.boolean(),
	ssid: z.string(),
	signal: z.number(),
	security: wifiSecuritySchema,
	freq: z.number(),
});
export type AvailableWifiNetwork = z.infer<typeof availableWifiNetworkSchema>;

// Hotspot config schema
export const hotspotConfigSchema = z.object({
	// name/password/channel mirror the backend's optional WifiHotspot fields — the
	// status builder omits any that are unset, so they can be absent on the wire.
	name: z.string().optional(),
	password: z.string().optional(),
	// Keyed by `wifiChannelIdSchema` — the auto entries plus every channel the
	// device derived from the live regulatory domain. This map IS the offered
	// set: a channel absent from it is rejected by the device.
	available_channels: z.record(wifiChannelIdSchema, z.object({ name: z.string() })),
	channel: wifiChannelIdSchema.optional(),
	// The security modes the DEVICE derived for this adapter, on exactly the
	// terms `available_channels` is offered: this map IS the offered set, and a
	// value absent from it is rejected. Optional on the wire because a device
	// predating this field omits it — absent means "not derived", which the UI
	// must read as WPA2-only rather than as an empty offering.
	available_security: z.record(hotspotSecurityIdSchema, z.object({ name: z.string() })).optional(),
	security: hotspotSecurityIdSchema.optional(),
	// Display only. There is no configurable width anywhere in this contract.
	max_width_mhz: hotspotBandMaxWidthSchema.optional(),
	// Who is joined RIGHT NOW, from the AP interface's own station dump. Absent
	// means the device has not read it (an older backend, or an AP whose first
	// read has not landed); `count: 0` means it read and nobody is connected.
	clients: hotspotClientsSchema.optional(),
});
export type HotspotConfig = z.infer<typeof hotspotConfigSchema>;

// WiFi interface schema
export const wifiInterfaceSchema = z.object({
	ifname: z.string(),
	conn: z.string(),
	hw: z.string(),
	hotspot: hotspotConfigSchema.optional(),
	// Absent on a hotspot-mode interface (which carries `hotspot` instead) and on
	// an interface that cannot host a hotspot — the backend omits both there.
	available: z.array(availableWifiNetworkSchema).optional(),
	saved: z.record(z.string(), z.string()),
	supports_hotspot: z.boolean().optional(),
	supports_ap_sta_concurrency: z.boolean().optional(),
	transition: z.enum(['activating', 'deactivating']).optional(),
	mode: z.enum(['station', 'hotspot']).optional(),
	// Absent means NOT COMPUTED — no `iw` on the image, a wiphy that could not be
	// resolved for this interface, or a dump that failed its named parser. Once
	// computed it is emitted on EVERY tick, so a consumer never has to decide
	// whether a missing block means "unchanged" or "withdrawn".
	capabilities: wifiAdapterCapabilitiesSchema.optional(),
	// The station leg's LIVE negotiated rate. Absent on an AP-mode radio (which
	// has no station leg to report), on a station holding no connection, on a
	// read that failed its named parser, and on a backend predating the field —
	// so a consumer must read absence as "not measured", never as a dead link.
	link: wifiLinkTelemetrySchema.optional(),
	// How many scan cycles THIS adapter has completed since the backend started.
	//
	// A rescan RPC returns the moment nmcli is dispatched, and there is no
	// scan-complete marker anywhere in nmcli's output — so a consumer that wants
	// to know its scan finished has to be told. Comparing the CONTENT of
	// `available` cannot answer it: a scan that legitimately finds the same set
	// (or nothing at all) leaves the content byte-identical, which is
	// indistinguishable from a scan that never ran.
	//
	// This counter is therefore stamped by the DEVICE on every scan cycle that
	// completed, INCLUDING one whose result list is empty, and is strictly
	// increasing per adapter. A consumer confirms by comparing it against the
	// value it captured at dispatch; a HIGHER value means "a scan finished", and
	// the accompanying `available` list — empty or not — is that scan's honest
	// result.
	//
	// It is PER ADAPTER on purpose. Two radios scan independently, so one
	// adapter's completed scan must never confirm another's in-flight one.
	//
	// Absent means the device has completed no scan cycle for this adapter yet,
	// or the backend predates the field. A consumer must read absence as "not
	// reported", never as generation zero.
	scanGeneration: z.number().int().nonnegative().optional(),
	// Epoch ms at which the scan named by `scanGeneration` completed. Diagnostic
	// only — the CONFIRMATION signal is the generation, never this stamp, because
	// a wall clock can move backwards and a monotonic counter cannot. Absent
	// exactly when `scanGeneration` is absent.
	scanAt: z.number().int().nonnegative().optional(),
});
export type WifiInterface = z.infer<typeof wifiInterfaceSchema>;

// WiFi status schema (keyed by device ID)
export const wifiStatusSchema = z.record(z.string(), wifiInterfaceSchema);
export type WifiStatus = z.infer<typeof wifiStatusSchema>;

// WiFi connect input schema
export const wifiConnectInputSchema = z.object({
	uuid: z.string(),
});
export type WifiConnectInput = z.infer<typeof wifiConnectInputSchema>;

// WiFi disconnect input schema
export const wifiDisconnectInputSchema = z.object({
	uuid: z.string(),
});
export type WifiDisconnectInput = z.infer<typeof wifiDisconnectInputSchema>;

// WiFi new connection input schema.
//
// `security` is the scanned row's own nmcli SECURITY token list, forwarded
// verbatim so the device can decide whether the profile must pin `key-mgmt sae`
// (see `capabilities/wifi-station-security.ts`). It reuses the free-form
// `wifiSecuritySchema` for that schema's own stated reason — an enum rejected
// real open/enterprise rows — and is optional, so a client that omits it gets
// the byte-identical pre-WPA3 behaviour.
export const wifiNewInputSchema = z.object({
	device: z.string(),
	ssid: z.string().min(1, 'SSID cannot be empty'),
	password: z.string().min(WIFI_PASSWORD_MIN, 'Password must be at least 8 characters'),
	security: wifiSecuritySchema.optional(),
});
export type WifiNewInput = z.infer<typeof wifiNewInputSchema>;

// WiFi forget input schema
export const wifiForgetInputSchema = z.object({
	uuid: z.string(),
});
export type WifiForgetInput = z.infer<typeof wifiForgetInputSchema>;

// WiFi scan input schema
export const wifiScanInputSchema = z.object({
	device: z.string(),
});
export type WifiScanInput = z.infer<typeof wifiScanInputSchema>;

// Hotspot start/stop input schema
export const hotspotToggleInputSchema = z.object({
	device: z.string(),
});
export type HotspotToggleInput = z.infer<typeof hotspotToggleInputSchema>;

/*
  Why a hotspot start/stop did not complete. Every member names a DIFFERENT
  thing an operator can do about it, so none of them is collapsible into a
  generic error:

    DEVICE_BUSY          another mutation holds this radio — retry
    no-device            the wire id names no adapter this device can see
    unsupported          the radio cannot host an access point at all
    activation-failed    NetworkManager refused; the adapter was rolled back
    not-confirmed        activation was issued and NM never confirmed the AP
    deactivation-failed  NetworkManager did not take the hotspot down
*/
export const hotspotToggleErrorSchema = z.enum([
	'DEVICE_BUSY',
	'no-device',
	'unsupported',
	'activation-failed',
	'not-confirmed',
	'deactivation-failed',
]);
export type HotspotToggleError = z.infer<typeof hotspotToggleErrorSchema>;

/*
  The reply to `wifi.hotspotStart` / `wifi.hotspotStop`.

  `accepted` is present ONLY when the transaction was admitted and the device
  cannot yet vouch for NetworkManager's verdict — a hotspot start registers a
  bounded NM confirmation that resolves after this reply. It is a promise that a
  TERMINAL `wifi` frame follows (`hotspot.start` / `hotspot.stop`, carrying
  `success: true` or a typed `error`), never a claim that the AP is up. A reply
  WITHOUT it is already terminal: `success: true` means the device confirmed the
  outcome itself, `success: false` carries the reason.
*/
export const hotspotToggleOutputSchema = z.object({
	success: z.boolean(),
	accepted: z.literal(true).optional(),
	error: hotspotToggleErrorSchema.optional(),
});
export type HotspotToggleOutput = z.infer<typeof hotspotToggleOutputSchema>;

// Hotspot config input schema
export const hotspotConfigInputSchema = z.object({
	device: z.string(),
	name: z
		.string()
		.min(HOTSPOT_NAME_MIN, 'Hotspot name must be at least 1 character')
		.max(HOTSPOT_NAME_MAX, 'Hotspot name must be at most 32 characters'),
	password: z
		.string()
		.min(HOTSPOT_PASSWORD_MIN, 'Password must be at least 8 characters')
		.max(HOTSPOT_PASSWORD_MAX, 'Password must be at most 63 characters'),
	channel: wifiChannelIdSchema,
	// Omitted leaves the adapter's current selection alone, so an existing
	// caller keeps its exact behaviour. A stated value is still checked against
	// the device's own offered set before anything is written.
	security: hotspotSecurityIdSchema.optional(),
});
export type HotspotConfigInput = z.infer<typeof hotspotConfigInputSchema>;

// WiFi operation output schema
export const wifiOperationOutputSchema = z.object({
	success: z.boolean(),
	// 'DEVICE_BUSY': per-device lock rejected a concurrent op (additive member).
	error: z.enum(['auth', 'generic', 'DEVICE_BUSY']).optional(),
});
export type WifiOperationOutput = z.infer<typeof wifiOperationOutputSchema>;

// A terminal hotspot start/stop frame: the deferred half of an `accepted` reply.
export const hotspotToggleResultSchema = z.object({
	device: z.union([z.number(), z.string()]),
	success: z.boolean().optional(),
	error: hotspotToggleErrorSchema.optional(),
});
export type HotspotToggleResult = z.infer<typeof hotspotToggleResultSchema>;

// WiFi message schema (response from WiFi operations)
export const wifiMessageSchema = z.object({
	connect: z.array(z.string()).optional(),
	device: z.union([z.number(), z.string()]).optional(),
	disconnect: z.string().optional(),
	new: z
		.object({
			// 'ambiguous': the join reported no error and named no connection, so
			// the device cannot say whether the network was actually joined.
			error: z.enum(['auth', 'generic', 'ambiguous']).optional(),
			device: z.union([z.number(), z.string()]).optional(),
			success: z.boolean().optional(),
		})
		.optional(),
	adapter_mode: wifiAdapterModeResultSchema.optional(),
	hotspot: z
		.object({
			start: hotspotToggleResultSchema.optional(),
			stop: hotspotToggleResultSchema.optional(),
			config: z
				.object({
					device: z.union([z.number(), z.string()]),
					success: z.boolean().optional(),
					error: z.string().optional(),
				})
				.optional(),
		})
		.optional(),
});
export type WifiMessage = z.infer<typeof wifiMessageSchema>;
