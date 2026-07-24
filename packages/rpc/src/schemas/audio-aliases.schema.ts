/**
 * Operator-assigned audio-device display names (config-only, presentation-only).
 *
 * This is a LEAF schema module: it imports nothing but `zod`, so both
 * `streaming.schema.ts` (which folds `audioDeviceAliasesSchema` into
 * `configMessageSchema` for the frontend echo) and the backend runtime config
 * schema can import it without a circular dependency. Keep it dependency-free.
 *
 * The map is keyed on a device's STABLE identity — the engine's `stable_id` when
 * it publishes one, else `card:<alsaCardId>`. It is NEVER keyed on the USB bus
 * path, which changes on every replug/reboot. Renaming a device changes only the
 * label shown in the UI; the persisted `config.asrc` wire value and the engine's
 * ALSA device path are untouched.
 */
import { z } from 'zod';

/** Longest accepted custom name — a label, not a description. */
export const AUDIO_DEVICE_ALIAS_MAX_LENGTH = 64;

export const audioDeviceAliasSchema = z.string().trim().max(AUDIO_DEVICE_ALIAS_MAX_LENGTH);

/**
 * The persisted `audio_device_aliases` config value: stable device key → custom
 * label. The OUTER config key is `.optional()` at each consumer, so a legacy
 * config with no aliases at all still parses.
 */
export const audioDeviceAliasesSchema = z.record(z.string(), audioDeviceAliasSchema);
export type AudioDeviceAliases = z.infer<typeof audioDeviceAliasesSchema>;

/**
 * Input for `streaming.setAudioDeviceAlias`. An empty/whitespace-only `label`
 * CLEARS the alias — that is the operator's "reset to the hardware name" action,
 * so it is a valid input rather than a rejected one.
 */
export const setAudioDeviceAliasInputSchema = z.object({
	alias_key: z.string().min(1),
	label: audioDeviceAliasSchema,
});
export type SetAudioDeviceAliasInput = z.infer<typeof setAudioDeviceAliasInputSchema>;

/**
 * Output for `streaming.setAudioDeviceAlias` — the applied-state envelope every
 * setter returns. `applied.label` is the value actually persisted (trimmed, or
 * absent when the alias was cleared), so the frontend locks its input to server
 * truth rather than the raw keystrokes.
 */
export const setAudioDeviceAliasOutputSchema = z.object({
	success: z.boolean(),
	applied: z
		.object({
			alias_key: z.string(),
			label: z.string().optional(),
		})
		.optional(),
	error: z.string().optional(),
});
export type SetAudioDeviceAliasOutput = z.infer<typeof setAudioDeviceAliasOutputSchema>;
