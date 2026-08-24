/**
 * Modem Zod schemas
 */
import { z } from 'zod';

import {
	CAPABILITY_MODULE_MUTATION_KINDS,
	CAPABILITY_MODULE_MUTATION_REFUSALS,
	capabilityModuleClaimsSchema,
} from './capability-modules.schema';

// Modem network type enum
export const modemNetworkTypeSchema = z.enum(['3g', '4g', '4g3g', '5g', '5g4g', '5g3g', '5g4g3g']);
export type ModemNetworkType = z.infer<typeof modemNetworkTypeSchema>;

/**
 * Connection status — ModemManager's `MMModemState` verbatim, because
 * `status.connection` is mmcli's `modem.generic.state` verbatim (backend
 * `modem-registration.ts::buildModemStatus`).
 *
 * The five tokens this enum used to hold are only the ones a CONNECTING modem
 * passes through. Board-confirmed cost: a Quectel RM530N-GL in the ordinary
 * `enabled` state failed OUTPUT validation, which rejects the WHOLE `modems`
 * payload — every modem vanished from the UI while `mmcli -L` listed two.
 *
 * `scanning` is NOT an MM state — it is CeraUI's own operator-scan override.
 */
export const connectionStatusSchema = z.enum([
	'failed',
	'unknown',
	'initializing',
	'locked',
	'disabled',
	'disabling',
	'enabling',
	'enabled',
	'searching',
	'registered',
	'disconnecting',
	'connecting',
	'connected',
	'scanning',
]);
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

/**
 * A token outside the enum degrades to `unknown` instead of rejecting the
 * payload: this field is validated on the OUTPUT side, where one unrecognised
 * token (a future MM release, a vendor plugin) blanks every modem on the device
 * rather than the one field it came from.
 */
const UNKNOWN_CONNECTION_STATUS: ConnectionStatus = 'unknown';

// Modem network display type
export const modemNetworkDisplaySchema = z.enum(['4G', '3G', '5G', 'Unknown']);
export type ModemNetworkDisplay = z.infer<typeof modemNetworkDisplaySchema>;

// Modem config schema
export const modemConfigSchema = z.object({
	apn: z.string(),
	username: z.string(),
	password: z.string(),
	roaming: z.boolean(),
	network: z.string(),
	autoconfig: z.boolean().optional(),
	// Whether this device can honour Automatic APN AT ALL, so the dialog can
	// disable the switch with a reason instead of accepting a choice it will
	// then silently discard. ABSENT = a backend that predates the field: the
	// switch stays offered, exactly as before.
	autoconfig_supported: z.boolean().optional(),
});
export type ModemConfig = z.infer<typeof modemConfigSchema>;

// Modem status schema
export const modemStatusSchema = z.object({
	connection: connectionStatusSchema.catch(UNKNOWN_CONNECTION_STATUS),
	ModemNetwork: z.string().optional(),
	network_type: z.string(),
	signal: z.number(),
	roaming: z.boolean(),
	network: z.string().optional(),
});
export type ModemStatus = z.infer<typeof modemStatusSchema>;

// Available network schema. `availability` is OPTIONAL: the backend legitimately
// emits name-only entries (a saved-but-unscanned operator, and an "unknown"-
// availability scan result whose availability is deliberately dropped). Do not
// make it required — that reintroduces an order-dependent output-validation bug.
export const availableNetworkSchema = z.object({
	name: z.string(),
	availability: z.enum(['available', 'unavailable']).optional(),
});
export type AvailableNetwork = z.infer<typeof availableNetworkSchema>;

// SIM lock state enum (ModemManager `modem.generic.unlock-required` tokens)
export const simLockRequiredSchema = z.enum([
	'none',
	'sim-pin',
	'sim-pin2',
	'sim-puk',
	'sim-puk2',
	'unknown',
]);
export type SimLockRequired = z.infer<typeof simLockRequiredSchema>;

// Per-modem SIM lock snapshot
export const simLockSchema = z.object({
	required: simLockRequiredSchema,
	remainingAttempts: z.number().int().nonnegative().optional(),
});
export type SimLock = z.infer<typeof simLockSchema>;

// SIM PIN length bounds (source of truth for the unlock regex + ValidationAdapter)
export const SIM_PIN_MIN_LENGTH = 4;
export const SIM_PIN_MAX_LENGTH = 8;

// A carrier-issued SIM PUK is always exactly 8 digits.
export const SIM_PUK_LENGTH = 8;

// ── Phase-B additive-optional detail fields ──────────────────────────────────
// EVERY schema below is ADDITIVE-OPTIONAL. A modem entry that omits all of them
// parses byte-identically to the pre-Phase-B wire shape, so an old backend paired
// with a new frontend (or the reverse) still round-trips. This is pinned by the
// legacy-payload fixture in `modems.schema.test.ts`. Never promote one of these
// to required — that is a breaking wire change, not a tightening.

// Transport / device class the modem is attached over. Read-only observation from
// the classifier; `router-ethernet` is a dongle running its own embedded router,
// which ModemManager never manages.
export const modemDeviceClassSchema = z.enum([
	'usb',
	'pcie-mhi',
	'pcie-mtk',
	'soc-qrtr',
	'router-ethernet',
]);
export type ModemDeviceClass = z.infer<typeof modemDeviceClassSchema>;

// Per-modem recovery-ladder state. Read-only.
export const modemRecoveryStateSchema = z.enum([
	'absent',
	'detected',
	'initializing',
	'registered',
	'connecting',
	'online',
	'degraded',
	'recovering',
]);
export type ModemRecoveryState = z.infer<typeof modemRecoveryStateSchema>;

// Active / recommended USB composition mode. `usb_mode` is a read-only
// observation from the classifier; `recommended_usb_mode` is a per-SKU
// most-stable advisory — informational, never gating.
export const usbCompositionModeSchema = z.enum([
	'qmi',
	'mbim',
	'ecm-ncm',
	'rndis',
	'router-ethernet',
]);
export type UsbCompositionMode = z.infer<typeof usbCompositionModeSchema>;

// Cellular data-usage OBSERVATION (Phase-A A4.3 sampler semantics). Every counter
// is CUMULATIVE WIRE BYTES (RX+TX), never a rate and never a kbps figure —
// `session_bytes` accumulates for the current kernel boot, `cycle_bytes` for the
// current UTC billing cycle (whose rollover clamps to the month's length, so a
// `cycle_day` of 31 rolls on Feb 28/29).
//
// `cycle_day` / `threshold_bytes` restate the operator's configured meter bounds
// AS THE COUNTERS SAW THEM — they belong to an observation, so they are present
// only when a counter observation is. The authoritative, always-reported copy of
// the same two numbers is `modem.data_usage_policy` below, which exists whether or
// not anything has counted a byte yet.
// ── The shared modem MUTATION-SAFETY contract (Phase C) ──────────────────────
// Every path that MUTATES a modem — MM/NM config, SIM PIN/PUK/PIN2, a network
// scan, a router-admin write, the remote `modem.reconfig` op, and the USB-mode
// switch — takes ONE per-physical-device mutation lease and journals its
// pre-state durably BEFORE acting. These are the wire types that contract shares
// with its operator surfaces.

/**
 * The journal document version. A stored entry that does not carry EXACTLY this
 * version is not upgraded in place and not guessed at — replay refuses it and
 * leaves the device blocked, because a mutation record we cannot read is
 * precisely the case fail-closed exists for.
 */
export const MODEM_MUTATION_JOURNAL_VERSION = 1;

/**
 * Which mutating surface armed the entry. It is recorded because the rollback a
 * failed mutation needs is kind-specific — restoring an APN is not restoring a
 * USB composition mode — and because an operator reading a blocked device needs
 * to be told which action left it that way.
 */
export const modemMutationKindSchema = z.enum([
	'usb-mode',
	'modem-config',
	'sim-unlock',
	'sim-puk',
	'sim-pin2',
	'network-scan',
	'router-admin',
	// A router dongle's LAN-subnet rewrite. DISTINCT from `router-admin` because
	// it is the one router write that can cost the path to the very device that
	// must receive the next one, so it is journaled with its own pre-state shape
	// and its own rollback handler while `router-admin` stays lease-only.
	'router-subnet',
	'remote-reconfig',
	// One kind per MUTATING capability module (`capability-modules.schema.ts`).
	// SMS contributes none — that surface is permanently read-only, so it has no
	// journal kind to name and therefore cannot be journaled at all.
	...CAPABILITY_MODULE_MUTATION_KINDS,
]);
export type ModemMutationKind = z.infer<typeof modemMutationKindSchema>;

/**
 * The journal state machine.
 *
 * `armed → executing → completed | failed → acknowledged` is the ordinary life
 * of a mutation. The remaining three states exist because a physical device can
 * LEAVE, and a device that left must never strand the whole bond:
 *
 *   device-absent-quarantine — the journaled device is not present at replay or
 *     acknowledgement time. That PHYSICAL IDENTITY stays mutation-blocked and its
 *     entry is retained, so fail-closed handling resumes if it ever returns
 *     (return-of-device transitions it BACK to `failed`).
 *   decommissioned — the operator explicitly confirmed the device is gone. Only
 *     that identity stays mutation-blocked; GLOBAL streaming is unblocked, so a
 *     destroyed modem can never permanently strand the remaining links. It is
 *     deliberately NOT irrevocably terminal: identity is PORT-based for
 *     serial-less devices, so a REPLACEMENT modem in the same port inherits the
 *     key.
 *   recommission-pending — a device is present at a decommissioned identity.
 *     Mutations stay refused until an explicit operator REBASELINE captures,
 *     validates and journals the current device as the new baseline.
 */
export const modemMutationStateSchema = z.enum([
	'armed',
	'executing',
	'completed',
	'failed',
	'acknowledged',
	'device-absent-quarantine',
	'decommissioned',
	'recommission-pending',
]);
export type ModemMutationState = z.infer<typeof modemMutationStateSchema>;

/**
 * Acknowledging a FAILED mutation is not blind unblocking — a failed rollback
 * means the modem's true state is unknown, so a bare alert dismissal must never
 * clear it. There are exactly two typed paths, and both END in a proven baseline:
 *
 *   verified-rollback — the helper re-reads the device and CONFIRMS it matches
 *     the journaled pre-state (the rollback did land, late or externally).
 *   force-rebaseline  — the operator explicitly accepts the CURRENT hardware
 *     state, which the helper captures, validates, and journals as the new
 *     baseline.
 */
export const modemMutationAckModeSchema = z.enum(['verified-rollback', 'force-rebaseline']);
export type ModemMutationAckMode = z.infer<typeof modemMutationAckModeSchema>;

/**
 * Why a mutating entrypoint refused. Each names a DIFFERENT operator action and
 * they are never collapsed:
 *   identity_unresolved   — the target has no resolvable stable physical key, so
 *                           nothing could be journaled and nothing was mutated.
 *   mutation_in_progress  — another mutation holds this device's lease.
 *   streaming_active      — a stream is live or being admitted (reciprocal).
 *   recovery_pending      — journal replay has not finished; ask again.
 *   mutation_blocked      — a failed rollback holds this device fail-closed.
 *   device_decommissioned — this identity was decommissioned by the operator.
 *   rebaseline_required   — a device returned at a decommissioned identity and
 *                           needs an explicit rebaseline before it may be used.
 */
export const modemMutationRefusalSchema = z.enum([
	'identity_unresolved',
	'mutation_in_progress',
	'streaming_active',
	'recovery_pending',
	'mutation_blocked',
	'device_decommissioned',
	'rebaseline_required',
]);
export type ModemMutationRefusal = z.infer<typeof modemMutationRefusalSchema>;

/**
 * What a CAPABILITY-MODULE mutation may answer: every shared mutation-safety
 * refusal, plus the two feature-gate ones.
 *
 * They are a SUPERSET rather than members of the shared enum because a gate
 * refusal is a different kind of fact — it is about whether this build and this
 * operator have made the module reachable at all, not about whether the device is
 * safe to mutate right now. Folding them in would oblige every pre-existing
 * mutating surface (a USB-mode switch, an APN write) to declare refusals it can
 * never produce.
 */
export const capabilityMutationRefusalSchema = z.enum([
	...modemMutationRefusalSchema.options,
	...CAPABILITY_MODULE_MUTATION_REFUSALS,
]);
export type CapabilityMutationRefusal = z.infer<typeof capabilityMutationRefusalSchema>;

/** One journaled transition, retained so a blocked device can explain itself. */
export const modemMutationHistoryEntrySchema = z.object({
	state: modemMutationStateSchema,
	at: z.number().int().nonnegative(),
	detail: z.string().optional(),
});
export type ModemMutationHistoryEntry = z.infer<typeof modemMutationHistoryEntrySchema>;

/** History is bounded so a flapping device cannot grow its journal without end. */
export const MODEM_MUTATION_HISTORY_CAP = 32;

export const modemMutationEntrySchema = z.object({
	version: z.literal(MODEM_MUTATION_JOURNAL_VERSION),
	stableKey: z.string().min(1),
	kind: modemMutationKindSchema,
	state: modemMutationStateSchema,
	attemptId: z.string().min(1),
	startedAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
	// The kind-specific snapshot the rollback restores TO. Opaque here on purpose:
	// the rollback helper for each kind owns its shape, and the journal's job is
	// to persist it byte-faithfully rather than to understand it.
	preState: z.record(z.string(), z.unknown()),
	detail: z.string().optional(),
	acknowledgedMode: modemMutationAckModeSchema.optional(),
	history: z.array(modemMutationHistoryEntrySchema).max(MODEM_MUTATION_HISTORY_CAP),
});
export type ModemMutationEntry = z.infer<typeof modemMutationEntrySchema>;

/** A blocked device as an operator surface reads it. */
export const modemMutationBlockSchema = z.object({
	stableKey: z.string().min(1),
	kind: modemMutationKindSchema,
	state: modemMutationStateSchema,
	updatedAt: z.number().int().nonnegative(),
	detail: z.string().optional(),
	devicePresent: z.boolean(),
	// Whether this entry ALSO holds global stream autostart. A decommissioned
	// identity blocks only itself, which is what stops a destroyed modem from
	// stranding the remaining links.
	blocksStreaming: z.boolean(),
});
export type ModemMutationBlock = z.infer<typeof modemMutationBlockSchema>;

export const modemMutationListOutputSchema = z.object({
	replayComplete: z.boolean(),
	blocks: z.array(modemMutationBlockSchema),
});
export type ModemMutationListOutput = z.infer<typeof modemMutationListOutputSchema>;

// `.strict()` + `confirm: z.literal(true)` for the same reason `setUsbMode` has
// them: every one of these three actions changes what the device believes about
// hardware it could not verify, so none may be issued by accident.
export const modemMutationAckInputSchema = z
	.object({
		stableKey: z.string().min(1),
		mode: modemMutationAckModeSchema,
		confirm: z.literal(true),
	})
	.strict();
export type ModemMutationAckInput = z.infer<typeof modemMutationAckInputSchema>;

export const modemMutationAckRefusalSchema = z.enum([
	'no_entry',
	'not_blocked',
	// The device is present but does NOT match the journaled pre-state, so the
	// rollback demonstrably did not land. Refusing keeps it blocked rather than
	// clearing a claim the hardware contradicts.
	'state_mismatch',
	'device_absent',
	'read_failed',
	'journal_write_failed',
]);
export type ModemMutationAckRefusal = z.infer<typeof modemMutationAckRefusalSchema>;

export const modemMutationAckOutputSchema = z.object({
	success: z.boolean(),
	error: modemMutationAckRefusalSchema.optional(),
	state: modemMutationStateSchema.optional(),
});
export type ModemMutationAckOutput = z.infer<typeof modemMutationAckOutputSchema>;

export const modemMutationDecommissionInputSchema = z
	.object({ stableKey: z.string().min(1), confirm: z.literal(true) })
	.strict();
export type ModemMutationDecommissionInput = z.infer<typeof modemMutationDecommissionInputSchema>;

export const modemMutationRebaselineInputSchema = z
	.object({ stableKey: z.string().min(1), confirm: z.literal(true) })
	.strict();
export type ModemMutationRebaselineInput = z.infer<typeof modemMutationRebaselineInputSchema>;

export const modemDataUsageSchema = z.object({
	session_bytes: z.number().int().nonnegative(),
	cycle_bytes: z.number().int().nonnegative(),
	cycle_day: z.number().int().min(1).max(31).optional(),
	threshold_bytes: z.number().int().nonnegative().optional(),
});
export type ModemDataUsage = z.infer<typeof modemDataUsageSchema>;

// The operator's data-usage POLICY — a SETTING, not a measurement, which is why
// it is its own block rather than more fields on `data_usage`.
//
// The distinction is load-bearing on real hardware. `data_usage` is produced ONLY
// by the D-Bus backend's observation fold, and no shipped device runs that backend
// (`modem_backend` resolves to `mmcli` everywhere), so on every board in the field
// `data_usage` is absent — and a policy folded into it would be unreportable and
// therefore unsettable on exactly the devices this exists for. A policy is knowable
// without a single counted byte, so it is published on its own.
//
// `supported` is the runtime capability, published EXPLICITLY on every row rather
// than present-only-when-true: the frontend merge preserves an omitted optional
// field, so a true-only flag can be raised and never lowered (the
// `policy_route_missing` latch). It reports whether the pinned
// `@ceralive/modem-control` actually exposes `setUsagePolicy` — the package gained
// it at 1.0.0, so a device still pinned to 0.2.0 answers `false` and the UI
// disables the controls with a reason instead of accepting a write it would drop.
export const modemDataUsagePolicySchema = z.object({
	supported: z.boolean(),
	cycle_day: z.number().int().min(1).max(31).optional(),
	threshold_bytes: z.number().int().nonnegative().optional(),
});
export type ModemDataUsagePolicy = z.infer<typeof modemDataUsagePolicySchema>;

// Read-only eSIM facts. The EID is deliberately NOT on this wire: it is a
// Phase-A redaction class (alongside ICCID/IMSI/APN credentials) and nothing in
// the UI needs it to tell a physical SIM from an eSIM profile state.
export const modemEsimSchema = z.object({
	sim_type: z.enum(['physical', 'esim', 'unknown']).optional(),
	esim_status: z.enum(['no-profiles', 'with-profiles', 'unknown']).optional(),
});
export type ModemEsim = z.infer<typeof modemEsimSchema>;

/**
 * Why the network refused to register this modem — ModemManager's
 * `modem.3gpp.network-rejection-*` block, verbatim.
 *
 * A radio can sit in `searching` indefinitely on a strong signal with a healthy
 * SIM; only this block says why. The bench Quectel is the case: 81% signal,
 * `no-cells-in-location-area` from an LTE cell of operator `999999`. Without it
 * an operator concludes the hardware is broken.
 *
 * Every field is a RAW MACHINE TOKEN, keyed to operator copy before display —
 * same rule as `availability_reason`. Only `error` is required: mmcli prints
 * `--` (⇒ absent) for the rest routinely.
 */
export const modemRegistrationRejectionSchema = z.object({
	error: z.string(),
	access_technology: z.string().optional(),
	operator_id: z.string().optional(),
	operator_name: z.string().optional(),
});
export type ModemRegistrationRejection = z.infer<typeof modemRegistrationRejectionSchema>;

/**
 * 3GPP packet-service attach state — `attached` / `detached` / whatever a future
 * MM release prints. NOT the same fact as `status.connection`: a modem can be
 * `registered` for voice/SMS while PS stays `detached`, which is exactly the
 * state in which data never flows and every other indicator looks fine.
 */
export const modemPacketServiceStateSchema = z.string();

/**
 * The radio's own power state — ModemManager's `Modem.PowerState`, folded onto
 * `@ceralive/modem-control`'s `RadioPower` vocabulary.
 *
 * IT IS A READING, AND THERE IS NO WRITE BEHIND IT. The pinned control package
 * exposes power as a `ContextReadOperation<RadioPower>` and publishes no setter,
 * so nothing in this stack can turn a radio off, put it in low-power, or bring
 * it back. Publishing the state anyway is the point: an operator looking at a
 * modem that reports nothing needs to be able to tell a radio that is powered
 * down from one that is simply searching, and today neither surface could say.
 *
 * `unknown` is a STATED value, not the absence of the field — MM publishes
 * `MM_MODEM_POWER_STATE_UNKNOWN` for a modem it has not finished probing, and
 * collapsing that into absence would make "the modem said it does not know" and
 * "this backend does not report power" the same wire value. Absence means the
 * latter alone: an older device, or a `router-ethernet` dongle whose embedded
 * router hides the radio entirely.
 */
export const modemRadioPowerSchema = z.enum(['unknown', 'off', 'low', 'on']);
export type ModemRadioPower = z.infer<typeof modemRadioPowerSchema>;

/**
 * What a router-mode cellular dongle's OWN admin API reported.
 *
 * A dongle running its own embedded router is invisible to ModemManager, so
 * `status` is absent and always will be — but the device answers an HTTP admin
 * API on its LAN side, and that API is where its truth lives. This block is the
 * normalized read of it, and it is read-only BY EVIDENCE: every such dongle on
 * the bench arrived SIM-less, so no write could be shown to take effect, and an
 * unproven control is not shipped.
 *
 * `admin_url` is the device's default gateway as the routing table reports it —
 * never a hardcoded vendor default — and it is the address of the vendor web UI
 * that DOES own this device's configuration. `reachable` is measured by the
 * probe, so a `false` means a request was made and did not come back.
 */
/**
 * The dongle settings this build has PROVEN it can write, with their CURRENT
 * device-reported values.
 *
 * The whole object is optional and its absence is meaningful: it means this
 * device has no setting whose write was ever observed to take effect, so the UI
 * must offer no toggle at all rather than a disabled or optimistic one.
 */
export const routerAdminControlsSchema = z.object({
	mobile_data: z.boolean(),
	roaming_autoconnect: z.boolean(),
});
export type RouterAdminControls = z.infer<typeof routerAdminControlsSchema>;

/**
 * A radio quantity, or the REASON it is not one.
 *
 * The five unknown reasons are not synonyms and must never be collapsed:
 * `unsupported` is a fact about the vendor DIALECT (its API has no such field),
 * `not-reported` about this cycle's reading, `malformed` about the body,
 * `auth-expired` about the session, and `unreachable` about the device. A
 * consumer that renders them identically loses the only information that tells
 * an operator whether to wait, re-authenticate, or go and look at the dongle.
 *
 * There is deliberately no numeric fallback. A `0` here is a value the device
 * published — never a placeholder for one it did not.
 */
export const routerSignalMetricSchema = z.discriminatedUnion('state', [
	z.object({ state: z.literal('known'), value: z.number() }),
	z.object({
		state: z.literal('unknown'),
		reason: z.enum(['unsupported', 'not-reported', 'malformed', 'auth-expired', 'unreachable']),
	}),
]);
export type RouterSignalMetric = z.infer<typeof routerSignalMetricSchema>;

/**
 * The normalized signal a router dongle's OWN admin API reported.
 *
 * `provenance` exists so this can never be confused with ModemManager's radio
 * telemetry — they are different instruments reading different devices, and a
 * consumer that renders them as one surface must still say which it has.
 *
 * `snr` and `sinr` are separate fields for the reason `modemCellInfoSchema`
 * already states: LTE reports a signal-to-noise ratio and NR reports
 * signal-to-interference-plus-noise. The ZTE key is `lte_snr` and Huawei's is
 * `sinr`, so each dialect fills exactly one and declares the other unsupported.
 */
export const routerSignalSchema = z.object({
	provenance: z.enum(['hilink-admin-api', 'zte-goform', 'ufi-himiapi']),
	freshness: z.enum(['live', 'stale', 'unknown']),
	bars: routerSignalMetricSchema,
	max_bars: routerSignalMetricSchema,
	dbm: routerSignalMetricSchema,
	rsrp: routerSignalMetricSchema,
	rsrq: routerSignalMetricSchema,
	snr: routerSignalMetricSchema,
	sinr: routerSignalMetricSchema,
});
export type RouterSignal = z.infer<typeof routerSignalSchema>;

/**
 * The non-signal fields a router dongle's own admin API stated about itself.
 *
 * Every field is optional and its ABSENCE is the reading: this dialect did not
 * publish it, or the device did not state it this cycle. There is deliberately
 * no placeholder member — the vendor's own `-` for an unset WAN address is
 * dropped at the parser, because a dash on screen reads like a value.
 *
 * The whole block is absent rather than empty for the same reason: an empty
 * detail surface reads as a failed read, not as a device with nothing to add.
 */
export const routerAdminDetailsSchema = z.object({
	network_type: z.string().optional(),
	provider: z.string().optional(),
	cell_id: z.string().optional(),
	band: z.string().optional(),
	network_mode: z.string().optional(),
	wan_ip: z.string().optional(),
	imsi: z.string().optional(),
	iccid: z.string().optional(),
	ssid: z.string().optional(),
	product: z.string().optional(),
	registration: z.string().optional(),
	pci: z.string().optional(),
	mcc: z.string().optional(),
	mnc: z.string().optional(),
	roaming: z.string().optional(),
	network_band: z.string().optional(),
	bandwidth: z.string().optional(),
	carrier_aggregation: z.string().optional(),
	pcell_arfcn: z.string().optional(),
	pcell_band: z.string().optional(),
	pcell_bandwidth: z.string().optional(),
	scell_arfcn: z.string().optional(),
	scell_band: z.string().optional(),
	scell_bandwidth: z.string().optional(),
	/** The UFI's `bsid`, carried verbatim and OPAQUE — no meaning is claimed. */
	station_id: z.string().optional(),
	cpu_temp: z.string().optional(),
	wifi_clients: z.string().optional(),
	eth_clients: z.string().optional(),
	web_version: z.string().optional(),
	/** The DONGLE'S OWN local counters — never the bond rate, which the sender measures. */
	monthly_tx_bytes: z.string().optional(),
	monthly_rx_bytes: z.string().optional(),
	monthly_time: z.string().optional(),
	monthly_period: z.string().optional(),
	session_tx_bytes: z.string().optional(),
	session_rx_bytes: z.string().optional(),
	session_tx_rate: z.string().optional(),
	session_rx_rate: z.string().optional(),
	session_time: z.string().optional(),
});
export type RouterAdminDetails = z.infer<typeof routerAdminDetailsSchema>;

/** One entry of a router dongle's own network-mode catalog, verbatim. */
export const routerNetModeSchema = z.object({
	/** The vendor's own index, e.g. `03`. Never re-based or re-formatted. */
	id: z.string(),
	/** The vendor's own label, e.g. `LTE`. Absent when the device stated none. */
	name: z.string().optional(),
});
export type RouterNetMode = z.infer<typeof routerNetModeSchema>;

/**
 * What a router dongle's firmware said it CAN discuss — DISCOVERED, and read-only.
 *
 * There is deliberately no `writable` member. Proving a setting writable means
 * WRITING it, and this build performs no network-mode write for any firmware, so
 * a writability claim here could only repeat the vendor's own — the hearsay
 * `setRouterControlOutputSchema` exists to refuse. A capability is a READING.
 *
 * `unavailable` reasons are not synonyms: `refused` is the firmware declining the
 * question (it carries the vendor's own error code — `112008` on the bench unit),
 * `auth-expired` is about the session, `malformed` about the body, `not-reported`
 * about this cycle's reading, and `unreachable` about the device.
 */
export const routerNetModeCapabilitySchema = z.discriminatedUnion('state', [
	z.object({
		state: z.literal('reported'),
		modes: z.array(routerNetModeSchema),
		/** The mode the device says is selected now, where it stated one. */
		current: z.string().optional(),
	}),
	z.object({
		state: z.literal('unavailable'),
		reason: z.enum(['refused', 'auth-expired', 'not-reported', 'malformed', 'unreachable']),
		/** The vendor's own error code — present exactly when `refused`. */
		code: z.string().optional(),
	}),
]);
export type RouterNetModeCapability = z.infer<typeof routerNetModeCapabilitySchema>;

export const routerAdminCapabilitiesSchema = z.object({
	net_mode: routerNetModeCapabilitySchema,
});
export type RouterAdminCapabilities = z.infer<typeof routerAdminCapabilitiesSchema>;

export const routerAdminSchema = z.object({
	admin_url: z.string(),
	reachable: z.boolean(),
	model: z.string().optional(),
	/** Vendor device serial — the only field that tells two same-model twins apart. */
	serial: z.string().optional(),
	/** Hardware-stamped radio identity, so a row names the unit in the operator's hand. */
	imei: z.string().optional(),
	firmware: z.string().optional(),
	hardware: z.string().optional(),
	sim: z.enum(['absent', 'present', 'unknown']).optional(),
	connection: z.enum(['connected', 'connecting', 'disconnected', 'unknown']).optional(),
	signal_bars: z.number().optional(),
	signal_max_bars: z.number().optional(),
	apn: z.string().optional(),
	/**
	 * Additive-optional. Supersedes the two bar scalars above for new consumers:
	 * only one of the three dialects publishes a bar scale at all, and a bare
	 * `undefined` cannot say whether a number is missing because the API has no
	 * such field, because the device said nothing, or because it never answered.
	 */
	signal: routerSignalSchema.optional(),
	details: routerAdminDetailsSchema.optional(),
	capabilities: routerAdminCapabilitiesSchema.optional(),
	controls: routerAdminControlsSchema.optional(),
});
export type RouterAdmin = z.infer<typeof routerAdminSchema>;

export const setRouterControlInputSchema = z.object({
	device: z.string(),
	control: z.enum(['mobile_data', 'roaming_autoconnect']),
	value: z.boolean(),
});
export type SetRouterControlInput = z.infer<typeof setRouterControlInputSchema>;

/**
 * `success` means the device was re-READ and reported the requested value —
 * never that the vendor API answered OK. `controls` carries the verified state
 * so the caller adopts what the device actually holds, not what it asked for.
 */
export const setRouterControlOutputSchema = z.object({
	success: z.boolean(),
	error: z.enum(['unsupported', 'unreachable', 'not_applied', 'unknown_device']).optional(),
	controls: routerAdminControlsSchema.optional(),
	mutationRefusal: modemMutationRefusalSchema.optional(),
});
export type SetRouterControlOutput = z.infer<typeof setRouterControlOutputSchema>;

/**
 * Select one of the radio modes a router dongle's own firmware advertised.
 *
 * `mode` is the VENDOR's own index, carried verbatim from
 * `router_admin.capabilities.net_mode.modes[].id`. It is a string and not an
 * enum for the reason Stage A's read side already states: the catalog belongs to
 * the firmware, this build does not own its vocabulary, and an entry the device
 * did not index is dropped rather than given a synthetic id. A client may only
 * send an id the device itself just published.
 */
export const setRouterNetModeInputSchema = z
	.object({
		device: z.string(),
		mode: z.string().min(1),
	})
	.strict();
export type SetRouterNetModeInput = z.infer<typeof setRouterNetModeInputSchema>;

/**
 * `success` means the device was re-READ in a fresh session and reported the
 * requested mode as current — never that the vendor API answered OK.
 *
 * The four refusals are not synonyms and are never collapsed:
 * `capability_unavailable` is the FIRMWARE declining to name a catalog (it
 * carries the vendor's own code, `112008` on the bench unit) and is the honest
 * answer for a device that has no writable network mode at all;
 * `not_offered` means the catalog exists and does not contain the requested
 * index; `unsupported` means this build ships no net-mode write for that dialect;
 * `not_applied` means the write was accepted and the read-back disagreed.
 */
export const setRouterNetModeOutputSchema = z.object({
	success: z.boolean(),
	error: z
		.enum([
			'unsupported',
			'capability_unavailable',
			'not_offered',
			'unreachable',
			'not_applied',
			'unknown_device',
		])
		.optional(),
	/** The vendor's own error code, when the firmware supplied one. */
	code: z.string().optional(),
	/** The re-read capability block, so the caller adopts the DEVICE's answer. */
	capabilities: routerAdminCapabilitiesSchema.optional(),
	mutationRefusal: modemMutationRefusalSchema.optional(),
});
export type SetRouterNetModeOutput = z.infer<typeof setRouterNetModeOutputSchema>;

/**
 * Move a router dongle's LAN subnet — an OPTIONAL hygiene operation.
 *
 * It is never a precondition for bonding, streaming, or anything else: two
 * same-model dongles sharing one factory subnet already bond, because the bond is
 * described by INTERFACE and the sender binds `SO_BINDTODEVICE`. What the shared
 * subnet costs is every address-steered operation on the host, and this is the
 * cleanup for that.
 *
 * `.strict()` with a required `confirm: true` for the same reason `setUsbMode`
 * carries them: the write can cost the only path to the device, so an unknown
 * extra key must be rejected rather than ignored and an omitted confirmation must
 * never reach the handler.
 */
export const setRouterSubnetInputSchema = z
	.object({
		device: z.string(),
		/** The dongle's NEW LAN address, e.g. `192.168.9.1`. RFC1918, /24. */
		address: z.string().min(7),
		confirm: z.literal(true),
	})
	.strict();
export type SetRouterSubnetInput = z.infer<typeof setRouterSubnetInputSchema>;

/**
 * Three terminal outcomes, and the middle one is the point of the operation.
 *
 * `applied` — the device answered at its new address with the record we wrote.
 * `reverted` — it did not, its previous LAN settings were put back, AND that
 *   restore was reconfirmed by reaching the device again. Nothing is outstanding,
 *   so the journal entry is cancelled and the device is NOT left blocked.
 * `blocked` — the device answered at neither address. The journal entry stays
 *   `failed` and the device is fail-closed until an operator acknowledges, which
 *   is the correct posture for a dongle at an unknown address.
 */
export const setRouterSubnetOutputSchema = z.object({
	status: z.enum(['applied', 'reverted', 'refused', 'blocked']),
	error: z
		.enum([
			'unsupported',
			'unreachable',
			'unreadable',
			'unsupported_netmask',
			'invalid_target',
			'no_change',
			'subnet_conflict',
			'state_drifted',
			'unknown_device',
		])
		.optional(),
	/** The interface already holding the requested subnet, when that is the refusal. */
	conflict: z.string().optional(),
	/** Human-readable detail for `reverted` / `blocked`, never a raw vendor string. */
	detail: z.string().optional(),
	mutationRefusal: modemMutationRefusalSchema.optional(),
});
export type SetRouterSubnetOutput = z.infer<typeof setRouterSubnetOutputSchema>;

// ── THE DEVICE LOCK MODEL — FIVE STATES, AND `open` IS ONE OF THEM ───────────
//
// A router-mode dongle's own admin API is the only surface that can answer for
// its configuration, and some units gate it behind a login. `lock_state` is the
// wire vocabulary for where that login stands, and it has EXACTLY five members
// because collapsing any pair of them loses a fact an operator must act on
// differently:
//
//   `open`        the device requires no authentication and already exposes its
//                 full capability set. It is the COMMON case on this fleet — all
//                 three bench dialects answered unauthenticated — and it must be
//                 DETECTED, never assumed. A provider whose protocol cannot say
//                 so resolves `locked` instead of guessing.
//   `locked`      a credential is required and none has been accepted.
//   `unlocked`    a stored credential was verified THIS SESSION.
//   `auth-failed` a credential was tried and the device rejected it.
//   `locked-out`  the device itself reports a lockout window.
//
// `auth-failed` and `locked-out` are never folded together: the first invites a
// re-entry, the second forbids one until the window clears. And a dialect that
// answered a shape this build cannot drive is NEITHER — that is
// `unsupported-profile`, carried alongside a `locked` state on {@link
// modemLockDetailSchema}, because reporting it as `auth-failed` would tell an
// operator their password is wrong when it was never presented.
export const MODEM_LOCK_STATES = [
	'open',
	'locked',
	'unlocked',
	'auth-failed',
	'locked-out',
] as const;
export const modemLockStateSchema = z.enum(MODEM_LOCK_STATES);
export type ModemLockState = z.infer<typeof modemLockStateSchema>;

/**
 * Why a lock state is what it is, when the bare state cannot say.
 *
 * `unsupported-profile` is todo 6's `protocol-mismatch` on the wire: the dialect
 * answered a login shape this build ships no proven implementation for. It rides
 * BESIDE the state rather than as a sixth state, because the device is still
 * simply `locked` — what changed is that a credential will not help.
 */
export const modemLockSubReasonSchema = z.enum(['unsupported-profile']);
export type ModemLockSubReason = z.infer<typeof modemLockSubReasonSchema>;

/**
 * The lock detail block. `credential_configured` is REQUIRED and therefore
 * always explicit: it is a RETRACTABLE fact (an operator clears a stored login),
 * and the modem merge preserves an omitted optional field, so a
 * present-only-when-true flag could be raised and never lowered — the
 * `policy_route_missing` latch, exactly.
 *
 * The secret itself has no representation here, so a projection cannot leak one
 * by omission.
 */
export const modemLockDetailSchema = z.object({
	credential_configured: z.boolean(),
	sub_reason: modemLockSubReasonSchema.optional(),
	/** Epoch ms of the last attempt the device ACCEPTED. */
	last_verified_at: z.number().optional(),
	/** Epoch ms the device's own lockout window is expected to clear. */
	lockout_until: z.number().optional(),
});
export type ModemLockDetail = z.infer<typeof modemLockDetailSchema>;

/** Bounds on what an operator may type into a router-WebUI login. */
export const MODEM_CREDENTIAL_USERNAME_MAX = 64;
export const MODEM_CREDENTIAL_PASSWORD_MAX = 128;

/**
 * Store (or replace) one device's router-WebUI login.
 *
 * `.strict()` because an unknown extra key on a surface carrying a secret must
 * be REJECTED rather than ignored. The username MAY be empty (several dialects
 * have a single implicit account); the password may not, because an empty pair
 * is not a credential and an `open` device is a DETECTED state rather than an
 * empty row in a secrets file.
 */
export const setModemCredentialsInputSchema = z
	.object({
		device: z.string().min(1),
		username: z.string().max(MODEM_CREDENTIAL_USERNAME_MAX),
		password: z.string().min(1).max(MODEM_CREDENTIAL_PASSWORD_MAX),
	})
	.strict();
export type SetModemCredentialsInput = z.infer<typeof setModemCredentialsInputSchema>;

export const modemCredentialsInputSchema = z.object({ device: z.string().min(1) }).strict();
export type ModemCredentialsInput = z.infer<typeof modemCredentialsInputSchema>;

/**
 * The refusals, none of which is a synonym for another.
 *
 * `device_open` is a REFUSAL rather than a silent success: storing a login for a
 * device that needs none leaves a secret on disk that nothing will ever present.
 * `unsupported_profile` is the `protocol-mismatch` case — the credential was
 * never presented, so it is emphatically not `auth_failed`. `locked_out` means
 * the device refused BEFORE any request left this host.
 */
export const modemCredentialsRefusalSchema = z.enum([
	'unknown_device',
	'identity_unresolved',
	'device_open',
	'unsupported_profile',
	'locked_out',
	'auth_failed',
	'unreachable',
	'no_credential',
	'unavailable_in_emulated_mode',
]);
export type ModemCredentialsRefusal = z.infer<typeof modemCredentialsRefusalSchema>;

/**
 * The one answer shape all three credential procedures share.
 *
 * It carries the RESOLVED lock state rather than an echo of the request, so a
 * caller locks its surface to what the device is now in — and it carries NO
 * password, no username and no derivative of either. `z.object` strips unknown
 * keys, so a field added upstream by mistake cannot reach a client through here.
 */
export const modemCredentialsOutputSchema = z.object({
	success: z.boolean(),
	error: modemCredentialsRefusalSchema.optional(),
	lock_state: modemLockStateSchema.optional(),
	lock_detail: modemLockDetailSchema.optional(),
});
export type ModemCredentialsOutput = z.infer<typeof modemCredentialsOutputSchema>;

// Read-only serving-cell telemetry (Phase-A A3.3). The two noise figures are NOT
// interchangeable and must not be folded into one key: LTE reports a
// signal-to-noise ratio (`snr`), NR reports signal-to-interference-plus-noise
// (`sinr`). A consumer reading `snr` on an NR cell reads nothing.
export const modemCellInfoSchema = z.object({
	tech: z.enum(['lte', 'nr', 'unknown']).optional(),
	cell_id: z.string().optional(),
	band: z.string().optional(),
	rsrp: z.number().optional(),
	rsrq: z.number().optional(),
	snr: z.number().optional(),
	sinr: z.number().optional(),
	provenance: z
		.object({
			source: z.string().optional(),
			observed_at: z.number().int().optional(),
		})
		.optional(),
});
export type ModemCellInfo = z.infer<typeof modemCellInfoSchema>;

// ── stable_key derivation — ONE rule, every adapter ──────────────────────────
// `stable_key` is the ONLY identifier a consumer may use to correlate a device
// across a USB-mode transition. The legacy numeric modem id CANNOT be used: it is
// a ModemManager index that a re-enumeration re-issues, and a mode switch also
// moves the device BETWEEN adapter classes (router-ethernet ↔ mm-managed), so a
// per-adapter derivation would change the key at exactly the moment a consumer is
// keying on it. The interface name is no better — the bench has two physically
// distinct HiLink units sharing one factory MAC, so their predictable names race.
//
// The one rule: the udev ID_PATH of the device's common `usb_device` PARENT. A
// USB modem exposes several interfaces (net, tty, wdm) whose own ID_PATHs differ
// only in the trailing `<config>.<interface>` component; stripping it yields the
// one path every interface of that physical unit shares, and that path survives
// both re-enumeration and the adapter-class crossing.
//
// STATED (not invented) fallbacks, in order:
//   1. a path with a resolvable `usb_device` parent  → the PARENT path
//   2. a path with no usb parent (e.g. a PCIe FM350) → its own ID_PATH VERBATIM
//   3. no ID_PATH at all                             → `undefined`; the optional
//      `stable_key` field is then OMITTED rather than faked
//
// The key is OPAQUE BY CONTRACT, not by encoding: equality is the only sanctioned
// operation. It is emitted verbatim (no prefix, no hash) precisely so that three
// independent adapters cannot disagree about a formatting step; a bus-topology
// path carries no secret (it is not a serial, IMEI, ICCID or EID).
//
// ── ONE PORT, TWO ENCODINGS — the normalization below, and why it is here ────
// "Every adapter runs one rule" was true of the REDUCTION and false of the INPUT.
// The adapters do not all observe an `ID_PATH`: ModemManager's `Modem.Physdev`
// (and its `Modem.Device` default) is a raw sysfs DEVPATH, so the D-Bus fold fed
// this function a string of a different shape while udev-sourced adapters fed it
// an `ID_PATH`. Board-measured on `ceralive2` (2026-08-18, todo 24), ONE physical
// socket produced TWO non-comparable keys at the same instant:
//
//   udev-sourced rows  platform-xhci-hcd.0.auto-usb-0:1.4.1
//   ModemManager row   /sys/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.4/1-1.4.1
//
// `stable_key` equality is the ONLY sanctioned operation, so two encodings of one
// port means no consumer can correlate them: the authoritative row could never
// retire the optimistic udev row, and the wire carried two rows for one stick on
// 10 of 10 power cycles. `sysfsDevpathToIdPath` closes that at the DERIVATION —
// it is not a fuzzy compare-time match, it is udev's own `path_id` USB rule
// (systemd `src/udev/udev-builtin-path_id.c`) applied to the sysfs path so both
// encodings MINT the same canonical key. A path it cannot confidently convert is
// returned unchanged, which is the pre-existing behaviour, never a guess.
const USB_MARKER = '-usb-';

/** `<busnum>-<port>[.<port>…]` — a sysfs `usb_device` directory name. */
const SYSFS_USB_DEVICE_RE = /^(\d+)-([\d.]+)$/;
/** `usb1`, `usb2`, … — the sysfs root-hub directory of one USB controller. */
const SYSFS_USB_ROOT_HUB_RE = /^usb\d+$/;
/** `0000:00:14.0` — a PCI function's sysfs directory name (`<domain>:<bus>:<dev>.<fn>`). */
const SYSFS_PCI_FUNCTION_RE = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]+$/;

/**
 * Convert a sysfs DEVPATH for a USB device into the udev `ID_PATH` that names the
 * SAME socket, or `undefined` when the path is not a convertible sysfs USB path.
 *
 * This mirrors udev's `path_id` builtin for the ONE ancestry a USB modem has, and
 * it is a transformation rather than a heuristic:
 *
 *   - `handle_usb` takes the nearest `usb_device` directory (`1-1.4.1`), drops the
 *     bus number ahead of the first `-`, and prepends `usb-0:<port-chain>`. The
 *     literal `0` is udev's own — it is not the bus number, which is deliberately
 *     discarded because it renumbers.
 *   - it then SKIPS the whole `usb` subsystem (`1-1.4`, `1-1`, `usb1`) up to the
 *     host controller and names that: `platform-<sysname>` for an SoC xHCI block,
 *     `pci-<domain:bus:dev.fn>` for a PCIe one.
 *
 * A path naming no `usb_device` component, or one whose USB chain has no root hub
 * to climb out of, yields `undefined` — the caller then keeps what it was given
 * rather than fabricating a key.
 */
export function sysfsDevpathToIdPath(devpath: string): string | undefined {
	const trimmed = devpath.trim();
	// Accept both the kernel's own `DEVPATH` (`/devices/…`) and the mounted form
	// (`/sys/devices/…`); ModemManager publishes the latter.
	const marker = '/devices/';
	const at = trimmed.indexOf(marker);
	if (at !== 0 && !(at > 0 && trimmed.slice(0, at) === '/sys')) return undefined;

	const parts = trimmed
		.slice(at + marker.length)
		.split('/')
		.filter(Boolean);

	// The LAST usb_device component: a path ending at an interface
	// (`1-1.4.1:1.0`) names its parent device one level up, and this finds it.
	let deviceAt = -1;
	for (let i = parts.length - 1; i >= 0; i--) {
		if (SYSFS_USB_DEVICE_RE.test(parts[i] as string)) {
			deviceAt = i;
			break;
		}
	}
	if (deviceAt < 0) return undefined;
	const portChain = (parts[deviceAt] as string).match(SYSFS_USB_DEVICE_RE)?.[2];
	if (portChain === undefined) return undefined;

	// Climb out of the usb subsystem: the controller is the component directly
	// above the root hub. Searching for the root hub (rather than counting
	// levels) is what makes this independent of how deep the port chain runs.
	let rootHubAt = -1;
	for (let i = deviceAt - 1; i >= 0; i--) {
		if (SYSFS_USB_ROOT_HUB_RE.test(parts[i] as string)) {
			rootHubAt = i;
			break;
		}
	}
	const controller = rootHubAt > 0 ? parts[rootHubAt - 1] : undefined;
	if (controller === undefined) return undefined;

	const prefix = SYSFS_PCI_FUNCTION_RE.test(controller)
		? `pci-${controller}`
		: `platform-${controller}`;
	return `${prefix}${USB_MARKER}0:${portChain}`;
}

/**
 * The canonical `ID_PATH` form of whatever a caller observed.
 *
 * Exported so an adapter that STORES an observed path (rather than only deriving
 * a key from it) records the same encoding every other adapter does — a raw sysfs
 * path in a physical-device record is unreadable to `port_label` derivation and
 * to any consumer comparing it with a udev-sourced one.
 */
export function canonicalModemIdPath(idPath: string | undefined | null): string | undefined {
	const path = idPath?.trim();
	if (!path) return undefined;
	return sysfsDevpathToIdPath(path) ?? path;
}

export function deriveModemStableKey(idPath: string | undefined | null): string | undefined {
	const path = canonicalModemIdPath(idPath);
	if (!path) return undefined;

	const markerAt = path.lastIndexOf(USB_MARKER);
	if (markerAt < 0) {
		// No usb_device ancestry at all — a PCIe/SoC-attached modem. Its own
		// ID_PATH is already the whole-device path.
		return path;
	}

	const prefix = path.slice(0, markerAt + USB_MARKER.length);
	const fields = path.slice(markerAt + USB_MARKER.length).split(':');
	// `<busnum>:<port-chain>[:<config>.<interface>]` — the usb_device ends at the
	// port chain. Anything shorter names no port and cannot be reduced further.
	const [busnum, portChain] = fields;
	if (fields.length < 2 || !busnum || !portChain) return path;

	return `${prefix}${busnum}:${portChain}`;
}

// ── The `five-g-pref` capability module ──────────────────────────────────────
//
// It exists because the 3G/4G/5G selector's vocabulary is the ALLOWED SET, and
// two genuinely different postures share one: "allow 4G and 5G, prefer 5G" and
// "allow 4G and 5G, prefer 4G" differ only in ModemManager's PREFERRED mode,
// which that selector folds away (`mmConvertNetworkTypes` keeps one entry per
// label). An operator on a marginal 5G cell wants exactly that distinction and
// could not previously ask for it.
//
// Rule-D MIRROR of `modem-stack`'s `control/src/capability/five-g-preference.ts`,
// re-derived rather than imported — the vocabulary differs too (mmcli speaks
// `2g/3g/4g/5g`, the D-Bus library speaks `gsm/umts/lte/5gnr`), so this is a
// translation boundary and not a duplication.
export const FIVE_G_PREFERENCES = ['5g-only', 'prefer-5g', 'prefer-4g', '5g-off'] as const;
export const fiveGPreferenceSchema = z.enum(FIVE_G_PREFERENCES);
export type FiveGPreference = z.infer<typeof fiveGPreferenceSchema>;

/**
 * Why SA/NSA is reported rather than offered.
 *
 * ModemManager 1.24.2 exposes no standalone-vs-non-standalone selector: the only
 * NR-specific member on a modem object is `Modem3gpp.SetNr5gRegistrationSettings`
 * (`mico-mode` + `drx-cycle` — power-saving registration parameters). Vendors
 * expose the choice through per-SKU AT commands, which is an uncertified write
 * that can cost registration, so this build opens none.
 *
 * It is STATED rather than omitted: a missing field reads as "nobody asked",
 * while a named reason tells an operator hunting for an SA toggle why there is
 * none.
 */
export const nrModeUnsupportedReasonSchema = z.enum(['not-exposed-by-modemmanager']);
export type NrModeUnsupportedReason = z.infer<typeof nrModeUnsupportedReasonSchema>;

export const nrModeSelectionSchema = z.object({
	supported: z.literal(false),
	reason: nrModeUnsupportedReasonSchema,
});
export type NrModeSelection = z.infer<typeof nrModeSelectionSchema>;

/**
 * The module's READ half, stamped on a modem row only when its claim is
 * surfaceable (`capable` / `certified`).
 *
 * `offered` is the postures THIS radio advertised, so an empty array means "the
 * modem named none", never "unknown". `active` is a LIVE read of the radio's
 * current `(allowed, preferred)` pair and is `null` for a pair no posture names —
 * rounding it to the nearest posture would show an operator a selection they
 * never made and cannot get back to.
 */
export const modemFiveGPreferenceSchema = z.object({
	offered: z.array(fiveGPreferenceSchema),
	active: fiveGPreferenceSchema.nullable(),
	nr_mode: nrModeSelectionSchema,
});
export type ModemFiveGPreference = z.infer<typeof modemFiveGPreferenceSchema>;

// `confirm` is `z.literal(true)` and the object is `.strict()` for the same
// reason `setUsbModeInputSchema` is: this write re-registers the radio, so an
// unknown extra key must be REJECTED rather than ignored and an omitted or falsy
// confirmation must never reach the handler.
export const setFiveGPreferenceInputSchema = z
	.object({
		device: z.string().min(1),
		preference: fiveGPreferenceSchema,
		confirm: z.literal(true),
	})
	.strict();
export type SetFiveGPreferenceInput = z.infer<typeof setFiveGPreferenceInputSchema>;

/**
 * Why the write did not land, once the gate and the lease both let it through.
 *
 *   unknown_modem      — no modem answers to that selector.
 *   not_offered        — this radio never advertised the requested posture. A
 *                        neighbouring posture is NEVER substituted: that is how
 *                        "prefer 4G" on a marginal cell silently becomes 5G-first.
 *   write_failed       — mmcli did not confirm the mode change, or the spawn
 *                        threw. The wire-stable token the network-type selector
 *                        already uses, deliberately reused rather than renamed.
 *   readback_mismatch  — the write was accepted and the radio landed somewhere
 *                        else. DISTINCT from `write_failed` on purpose: the
 *                        request really was taken, and the modem clamped it, so
 *                        the operator's next action is different.
 *   readback_failed    — the write was accepted and the radio could not be
 *                        re-read, so nothing can be claimed about where it is.
 */
export const setFiveGPreferenceFailureSchema = z.enum([
	'unknown_modem',
	'not_offered',
	'write_failed',
	'readback_mismatch',
	'readback_failed',
]);
export type SetFiveGPreferenceFailure = z.infer<typeof setFiveGPreferenceFailureSchema>;

/**
 * `applied` is the posture the radio was READ BACK on, never the request.
 *
 * That asymmetry is the whole contract: a configure-echo that parrots the input
 * is what let a refused `mmSetNetworkTypes` reach an operator as "Saved" with the
 * rejected value locked into the dialog. `applied` is therefore present only on
 * success, and it is what a UI locks its form to.
 */
export const setFiveGPreferenceOutputSchema = z.object({
	success: z.boolean(),
	applied: fiveGPreferenceSchema.optional(),
	refusal: capabilityMutationRefusalSchema.optional(),
	error: setFiveGPreferenceFailureSchema.optional(),
});
export type SetFiveGPreferenceOutput = z.infer<typeof setFiveGPreferenceOutputSchema>;

// ── USSD (Phase C) ───────────────────────────────────────────────────────────
//
// USSD is a SESSION protocol, not request/response: `Initiate` opens a dialogue
// the network may hold open pending a `Respond`, and a session that is neither
// answered nor cancelled stays open NETWORK-side, occupying the subscriber's
// single slot and failing the next `Initiate` busy. So the wire carries a session
// SNAPSHOT rather than a bare reply, and "which verb is legal right now" has a
// real wrong answer.
//
// NOTHING HERE CARRIES CARRIER TEXT except `ussdReply`, which is the operator's
// whole reason for asking. It is deliberately the ONLY such field, so every log
// and trace boundary can mask exactly one key.

/**
 * Where a dialogue is. `closed` is terminal — a closed machine accepts nothing.
 *
 * `active` and `awaiting-reply` are BOTH open states and are deliberately not
 * collapsed: ModemManager reports them separately, and only `awaiting-reply`
 * accepts a `Respond`. Folding them would leave a session MM still considers open
 * dangling on the network side.
 */
export const USSD_SESSION_STATES = [
	'idle',
	'initiating',
	'active',
	'awaiting-reply',
	'responding',
	'cancelling',
	'closed',
] as const;
export const ussdSessionStateSchema = z.enum(USSD_SESSION_STATES);
export type UssdSessionState = z.infer<typeof ussdSessionStateSchema>;

/** How a dialogue ENDED. Present only on a `closed` snapshot. */
export const ussdSessionOutcomeSchema = z.enum(['completed', 'cancelled', 'timed-out', 'failed']);
export type UssdSessionOutcome = z.infer<typeof ussdSessionOutcomeSchema>;

/**
 * Why a USSD verb or read did not produce a dialogue. Each names a DIFFERENT
 * operator fact and none may be collapsed:
 *
 *   unknown_modem        — no modem answers to that selector.
 *   unsupported          — the modem positively reports no USSD surface. The ONLY
 *                          member that is evidence about the DEVICE; every other
 *                          one is a statement about the READ.
 *   lte-only-unsupported — claimed only from positive registration evidence: the
 *                          modem is registered LTE-only and the carrier declines
 *                          USSD there.
 *   not-registered       — the radio is not on a network yet; this resolves itself.
 *   no-session           — there is no open dialogue for the verb to act on.
 *   session-busy         — one is already open; USSD allows a single slot.
 *   invalid-state        — the verb is illegal in the session's current state.
 *   carrier-rejected     — the network answered and refused.
 *   timeout              — the network never answered.
 *   transport-failed     — mmcli failed, or answered in a shape that did not parse.
 */
export const ussdRefusalSchema = z.enum([
	'unknown_modem',
	'unsupported',
	'lte-only-unsupported',
	'not-registered',
	'no-session',
	'session-busy',
	'invalid-state',
	'carrier-rejected',
	'timeout',
	'transport-failed',
]);
export type UssdRefusal = z.infer<typeof ussdRefusalSchema>;

/**
 * The session as the device sees it. `outcome` and `refusal` ride ONLY a `closed`
 * snapshot — a live dialogue has not ended, so it has no way to have ended.
 */
export const ussdSessionSnapshotSchema = z.object({
	state: ussdSessionStateSchema,
	outcome: ussdSessionOutcomeSchema.optional(),
	refusal: ussdRefusalSchema.optional(),
});
export type UssdSessionSnapshot = z.infer<typeof ussdSessionSnapshotSchema>;

// A USSD command is a short service code, not free text: leading `*` or `#`,
// digits and `*`/`#` after it, terminated by `#`. Pinned as a regex because it
// becomes an mmcli ARGUMENT, so anything outside this shape must be rejected at
// the boundary rather than escaped later.
export const USSD_COMMAND_RE = /^[*#0-9][0-9*#]{0,180}#$/;
export const USSD_TEXT_MAX = 182;

/** A menu answer. Free-form (a carrier may ask for a name), but never control bytes. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: EXCLUDING control bytes is the entire purpose of this class — the value becomes an mmcli argument.
export const USSD_RESPONSE_RE = /^[^\u0000-\u001f\u007f]+$/;

export const modemUssdInputSchema = z.object({
	device: z.string().min(1),
});
export type ModemUssdInput = z.infer<typeof modemUssdInputSchema>;

export const ussdInitiateInputSchema = z
	.object({
		device: z.string().min(1),
		ussdCommand: z.string().min(1).max(USSD_TEXT_MAX).regex(USSD_COMMAND_RE),
	})
	.strict();
export type UssdInitiateInput = z.infer<typeof ussdInitiateInputSchema>;

export const ussdRespondInputSchema = z
	.object({
		device: z.string().min(1),
		ussdResponse: z.string().min(1).max(USSD_TEXT_MAX).regex(USSD_RESPONSE_RE),
	})
	.strict();
export type UssdRespondInput = z.infer<typeof ussdRespondInputSchema>;

export const ussdCancelInputSchema = z.object({ device: z.string().min(1) }).strict();
export type UssdCancelInput = z.infer<typeof ussdCancelInputSchema>;

/**
 * `session` is the snapshot AFTER the verb, so a refused verb that still moved
 * the machine (a network failure closes the dialogue) reports both its `error`
 * and where that left the session. `mutationRefusal` is the capability/lease
 * layer's answer and is disjoint from `error` — one means the verb never ran,
 * the other that it ran and the network refused.
 */
export const modemUssdOutputSchema = z.object({
	success: z.boolean(),
	session: ussdSessionSnapshotSchema.optional(),
	/** The carrier's own text. The ONE field here that carries it. */
	ussdReply: z.string().optional(),
	error: ussdRefusalSchema.optional(),
	mutationRefusal: capabilityMutationRefusalSchema.optional(),
});
export type ModemUssdOutput = z.infer<typeof modemUssdOutputSchema>;

/**
 * WHETHER THERE IS A CARD IN THE SLOT, as EVIDENCE rather than as a claim.
 *
 * `no_sim` is a BOND question — a link either may join the pool or may not — so
 * it is binary by necessity and the device folds `absent` and `unknown` onto the
 * same `true`. Correct for bonding, wrong for reporting: "we know there is no
 * card" and "the read could not answer" are different facts, and rendering the
 * second as the first is the unknown-as-absent defect class.
 *
 * This is that fold's INPUT (`sim-presence.ts` `deriveSimPresence`), published so
 * a consumer can tell the two apart. ADDITIVE — it does NOT supersede `no_sim`,
 * and the bond gate keeps reading the binary claim unchanged. `absent` is
 * reachable ONLY from a device that positively said so (ModemManager's own
 * `sim-missing` failure reason); everything else that is not `present` is
 * `unknown`, including a read that never happened.
 */
export const simPresenceSchema = z.enum(['present', 'absent', 'unknown']);
export type SimPresence = z.infer<typeof simPresenceSchema>;

// Modem schema
export const modemSchema = z.object({
	ifname: z.string(),
	name: z.string(),
	sim_network: z.string().optional(),
	model: z.string().optional(),
	manufacturer: z.string().optional(),
	network_type: z.object({
		supported: z.array(z.string()),
		active: z.string().nullable(),
	}),
	config: modemConfigSchema.optional(),
	available_networks: z.record(z.string(), availableNetworkSchema).optional(),
	network_scan: z
		.object({
			generation: z.number().int().nonnegative(),
			phase: z.enum(['scanning', 'completed', 'failed']),
			failure: z.enum(['timed_out', 'failed']).optional(),
		})
		.optional(),
	status: modemStatusSchema.optional(),
	no_sim: z.boolean().optional(),
	sim_presence: simPresenceSchema.optional(),
	sim_lock: simLockSchema.optional(),

	// Phase-B additive-optional detail — see the block above. All eleven are
	// optional, and a payload omitting every one of them is the legacy wire shape.
	device_class: modemDeviceClassSchema.optional(),
	// Why this modem/slot is currently unusable, in operator-facing terms. Drives
	// the disabled-with-reason row rather than a silently missing entry.
	availability_reason: z.string().optional(),
	// Display label for the active SIM slot on a multi-slot board.
	slot_label: z.string().optional(),
	recovery_state: modemRecoveryStateSchema.optional(),
	usb_mode: usbCompositionModeSchema.optional(),
	recommended_usb_mode: usbCompositionModeSchema.optional(),
	data_usage: modemDataUsageSchema.optional(),
	data_usage_policy: modemDataUsagePolicySchema.optional(),
	firmware_revision: z.string().optional(),
	// The SIM's OWN number(s) — ModemManager's `Modem.OwnNumbers`. SENSITIVE: it
	// is the subscriber's telephone number, so it is redacted from every log even
	// though the UI DISPLAYS it behind an explicit reveal.
	//
	// An ARRAY, because MM's property is `as` and a dual-number SIM is expressible
	// — collapsing to a first element would silently drop the tail. It is
	// non-empty when present and OMITTED otherwise: most SIMs carry no MSISDN at
	// all, so `[]` would invite a consumer to render "no numbers" as a finding
	// rather than as silence.
	own_numbers: z.array(z.string().min(1)).min(1).optional(),
	// The SIM's ICCID — ModemManager's `Sim.SimIdentifier` (mmcli
	// `sim.properties.iccid`). Deliberately NOT the same sensitivity class as
	// `own_numbers`: an ICCID is printed on the physical card and is the number a
	// carrier asks for over the phone to activate a line, so it is DISPLAYED
	// plainly rather than behind a reveal. It is still absent-when-unreported —
	// a locked SIM withholds it, and a router-mode dongle's host never sees one.
	//
	// Distinct from `routerAdminDetailsSchema.iccid`, which is a dongle's own
	// admin API echoing what IT can see; this is the directly-managed radio's.
	iccid: z.string().min(1).optional(),
	esim: modemEsimSchema.optional(),
	cell_info: modemCellInfoSchema.optional(),
	// Why the radio is not registered, when the network said so. Absent means
	// "the network stated no rejection", never "there is no problem".
	registration_rejection: modemRegistrationRejectionSchema.optional(),
	packet_service_state: modemPacketServiceStateSchema.optional(),
	// The radio's power state, READ-ONLY. There is no matching input field and
	// there never will be from this package: `power` is a read operation with no
	// setter beside it, so an input here would be a control that accepts a value
	// and drops it. See `modemRadioPowerSchema` for why `unknown` is stated.
	radio_power: modemRadioPowerSchema.optional(),
	// The dongle's own admin API, for a `router-ethernet` row that has no
	// `status` and never will. Absent for every ModemManager-managed device.
	router_admin: routerAdminSchema.optional(),
	// Where the device's own admin login stands. Emitted for every row that HAS
	// an admin surface, and always as one of the five EXPLICIT values — `open` in
	// particular is a stated value rather than the absence of the field, because
	// encoding it as absence is the `policy_route_missing` latch: a row that went
	// `locked` → `open` could never lower the claim on a merging consumer.
	// Absent means the device has no admin-auth surface at all (every
	// ModemManager-managed modem), the same way `router_admin` is absent for one.
	lock_state: modemLockStateSchema.optional(),
	lock_detail: modemLockDetailSchema.optional(),
	// Produced by `deriveModemStableKey`; omitted when the device reports no
	// ID_PATH. Correlate a device across a USB-mode transition with THIS and
	// nothing else — see the derivation block above for why the numeric id,
	// the ifname and the MAC all fail.
	stable_key: z.string().optional(),
	// The seven-module support-claim matrix for THIS modem. Optional so a legacy
	// payload still parses; when present it is TOTAL — every module carries an
	// explicit state, because an omitted key would be indistinguishable from a
	// lowered claim on a merge that preserves absent fields.
	capability_modules: capabilityModuleClaimsSchema.optional(),
	// The `five-g-pref` module's read half. Present ONLY where that module's claim
	// is surfaceable, so a consumer never re-derives the support ladder to decide
	// whether to draw the control — and an absent block is never confused with a
	// modem that advertised no postures, which is what an empty `offered` array
	// would mean.
	five_g_preference: modemFiveGPreferenceSchema.optional(),
});
export type Modem = z.infer<typeof modemSchema>;

// Modem list schema
export const modemListSchema = z.record(z.string(), modemSchema);
export type ModemList = z.infer<typeof modemListSchema>;

// Modem config input schema.
//
// The two usage-policy WRITE fields are TRI-STATE, and the third state is the
// point: `undefined` leaves the persisted value alone, so an APN-only save cannot
// silently drop a cycle day it never mentioned, while an explicit `null` CLEARS it.
// A two-state field would make "unset my threshold" unexpressible. Both map onto
// `@ceralive/modem-control`'s `setUsagePolicy`, which takes the same tri-state.
export const modemConfigInputSchema = z
	.object({
		device: z.string(),
		network_type: z.string(),
		roaming: z.boolean().optional(),
		network: z.string().optional(),
		autoconfig: z.boolean().optional(),
		apn: z.string(),
		username: z.string(),
		password: z.string(),
		data_usage_cycle_day: z.number().int().min(1).max(31).nullable().optional(),
		data_usage_threshold_bytes: z.number().int().nonnegative().nullable().optional(),
	})
	.refine((data) => data.autoconfig !== false || data.apn.length > 0, {
		message: 'APN is required when auto-configuration is disabled',
		path: ['apn'],
	});
export type ModemConfigInput = z.infer<typeof modemConfigInputSchema>;

// Modem config applied-echo schema (persisted post-normalisation config subset)
export const modemConfigAppliedSchema = z.object({
	device: z.string(),
	network_type: z.string(),
	roaming: z.boolean(),
	network: z.string(),
	autoconfig: z.boolean(),
	apn: z.string(),
	username: z.string(),
	password: z.string(),
	// The persisted policy, echoed so the UI can lock its fields to what actually
	// landed. ABSENT means "not set" — never "unchanged": this object is a full
	// snapshot of persisted state, not a diff of the request.
	data_usage_cycle_day: z.number().int().min(1).max(31).optional(),
	data_usage_threshold_bytes: z.number().int().nonnegative().optional(),
});
export type ModemConfigApplied = z.infer<typeof modemConfigAppliedSchema>;

/**
 * Why the device refused a modem-config write.
 *
 * `modems.configure` used to answer `{success: true}` unconditionally — the
 * apply was dispatched fire-and-forget, so a write the device declined outright
 * (or one NetworkManager rejected) still reported success and the operator
 * watched their setting revert with no explanation. These tokens are
 * machine-stable and are keyed to operator copy; they are never rendered raw.
 */
export const modemConfigRefusalSchema = z.enum([
	'device_busy',
	'unknown_modem',
	'unconfigured_modem',
	'invalid_config',
	'unsupported_network_type',
	'unavailable_network',
	'write_failed',
	// The pinned `@ceralive/modem-control` publishes no `setUsagePolicy`. Refusing
	// is the whole point: accepting a policy with nowhere to apply it is how an
	// operator watches their setting revert with no explanation.
	'usage_policy_unsupported',
	'usage_policy_write_failed',
	// The shared mutation-safety refusals, reported here rather than collapsed
	// into `device_busy`: "another mutation is running", "the device is blocked
	// pending your acknowledgement" and "this modem was decommissioned" are three
	// different things for an operator to do.
	'identity_unresolved',
	'mutation_in_progress',
	'streaming_active',
	'recovery_pending',
	'mutation_blocked',
	'device_decommissioned',
	'rebaseline_required',
]);
export type ModemConfigRefusal = z.infer<typeof modemConfigRefusalSchema>;

// Modem config output schema
export const modemConfigOutputSchema = z.object({
	success: z.boolean(),
	applied: modemConfigAppliedSchema.optional(),
	error: modemConfigRefusalSchema.optional(),
	// Whether the device had to re-establish the bearer to apply the save. An
	// operator who is told a reconnect is coming and gets none is misinformed
	// exactly as badly as the reverse, so this reports what actually happened
	// rather than what the dialog predicted.
	reconnected: z.boolean().optional(),
});
export type ModemConfigOutput = z.infer<typeof modemConfigOutputSchema>;

// Modem scan input schema
export const modemScanInputSchema = z.object({
	device: z.coerce.number(),
});
export type ModemScanInput = z.infer<typeof modemScanInputSchema>;

/**
 * Why a 3GPP scan produced no result.
 *
 * Machine-stable tokens keyed to operator copy, never rendered raw — the same
 * contract every other refusal on this wire follows. They are DISTINCT because
 * each points somewhere different: `timed_out` means the radio was still
 * sweeping when the deadline expired (retry, or the radio is struggling to
 * register at all), `already_scanning` means one is in flight (wait), and
 * `failed` means the scan could not be run.
 *
 * A scan that completed and found NOTHING is `success: true` with an empty
 * `networks` — deliberately not a failure, because "no networks in range" is a
 * real answer and collapsing it into an error would misreport coverage.
 */
export const modemScanFailureSchema = z.enum(['timed_out', 'already_scanning', 'failed']);
export type ModemScanFailure = z.infer<typeof modemScanFailureSchema>;

// Modem scan output schema
export const modemScanOutputSchema = z.object({
	success: z.boolean(),
	scanGeneration: z.number().int().nonnegative().optional(),
	networks: z.record(z.string(), availableNetworkSchema).optional(),
	error: z.string().optional(),
	scanFailure: modemScanFailureSchema.optional(),
	mutationRefusal: modemMutationRefusalSchema.optional(),
});
export type ModemScanOutput = z.infer<typeof modemScanOutputSchema>;

// SIM PIN unlock terminal states
export const simUnlockStateSchema = z.enum([
	'success',
	'wrong-pin',
	'puk-required',
	'no-locked-modem',
	'error',
]);
export type SimUnlockState = z.infer<typeof simUnlockStateSchema>;

// SIM PIN unlock input schema
export const simUnlockInputSchema = z.object({
	modemPath: z.string().min(1),
	// SIM PIN grammar (4–8 digits): rejects any argv-injection payload at the boundary
	pin: z.string().regex(new RegExp(`^\\d{${SIM_PIN_MIN_LENGTH},${SIM_PIN_MAX_LENGTH}}$`), {
		message: `PIN must be ${SIM_PIN_MIN_LENGTH}–${SIM_PIN_MAX_LENGTH} digits`,
	}),
	// Opt-in "remember PIN": persist a confirmed-correct PIN to a chmod-600 tmpfs
	// secrets file (NOT config.json) for boot auto-unlock. `false` opts back out
	// and clears any stored PIN; absent leaves the stored PIN untouched.
	remember: z.boolean().optional(),
});
export type SimUnlockInput = z.infer<typeof simUnlockInputSchema>;

// SIM PIN unlock output schema (remainingAttempts present only on wrong-pin)
export const simUnlockOutputSchema = z.object({
	state: simUnlockStateSchema,
	remainingAttempts: z.number().int().nonnegative().optional(),
	// Present ONLY when the mutation lease refused, alongside `state: 'error'`.
	// Additive so a consumer that does not know it still renders the legacy
	// terminal, while one that does can say WHY nothing was submitted.
	mutationRefusal: modemMutationRefusalSchema.optional(),
});
export type SimUnlockOutput = z.infer<typeof simUnlockOutputSchema>;

// ── SIM PIN2 (Fixed Dialling Number) verification ────────────────────────────
// Kept separate from `simUnlock*` above rather than folded in, because PIN1 and
// PIN2 differ in the two dimensions a consumer acts on. CONSEQUENCE: PIN1 gates
// the whole card, PIN2 only gates restricted SIM services (the FDN list, some
// call-cost settings) — ModemManager never moves a PIN2-locked modem to LOCKED.
// TRANSPORT: ModemManager has no PIN2 API at all, so the submit runs over libqmi
// rather than mmcli; the evidence is in `modules/modems/sim-pin2.ts`.
//
// `unsupported` is a FIRST-CLASS terminal, not an error: a non-QMI modem has no
// PIN2 route on this device, and a generic `error` would invite a doomed retry.
export const simPin2UnlockStateSchema = z.enum([
	'success',
	'wrong-pin2',
	'puk2-required',
	'no-pin2-lock',
	'unsupported',
	'error',
]);
export type SimPin2UnlockState = z.infer<typeof simPin2UnlockStateSchema>;

export const simPin2UnlockInputSchema = z.object({
	modemPath: z.string().min(1),
	// Same 4–8 digit grammar as PIN1: rejects any argv-injection payload at the
	// boundary. Deliberately NO `remember` flag — see the boot auto-unlock
	// decision recorded in `modules/modems/sim-autounlock.ts`.
	pin2: z.string().regex(new RegExp(`^\\d{${SIM_PIN_MIN_LENGTH},${SIM_PIN_MAX_LENGTH}}$`), {
		message: `PIN2 must be ${SIM_PIN_MIN_LENGTH}–${SIM_PIN_MAX_LENGTH} digits`,
	}),
});
export type SimPin2UnlockInput = z.infer<typeof simPin2UnlockInputSchema>;

// `remainingAttempts` is the PIN2 retry budget, present on `wrong-pin2` and
// absent when it could not be re-read.
export const simPin2UnlockOutputSchema = z.object({
	state: simPin2UnlockStateSchema,
	remainingAttempts: z.number().int().nonnegative().optional(),
	mutationRefusal: modemMutationRefusalSchema.optional(),
});
export type SimPin2UnlockOutput = z.infer<typeof simPin2UnlockOutputSchema>;

// SIM PUK unlock failure reasons (absent on success)
export const simPukErrorSchema = z.enum(['wrong-puk', 'locked', 'no-locked-modem', 'error']);
export type SimPukError = z.infer<typeof simPukErrorSchema>;

// SIM PUK unlock input: the PUK plus a new PIN to program onto the SIM
export const simPukUnlockInputSchema = z.object({
	modemPath: z.string().min(1),
	puk: z.string().regex(new RegExp(`^\\d{${SIM_PUK_LENGTH}}$`), {
		message: `PUK must be ${SIM_PUK_LENGTH} digits`,
	}),
	newPin: z.string().regex(new RegExp(`^\\d{${SIM_PIN_MIN_LENGTH},${SIM_PIN_MAX_LENGTH}}$`), {
		message: `PIN must be ${SIM_PIN_MIN_LENGTH}–${SIM_PIN_MAX_LENGTH} digits`,
	}),
});
export type SimPukUnlockInput = z.infer<typeof simPukUnlockInputSchema>;

// SIM PUK unlock output: remainingAttempts carries the PUK retry count on failure
export const simPukUnlockOutputSchema = z.object({
	success: z.boolean(),
	remainingAttempts: z.number().int().nonnegative().optional(),
	error: simPukErrorSchema.optional(),
	mutationRefusal: modemMutationRefusalSchema.optional(),
});
export type SimPukUnlockOutput = z.infer<typeof simPukUnlockOutputSchema>;

// ── USB composition-mode switch (Phase B) ────────────────────────────────────
// The guarded operator mutation behind the default-absent `modem_provisioning`
// config key. `.strict()` + `confirm: z.literal(true)` are the TOCTOU boundary:
// a switch re-enumerates the modem and drops its bond link, so the request must
// be impossible to issue by accident — an unknown extra key is rejected rather
// than ignored, and an omitted or falsy `confirm` never reaches the handler.
export const setUsbModeInputSchema = z
	.object({
		device: z.string().min(1),
		mode: usbCompositionModeSchema,
		confirm: z.literal(true),
	})
	.strict();
export type SetUsbModeInput = z.infer<typeof setUsbModeInputSchema>;

// Typed refusals. Each names a DIFFERENT thing the operator can do about it, so
// they are never collapsed into a generic error:
//   provisioning_disabled          — `modem_provisioning` is absent/false (default)
//   streaming_active               — a stream is live or being admitted
//   unavailable_in_emulated_mode   — no real hardware to transition
//   uncertified                    — the SKU has no reviewed catalog entry
//                                    permitting this transition
//   transition_in_progress         — another modem transition already holds the
//                                    lifecycle interlock; wait for it to settle
//   transition_failed              — the gates passed and the transaction did not
//                                    reach its verified postcondition
export const setUsbModeRefusalSchema = z.enum([
	'provisioning_disabled',
	'streaming_active',
	'unavailable_in_emulated_mode',
	'uncertified',
	'transition_in_progress',
	'transition_failed',
	// The shared mutation-safety refusals. A USB-mode switch is a mutation like
	// any other, so it answers the same vocabulary every other mutating modem
	// entrypoint does rather than flattening those states into `transition_failed`
	// — "the device is blocked pending your acknowledgement" and "the transaction
	// broke" are not the same message.
	'recovery_pending',
	'mutation_blocked',
	'device_decommissioned',
	'rebaseline_required',
]);
export type SetUsbModeRefusal = z.infer<typeof setUsbModeRefusalSchema>;

// The TYPED reason a `transition_failed` carries. `error` names what the operator
// asked for and did not get; `reason` names WHY, in the only five ways the
// transaction can end short of success. It is additive-optional and present ONLY
// alongside `transition_failed` — every other refusal is already self-explanatory,
// and a reason on `uncertified` would imply a variability the catalog does not have.
//
// Each maps to a DIFFERENT operator action, which is why they are not one string:
//   identity_unresolved    — the device behind that id could not be pinned to a
//                            udev entry with a usable ID_PATH (replug/reboot).
//   engine_unavailable     — the SKU is certified but no transition engine is
//                            wired on this build (report it; nothing to retry).
//   preconditions_refused  — the engine's own re-check closed a gate between our
//                            check and its actor (retry once idle).
//   postcondition_mismatch — the device re-enumerated as something OTHER than the
//                            catalog target. The switch ran; the result is wrong.
//   transaction_error      — the transaction threw or timed out mid-flight.
export const setUsbModeFailureReasonSchema = z.enum([
	'identity_unresolved',
	'engine_unavailable',
	'preconditions_refused',
	'postcondition_mismatch',
	'transaction_error',
]);
export type SetUsbModeFailureReason = z.infer<typeof setUsbModeFailureReasonSchema>;

export const setUsbModeOutputSchema = z.object({
	success: z.boolean(),
	error: setUsbModeRefusalSchema.optional(),
	reason: setUsbModeFailureReasonSchema.optional(),
});
export type SetUsbModeOutput = z.infer<typeof setUsbModeOutputSchema>;

// ── Which modes may be OFFERED at all (`modems.getUsbModeOptions`) ───────────
// A pure READ of the same certified catalog `setUsbMode` gates on, asked BEFORE
// anything is offered rather than after something is refused. `recommended_usb_mode`
// cannot answer this: it is a per-SKU ADVISORY that says nothing about whether a
// transition into it has ever been certified for THIS model and firmware.
//
// It is a read, so it takes NO mutation lease (the `modems.getAll`/`getSms`
// rule) and mutates nothing.
export const usbModeOptionsInputSchema = z.object({ device: z.string().min(1) }).strict();
export type UsbModeOptionsInput = z.infer<typeof usbModeOptionsInputSchema>;

// Why NO mode may be offered, when there is a nameable reason. Every member is
// drawn from the EXISTING typed switch vocabulary rather than invented here, so
// the reason an offer is withheld and the reason a dispatch is refused resolve
// through the same operator strings and cannot drift into two sentences for one
// fact. Note the two source enums: `uncertified` and `unavailable_in_emulated_mode`
// are `setUsbModeRefusalSchema` members, while `identity_unresolved` is a
// `setUsbModeFailureReasonSchema` member (it rides `transition_failed`). That
// split is why a consumer resolves its copy key through a TABLE and never by
// interpolating one namespace. `modem-usb-mode-certification.test.ts` pins the
// containment.
//
//   identity_unresolved          — no physical USB device stands behind that id.
//                                  A native-PCIe modem and a router-mode dongle
//                                  both land here, and correctly so: neither has
//                                  a USB composition to switch.
//   uncertified                  — the device resolved, and its exact
//                                  model + firmware has no reviewed catalog entry.
//                                  RETAINED for the catalog path and for wire
//                                  compat, and NO LONGER the answer for a device
//                                  this build knows how to interrogate — see the
//                                  runtime vocabulary directly below.
//   unavailable_in_emulated_mode — not real hardware.
//
// The RUNTIME half of the vocabulary is mirrored VERBATIM from modem-stack's
// `resolveRuntimeCompositionCapability` (`control/src/usb-mode/runtime-capability.ts`).
// Its four literals are hyphenated because they are that model's own strings, and
// re-spelling them in this file's snake_case would put two vocabularies on the two
// sides of one seam for a consumer to reconcile. They answer four DIFFERENT
// questions, and no pair of them may be collapsed back into `uncertified`: that
// token asserts "your model was never reviewed", which is false of every device
// whose own firmware will enumerate its compositions on request.
//
//   unknown-vendor        — this build has no reviewed way to ASK this device what
//                           compositions it has. Honest, and no control at all.
//   no-return-path        — the device enumerated targets, and its own enumeration
//                           does NOT contain the mode it is in right now, so
//                           nothing proves a route back. Withheld, with the reason.
//   blocked-by-state      — a live condition (a stream, another mutation) forbids
//                           asking right now. Visible, disabled, with the reason.
//   provisioning-disabled — `modem_provisioning` is off. Visible, disabled, and the
//                           reason points at the setting the operator can flip.
export const USB_MODE_RUNTIME_SUPPRESSIONS = [
	'unknown-vendor',
	'no-return-path',
	'blocked-by-state',
	'provisioning-disabled',
] as const;
export const usbModeRuntimeSuppressionSchema = z.enum(USB_MODE_RUNTIME_SUPPRESSIONS);
export type UsbModeRuntimeSuppression = z.infer<typeof usbModeRuntimeSuppressionSchema>;

export const usbModeOfferSuppressionSchema = z.enum([
	'identity_unresolved',
	'uncertified',
	'unavailable_in_emulated_mode',
	...USB_MODE_RUNTIME_SUPPRESSIONS,
]);
export type UsbModeOfferSuppression = z.infer<typeof usbModeOfferSuppressionSchema>;

// The two suppressions that describe a condition the operator can LIFT, rather
// than a property of the device. They render as a disabled control carrying its
// reason; everything else renders no control at all, because a disabled control
// claims a capability is being withheld and for the others there is none to
// withhold. Exported so the render rule and the device's own ladder cannot drift.
export const USB_MODE_LIFTABLE_SUPPRESSIONS = [
	'blocked-by-state',
	'provisioning-disabled',
] as const satisfies readonly UsbModeOfferSuppression[];

// The device's OWN enumeration, carried verbatim beside the offer. It is EVIDENCE,
// never an offer: the values are the vendor's private vocabulary (`40`, `41`,
// `"9011"`), which the dispatch — whose confirmation compares the canonical
// `modem.usb_mode` — has no way to act on. Publishing it is what lets an operator
// (and a support transcript) see WHY a device with a working radio is being told
// its composition cannot be switched, without anyone re-deriving it from a log.
export const usbRuntimeCompositionModeSchema = z.union([
	z.number().int().min(0),
	z.string().min(1).max(32),
]);
export type UsbRuntimeCompositionMode = z.infer<typeof usbRuntimeCompositionModeSchema>;

export const usbModeRuntimeEvidenceSchema = z.object({
	// The vendor family this build knows how to ask — never a marketing name.
	vendor: z.string().min(1),
	current: usbRuntimeCompositionModeSchema,
	// Every mode the device itself enumerated, verbatim and in its own order.
	enumerated: z.array(usbRuntimeCompositionModeSchema),
	// Whether `enumerated` contains `current`. FALSE is what produces
	// `no-return-path`, and it is published rather than inferred so a consumer
	// never has to re-run the membership test to explain the suppression.
	return_path_proven: z.boolean(),
});
export type UsbModeRuntimeEvidence = z.infer<typeof usbModeRuntimeEvidenceSchema>;

// `certified` is ALWAYS present and is the certified TARGET set — the `to` side
// of every permitted transition leading OUT of the mode the device is in right
// now. It therefore never contains the active mode (the catalog schema refines
// `from !== to`), and an empty array means "nothing to offer", never "unknown".
//
// An empty array with NO `suppressed` is its own honest state: the SKU IS
// certified, and this particular mode simply has no certified way out. Reporting
// that as `uncertified` would tell an operator their model was never reviewed.
export const usbModeOptionsOutputSchema = z.object({
	certified: z.array(usbCompositionModeSchema),
	active: usbCompositionModeSchema.optional(),
	suppressed: usbModeOfferSuppressionSchema.optional(),
	runtime: usbModeRuntimeEvidenceSchema.optional(),
});
export type UsbModeOptionsOutput = z.infer<typeof usbModeOptionsOutputSchema>;

// Shared oRPC error code raised by EVERY modem procedure while the cellular
// composition root is still resolving its backend. It is a distinct code, not a
// per-procedure failure shape, so a frontend renders one "still starting up"
// state instead of a different error per surface.
export const CELLULAR_STACK_INITIALIZING = 'CELLULAR_STACK_INITIALIZING';

// ── Read-only SMS inbox (Phase B) ────────────────────────────────────────────
// PERMANENTLY READ-ONLY. There is no `sendSms`, no `deleteSms`, and no schema
// here that could carry one — the device's SMS surface is list + read and
// nothing else. That is not a "not yet": a send/delete path would add real
// modem-control surface (and a billable, irreversible side effect) to what is
// otherwise a diagnostic read, so it is locked out by a grep gate in the backend
// test suite rather than left to reviewer memory.

/**
 * ModemManager `MMSmsState`, verbatim. Same `.catch()` treatment as
 * {@link connectionStatusSchema} and for the same reason: this is validated on
 * the OUTPUT side, where one unrecognised token from a future MM release would
 * otherwise reject the WHOLE inbox rather than the one field it came from.
 */
export const smsStateSchema = z.enum([
	'unknown',
	'stored',
	'receiving',
	'received',
	'sending',
	'sent',
]);
export type SmsState = z.infer<typeof smsStateSchema>;

const UNKNOWN_SMS_STATE: SmsState = 'unknown';

/**
 * One stored message.
 *
 * `from` is NOT a phone-number type: a real board's inbox is mostly shortcodes
 * and alphanumeric sender IDs ("CLARO", "85573"), so it is a free string and is
 * OPTIONAL — mmcli prints `--` for a message that carries no originator.
 * `timestamp` is the service-centre timestamp as mmcli renders it (ISO-8601 with
 * a UTC offset, e.g. `2025-08-21T17:20:16-05`) and is likewise optional; it is
 * passed through VERBATIM rather than normalised, because re-zoning a timestamp
 * the carrier stamped is a lie about when the message was sent.
 *
 * `text` is required but may be empty — a data-only (WAP/PDU) message has no
 * text at all, and an empty string says that honestly.
 */
export const smsMessageSchema = z.object({
	/** The message's ModemManager object index, as a string (e.g. "36"). */
	id: z.string(),
	from: z.string().optional(),
	timestamp: z.string().optional(),
	text: z.string(),
	state: smsStateSchema.catch(UNKNOWN_SMS_STATE),
});
export type SmsMessage = z.infer<typeof smsMessageSchema>;

/** Newest-first cap. The wire never carries more than this many messages. */
export const SMS_INBOX_CAP = 50;

// `device` is the same selector every other modem procedure takes: a bare
// ModemManager index ("2") or a full `/org/freedesktop/ModemManager1/Modem/N`
// path. The backend re-validates it against `MODEM_PATH_RE` before it becomes an
// mmcli argument.
export const modemSmsInputSchema = z.object({
	device: z.string().min(1),
});
export type ModemSmsInput = z.infer<typeof modemSmsInputSchema>;

/**
 * Why the device could not produce an inbox. Each is a DIFFERENT operator fact,
 * which is the whole point of typing them: none of them may be collapsed into
 * `{success: true, messages: []}`, because an empty array means "this modem has
 * an inbox and it is empty" and nothing else.
 *
 *   unsupported   — the modem exposes no ModemManager Messaging interface at
 *                   all (mmcli: "modem has no messaging capabilities"). The UI
 *                   omits the section entirely; there is nothing to retry.
 *   not_enabled   — the radio is not enabled yet, so messaging is not up. This
 *                   resolves on its own; it is not a capability statement.
 *   unknown_modem — no modem answers to that selector.
 *   read_failed   — the read ran and its output did not parse (CLI drift), or
 *                   mmcli failed for a reason none of the above names.
 */
export const modemSmsRefusalSchema = z.enum([
	'unsupported',
	'not_enabled',
	'unknown_modem',
	'read_failed',
]);
export type ModemSmsRefusal = z.infer<typeof modemSmsRefusalSchema>;

export const modemSmsOutputSchema = z.object({
	success: z.boolean(),
	/** Newest-first, at most {@link SMS_INBOX_CAP}. Present only on success. */
	messages: z.array(smsMessageSchema).max(SMS_INBOX_CAP).optional(),
	error: modemSmsRefusalSchema.optional(),
});
export type ModemSmsOutput = z.infer<typeof modemSmsOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// GPS / location (`modems.getGps` / `modems.setGps`)
//
// THE PRIVACY FENCE IS THE SHAPE. There is no history array, no track, no
// export, and no upload anywhere below, and none may be added: the module reads
// the CURRENT fix for a live display and nothing else. `gnssFixStateSchema` can
// carry AT MOST ONE fix by construction, which is the fence expressed as a type
// rather than as a rule someone has to remember.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The GNSS sources ModemManager's `Location.Capabilities` can advertise.
 *
 * `3gpp-lac-ci` is deliberately absent: coarse cell location is the cell-info
 * module's surface, and MM advertises it on devices with no GNSS receiver at
 * all — treating it as a GNSS source would offer a location control on hardware
 * that cannot produce a fix.
 */
export const GNSS_SOURCES = [
	'gps-raw',
	'gps-nmea',
	'gps-unmanaged',
	'agps-msa',
	'agps-msb',
] as const;
export const gnssSourceSchema = z.enum(GNSS_SOURCES);
export type GnssSource = z.infer<typeof gnssSourceSchema>;

/**
 * How long acquisition may run before it becomes an honest terminal "no fix",
 * and how long a fix stays current before it is DROPPED.
 *
 * Both are shared because both halves render them: the backend advances the
 * state machine against them and the frontend shows the operator the bound it
 * is waiting against. Two copies would let a progress indicator promise a window
 * the device does not honour.
 */
export const GNSS_ACQUIRE_TIMEOUT_MS = 120_000;
export const GNSS_FIX_TTL_MS = 30_000;

/**
 * One GNSS fix. SENSITIVE — the backend's log redaction scrubs every key here by
 * name, and nothing persists it.
 *
 * `observedAt` is when the DEVICE read the fix, which is what staleness is
 * measured against; a modem's own `utcTime` cannot be trusted to advance.
 */
export const gnssFixSchema = z.object({
	latitude: z.number().min(-90).max(90),
	longitude: z.number().min(-180).max(180),
	altitude: z.number().optional(),
	utcTime: z.string().optional(),
	observedAt: z.number().int().nonnegative(),
});
export type GnssFix = z.infer<typeof gnssFixSchema>;

/**
 * Why there is no fix. Three DIFFERENT operator facts:
 *
 *   acquire-timeout — the bounded wait elapsed. On a modem with no antenna this
 *                     is the terminal state, and it is the point of the bound:
 *                     an unbounded wait renders as a spinner forever.
 *   reported-no-fix — the receiver answered and has not acquired a position.
 *   fix-expired     — a fix was held and aged past its TTL, so it was dropped.
 */
export const GNSS_NO_FIX_REASONS = ['acquire-timeout', 'reported-no-fix', 'fix-expired'] as const;
export const gnssNoFixReasonSchema = z.enum(GNSS_NO_FIX_REASONS);
export type GnssNoFixReason = z.infer<typeof gnssNoFixReasonSchema>;

/**
 * The whole renderable GNSS state, and the reason a stale coordinate cannot
 * reach an operator: a fix exists ONLY inside the `fix` arm, so every other
 * state is structurally incapable of carrying one. `acquiring` is the only
 * state a spinner may render, and it is bounded.
 */
export const gnssFixStateSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('off') }),
	z.object({
		kind: z.literal('acquiring'),
		since: z.number().int().nonnegative(),
		/** Wall-clock instant the wait becomes `no-fix`. Rendered as a bound. */
		deadline: z.number().int().nonnegative(),
	}),
	z.object({
		kind: z.literal('no-fix'),
		since: z.number().int().nonnegative(),
		reason: gnssNoFixReasonSchema,
	}),
	z.object({ kind: z.literal('fix'), fix: gnssFixSchema }),
	z.object({ kind: z.literal('unavailable'), reason: z.string() }),
]);
export type GnssFixState = z.infer<typeof gnssFixStateSchema>;

/** What `Location.Capabilities` / `Location.Enabled` advertise right now. */
export const modemGpsStatusSchema = z.object({
	/** Every advertised source name, GNSS or not (`3gpp-lac-ci` included). */
	capabilities: z.array(z.string()),
	enabledSources: z.array(z.string()),
	gnssCapable: z.boolean(),
	gnssEnabled: z.boolean(),
});
export type ModemGpsStatus = z.infer<typeof modemGpsStatusSchema>;

/**
 * Why the device could not answer. Never collapsed into a `no-fix` state:
 * "this modem has no GNSS receiver" and "the receiver has not locked on" are
 * different facts, and rendering the first as the second would leave an operator
 * waiting on hardware that will never answer.
 */
export const modemGpsRefusalSchema = z.enum([
	'unsupported',
	'not_enabled',
	'unknown_modem',
	'read_failed',
]);
export type ModemGpsRefusal = z.infer<typeof modemGpsRefusalSchema>;

export const modemGpsInputSchema = z.object({
	device: z.string().min(1),
});
export type ModemGpsInput = z.infer<typeof modemGpsInputSchema>;

export const modemGpsOutputSchema = z.object({
	success: z.boolean(),
	status: modemGpsStatusSchema.optional(),
	state: gnssFixStateSchema.optional(),
	error: modemGpsRefusalSchema.optional(),
});
export type ModemGpsOutput = z.infer<typeof modemGpsOutputSchema>;

/**
 * `.strict()`, so an unknown extra key is REJECTED rather than ignored.
 *
 * Deliberately NO `confirm: true`, unlike `setUsbMode`/`setBands`. That literal
 * exists because those mutations re-enumerate or re-register the radio and can
 * cost the bond link; switching a GNSS receiver on touches no bearer and is
 * reversed by sending `enabled: false`. A confirmation step here would be
 * friction with no safety behind it.
 */
export const setModemGpsInputSchema = z
	.object({
		device: z.string().min(1),
		enabled: z.boolean(),
	})
	.strict();
export type SetModemGpsInput = z.infer<typeof setModemGpsInputSchema>;

export const setModemGpsOutputSchema = z.object({
	success: z.boolean(),
	/** What the modem reports AFTER the call — never what was asked for. */
	status: modemGpsStatusSchema.optional(),
	state: gnssFixStateSchema.optional(),
	error: modemGpsRefusalSchema.optional(),
	mutationRefusal: capabilityMutationRefusalSchema.optional(),
	detail: z.string().optional(),
});
export type SetModemGpsOutput = z.infer<typeof setModemGpsOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Band lock (`modems.getBands` / `modems.setBands`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A band as ModemManager itself spells it (`eutran-3`, `utran-1`, `egsm`,
 * `ngran-78`, `any`), plus the `band-<n>` passthrough `@ceralive/modem-control`
 * emits for a value this build cannot name.
 *
 * It is a STRING and deliberately not an enum. The band vocabulary is
 * ModemManager's, it grows with every 3GPP release, and a device is the only
 * authority on which of them it advertises — an enum here would reject a band a
 * newer daemon reports and silently remove it from a selection, which is exactly
 * the partial-lock failure `encodeBandList` fails closed to prevent one layer
 * down. The pattern is a shape check (no whitespace, no argv metacharacter), not
 * a membership check.
 */
export const BAND_NAME_RE = /^[a-z0-9-]{2,32}$/;
export const bandNameSchema = z.string().regex(BAND_NAME_RE);

/** The reset value. Setting exactly this releases the lock; MM has no reset verb. */
export const BAND_ANY = 'any';

export const modemBandsInputSchema = z.object({ device: z.string().min(1) }).strict();
export type ModemBandsInput = z.infer<typeof modemBandsInputSchema>;

/**
 * Why no band surface can be produced. Each is a different operator fact and
 * none may be collapsed into an empty `supported` list, which means "this modem
 * answered, and it advertises no selectable band".
 *
 *   unsupported   — this build cannot reach a band API on this device at all.
 *   uncertified   — the modem advertises bands, and NO reviewed evidence proves
 *                   set + readback + reset on this model+firmware. The control
 *                   is HIDDEN rather than disabled: an offered-but-unproven band
 *                   lock can strand the uplink with no way back.
 *   module_disabled    — the `band_lock` capability gate is off on this device.
 *   unknown_modem      — no modem answers to that selector.
 *   read_failed        — the read ran and could not be parsed.
 */
export const modemBandsRefusalSchema = z.enum([
	'unsupported',
	'uncertified',
	'module_disabled',
	'unknown_modem',
	'read_failed',
]);
export type ModemBandsRefusal = z.infer<typeof modemBandsRefusalSchema>;

export const modemBandsSchema = z.object({
	/** Everything the modem advertises, verbatim and unfiltered. */
	supported: z.array(bandNameSchema),
	/** What it reports as selected right now. `['any']` means unlocked. */
	current: z.array(bandNameSchema),
	/**
	 * The subset a control may OFFER — `supported` narrowed by the certification
	 * entry. Published separately from `supported` because the two answer
	 * different questions, and collapsing them would make "the modem has this
	 * band" indistinguishable from "we proved this band is safe to select".
	 */
	offerable: z.array(bandNameSchema),
	/** True when `current` is exactly the reset value. */
	unlocked: z.boolean(),
});
export type ModemBands = z.infer<typeof modemBandsSchema>;

export const modemBandsOutputSchema = z.object({
	success: z.boolean(),
	bands: modemBandsSchema.optional(),
	error: modemBandsRefusalSchema.optional(),
});
export type ModemBandsOutput = z.infer<typeof modemBandsOutputSchema>;

/**
 * `.strict()` with a required `confirm: true`, the `setUsbMode` precedent: this
 * mutation re-registers the radio and can cost the bond link, so an unknown
 * extra key must be REJECTED rather than ignored and an omitted confirmation
 * must never reach the handler.
 *
 * There is no separate `reset` flag. `bands: ['any']` IS the reset, because that
 * is the one call ModemManager offers — a second way to express it would be a
 * second thing to keep in agreement.
 */
export const setModemBandsInputSchema = z
	.object({
		device: z.string().min(1),
		bands: z.array(bandNameSchema).min(1).max(128),
		confirm: z.literal(true),
	})
	.strict();
export type SetModemBandsInput = z.infer<typeof setModemBandsInputSchema>;

/**
 * How a band change ended. `auto_restored` is not a failure and not a success:
 * the write landed, the radio did not re-register within the bound, and the
 * timed rollback put the previous selection back — the operator's uplink is
 * intact and their request did not take effect. Reporting it as either of the
 * other two would be a lie in one direction or the other.
 *
 *   applied         — set, read back, and the radio re-registered.
 *   auto_restored   — set, then rolled back because registration was lost.
 *   rejected        — the modem refused the write; nothing changed.
 *   readback_failed — the write was accepted and the modem reports something
 *                     else. Rolled back, and distinct from `rejected` because
 *                     an accepted-but-ignored write is a firmware fact worth
 *                     recording against the SKU.
 *   restore_failed  — the rollback itself did not restore. The device stays
 *                     fail-closed until the operator acknowledges.
 */
export const setModemBandsStatusSchema = z.enum([
	'applied',
	'auto_restored',
	'rejected',
	'readback_failed',
	'restore_failed',
]);
export type SetModemBandsStatus = z.infer<typeof setModemBandsStatusSchema>;

export const setModemBandsOutputSchema = z.object({
	success: z.boolean(),
	status: setModemBandsStatusSchema.optional(),
	/** What the modem reports AFTER everything settled — never what was asked for. */
	bands: z.array(bandNameSchema).optional(),
	error: modemBandsRefusalSchema.optional(),
	mutationRefusal: capabilityMutationRefusalSchema.optional(),
	detail: z.string().optional(),
});
export type SetModemBandsOutput = z.infer<typeof setModemBandsOutputSchema>;

/* ------------------------------------------------------------------------- *
 * ROUTER-DONGLE ADMIN-UI REVERSE PROXY
 * ------------------------------------------------------------------------- */

/**
 * Path prefix of the CeraUI-hosted reverse proxy onto a router-mode dongle's
 * OWN embedded admin web UI. A request is `<prefix>/<wireId>/<path…>`.
 *
 * The `wireId` — NOT a destination address — is what names the device. Two
 * identical dongles ship one factory LAN subnet, so the bench pair both answer
 * on `192.168.8.1` and a destination address selects a PAIR rather than a unit
 * (board-measured: the ZTE on a different subnet answered `192.168.8.1` too,
 * because the binding, not the address, is what routes). The id resolves to an
 * INTERFACE, and the outbound request is bound to it.
 */
export const DONGLE_ADMIN_PATH_PREFIX = '/dongle-admin';

/**
 * Query parameter carrying the single-use token that opens an admin session.
 * Minted over the already-authenticated RPC socket, exchanged once for an
 * HttpOnly cookie scoped to {@link DONGLE_ADMIN_PATH_PREFIX} — the operator's
 * password never rides the URL, and the browsing session that follows is
 * cookie-authenticated like the rest of CeraUI's origin.
 */
export const DONGLE_ADMIN_TOKEN_PARAM = 'dongle_token';

/** Cookie name carrying an opened admin session. */
export const DONGLE_ADMIN_COOKIE = 'ceraui_dongle_admin';

export const openRouterAdminInputSchema = z.object({ device: z.string().min(1) }).strict();
export type OpenRouterAdminInput = z.infer<typeof openRouterAdminInputSchema>;

/**
 * Why an admin-UI session could not be opened.
 *
 *   unknown_device      — the id names no dongle the classifier currently holds.
 *   interface_unresolved — the row exists but its interface could not be named,
 *                          so nothing could be bound and a destination address
 *                          alone cannot tell two identical units apart.
 *   admin_unreachable   — no default gateway for that interface, i.e. the
 *                         dongle has not leased this host an address yet.
 */
export const openRouterAdminRefusalSchema = z.enum([
	'unknown_device',
	'interface_unresolved',
	'admin_unreachable',
]);
export type OpenRouterAdminRefusal = z.infer<typeof openRouterAdminRefusalSchema>;

export const openRouterAdminOutputSchema = z.object({
	success: z.boolean(),
	/** Same-origin path to open. Absent on refusal. */
	url: z.string().optional(),
	error: openRouterAdminRefusalSchema.optional(),
});
export type OpenRouterAdminOutput = z.infer<typeof openRouterAdminOutputSchema>;
