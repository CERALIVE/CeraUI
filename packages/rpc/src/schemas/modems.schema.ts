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

// Available network schema
export const availableNetworkSchema = z.object({
	name: z.string(),
	availability: z.enum(['available', 'unavailable']),
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
