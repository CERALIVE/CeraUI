/**
 * Audio-level broadcast message schema.
 *
 * Mirrors the cerastream `audio-level` event topic (`@ceralive/cerastream`
 * `audioLevelEventSchema`, ADR-0007) as it is re-broadcast over the MAIN
 * authenticated backend WS — NOT the preview socket. The envelope `type`/`seq`
 * are stripped by the broadcast layer, so this schema carries only the payload.
 *
 * Two mutually-exclusive shapes: a real per-channel level (`rms_db`/`peak_db`),
 * or an `unavailable: true` marker with a `reason`. The engine NEVER fabricates
 * a silence level for a missing device or a degenerate `audio.mode` — a gap is
 * always the explicit `unavailable` variant.
 */
import { z } from 'zod';

export const AUDIO_LEVEL_OWNERS = ['sidecar', 'streaming'] as const;
export const audioLevelOwnerSchema = z.enum(AUDIO_LEVEL_OWNERS);
export type AudioLevelOwner = z.infer<typeof audioLevelOwnerSchema>;

export const AUDIO_LEVEL_UNAVAILABLE_REASONS = [
	'device_busy',
	'no_device',
	'mode_none',
	'handoff',
] as const;
export const audioLevelUnavailableReasonSchema = z.enum(AUDIO_LEVEL_UNAVAILABLE_REASONS);
export type AudioLevelUnavailableReason = z.infer<typeof audioLevelUnavailableReasonSchema>;

export const audioLevelMessageSchema = z.object({
	source: z
		.object({
			// Reboot-stable device id (cerastream Todo 20 `stable_id`).
			identity: z.string().optional(),
			owner: audioLevelOwnerSchema,
		})
		.optional(),
	channels: z.number().int().nonnegative().optional(),
	// dBFS, range (-inf, 0]; digital silence serialises as the `floor_db` sentinel.
	rms_db: z.array(z.number()).optional(),
	peak_db: z.array(z.number()).optional(),
	floor_db: z.number().optional(),
	// The gap marker — present (and only present) when there is no real level.
	unavailable: z.literal(true).optional(),
	reason: audioLevelUnavailableReasonSchema.optional(),
});
export type AudioLevelMessage = z.infer<typeof audioLevelMessageSchema>;
