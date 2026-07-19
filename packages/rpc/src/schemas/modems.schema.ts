/**
 * Modem Zod schemas
 */
import { z } from 'zod';

// Modem network type enum
export const modemNetworkTypeSchema = z.enum(['3g', '4g', '4g3g', '5g', '5g4g', '5g3g', '5g4g3g']);
export type ModemNetworkType = z.infer<typeof modemNetworkTypeSchema>;

// Connection status enum
export const connectionStatusSchema = z.enum([
	'connected',
	'failed',
	'registered',
	'connecting',
	'scanning',
]);
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

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
});
export type ModemConfig = z.infer<typeof modemConfigSchema>;

// Modem status schema
export const modemStatusSchema = z.object({
	connection: connectionStatusSchema,
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

// ── Phase-B additive-optional detail fields (T5.4) ───────────────────────────
// Every schema below is ADDITIVE-OPTIONAL: a modem entry that omits them all
// parses byte-identically to the pre-Phase-B wire shape, so an old backend or an
// old frontend still round-trips. The device/hub binding-ledger semantics are the
// single source of truth for what each field MEANS — see the annex.

// Transport / device class the modem is attached over (binding-ledger:
// `transport: usb|pcie-mhi|pcie-mtk|soc-qrtr|router-ethernet`). Read-only.
export const modemDeviceClassSchema = z.enum([
	'usb',
	'pcie-mhi',
	'pcie-mtk',
	'soc-qrtr',
	'router-ethernet',
]);
export type ModemDeviceClass = z.infer<typeof modemDeviceClassSchema>;

// Per-modem recovery-ladder state (binding-ledger C3 state machine). Read-only.
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

// Active / recommended USB composition mode (binding-ledger W6.5b canonical enum).
// `usb_mode` is a read-only observation from the W6.1 classifier;
// `recommended_usb_mode` is a per-SKU most-stable advisory — informational, never
// gating.
export const usbCompositionModeSchema = z.enum([
	'qmi',
	'mbim',
	'ecm-ncm',
	'rndis',
	'router-ethernet',
]);
export type UsbCompositionMode = z.infer<typeof usbCompositionModeSchema>;

// Cellular data-usage totals (binding-ledger W6.7). `session_bytes` is the
// current-boot total; `monthly_bytes` the UTC billing-cycle total. `cycle_day`
// and `threshold_bytes` are the operator's optional configured meter bounds. All
// counters are wire bytes (RX+TX), non-negative. Read-mostly (cycle_day/threshold
// are operator-set via modems.configure in a later wave).
export const modemDataUsageSchema = z.object({
	session_bytes: z.number().nonnegative().optional(),
	monthly_bytes: z.number().nonnegative().optional(),
	cycle_day: z.number().int().min(1).max(31).optional(),
	threshold_bytes: z.number().nonnegative().optional(),
});
export type ModemDataUsage = z.infer<typeof modemDataUsageSchema>;

// Read-only eSIM facts (binding-ledger W6.8; MM 1.20 SimType/EsimStatus/EID).
export const modemEsimSchema = z.object({
	sim_type: z.enum(['physical', 'esim', 'unknown']).optional(),
	esim_status: z.enum(['no-profiles', 'with-profiles', 'unknown']).optional(),
	eid: z.string().optional(),
});
export type ModemEsim = z.infer<typeof modemEsimSchema>;

// Read-only serving-cell telemetry (binding-ledger W6.8; MM 1.20 GetCellInfo).
// NR uses `sinr` (NOT `snr` — round-10 ledger correction). `band` present only
// when directly supplied by the modem. `provenance` records source + observed-at
// per the W6.8 provenance model.
export const modemCellInfoSchema = z.object({
	tech: z.enum(['lte', 'nr', 'unknown']).optional(),
	cell_id: z.string().optional(),
	band: z.string().optional(),
	rsrp: z.number().optional(),
	rsrq: z.number().optional(),
	// LTE signal-to-noise; NR signal-to-interference-plus-noise.
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
	status: modemStatusSchema.optional(),
	no_sim: z.boolean().optional(),
	sim_lock: simLockSchema.optional(),

	// ── Phase-B additive-optional fields (T5.4) — ALL optional, additive-only.
	// An old backend/frontend pair that omits every one of these still round-trips
	// (contract-tested). Never promote any of these to required.
	device_class: modemDeviceClassSchema.optional(),
	// Human-readable reason a modem/slot is currently unavailable — drives the
	// disabled-with-reason row on the Network destination.
	availability_reason: z.string().optional(),
	// Display label for the modem's active SIM slot (multi-slot boards).
	slot_label: z.string().optional(),
	recovery_state: modemRecoveryStateSchema.optional(),
	usb_mode: usbCompositionModeSchema.optional(),
	recommended_usb_mode: usbCompositionModeSchema.optional(),
	data_usage: modemDataUsageSchema.optional(),
	firmware_revision: z.string().optional(),
	esim: modemEsimSchema.optional(),
	cell_info: modemCellInfoSchema.optional(),
});
export type Modem = z.infer<typeof modemSchema>;

// Modem list schema
export const modemListSchema = z.record(z.string(), modemSchema);
export type ModemList = z.infer<typeof modemListSchema>;

// Modem config input schema
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
});
export type ModemConfigApplied = z.infer<typeof modemConfigAppliedSchema>;

// Modem config output schema
export const modemConfigOutputSchema = z.object({
	success: z.boolean(),
	applied: modemConfigAppliedSchema.optional(),
});
export type ModemConfigOutput = z.infer<typeof modemConfigOutputSchema>;

// Modem scan input schema
export const modemScanInputSchema = z.object({
	device: z.coerce.number(),
});
export type ModemScanInput = z.infer<typeof modemScanInputSchema>;

// Modem scan output schema
export const modemScanOutputSchema = z.object({
	success: z.boolean(),
	networks: z.record(z.string(), availableNetworkSchema).optional(),
	error: z.string().optional(),
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
});
export type SimUnlockOutput = z.infer<typeof simUnlockOutputSchema>;

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
});
export type SimPukUnlockOutput = z.infer<typeof simPukUnlockOutputSchema>;

// ── USB composition-mode switch (Phase B, T5.4) ──────────────────────────────
// The guarded operator mutation gated by the `modem_provisioning` config key. The
// full re-enumeration transaction is a later wave; THIS wave ships the schema plus
// the default-absent refusal gate. `.strict()` + `confirm: z.literal(true)` are the
// TOCTOU boundary hardening called out in the binding ledger (round-6 O5).
export const setUsbModeInputSchema = z
	.object({
		device: z.string().min(1),
		mode: usbCompositionModeSchema,
		confirm: z.literal(true),
	})
	.strict();
export type SetUsbModeInput = z.infer<typeof setUsbModeInputSchema>;

// Typed refusal reasons for setUsbMode. `provisioning_disabled` is the
// default-absent-`modem_provisioning` refusal (the T5.4 gate).
export const setUsbModeRefusalSchema = z.enum([
	'provisioning_disabled',
	'unsupported_transition',
	'streaming_active',
	'unavailable_in_emulated_mode',
	'error',
]);
export type SetUsbModeRefusal = z.infer<typeof setUsbModeRefusalSchema>;

export const setUsbModeOutputSchema = z.object({
	success: z.boolean(),
	error: setUsbModeRefusalSchema.optional(),
});
export type SetUsbModeOutput = z.infer<typeof setUsbModeOutputSchema>;
