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

// `not_selected_device` is CeraUI's own reason, never emitted by the engine: the
// backend gate raises it for a level belonging to a different ALSA card than the
// operator picked, while that pick IS present. `no_device` there claimed the
// device was gone when it was plugged in and delivering.
//
// `embedded_audio` is CeraUI's own too, and it names a genuinely different gap: a
// network-ingest source's audio is muxed into the INCOMING stream, so the source
// owns no ALSA card the idle sidecar could meter. It is not `no_device` (nothing
// is missing) and not `mode_none` (the operator asked for audio) — it is "this
// source's audio arrives with its stream, and no stream is arriving yet".
export const AUDIO_LEVEL_UNAVAILABLE_REASONS = [
	'device_busy',
	'no_device',
	'not_selected_device',
	'mode_none',
	'handoff',
	'embedded_audio',
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
