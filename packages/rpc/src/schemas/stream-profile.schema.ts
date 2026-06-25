/**
 * Stream-tuning profile + receiver-capability Zod schemas (SRT receive profiles).
 *
 * The "Stream Tuning" card lets the operator pick an SRT receive PROFILE — a
 * named preset that expands to latency + FEC + recovery settings — and tune it.
 * Which controls are offered depends on the RECEIVER:
 *
 *   • A CeraLive receiver (CERALIVE/srt lineage) advertises the full profile set
 *     + FEC + a wide latency window → full controls.
 *   • Any other receiver collapses to the conservative BELABOX-compatible
 *     Classic baseline → latency-only, no FEC, no recovery-mode control.
 *
 * This is the SCHEMA layer only — pure Zod types + constants, no runtime logic.
 * The card's derivation (which controls are enabled, the disabled reasons, the
 * BELABOX-compatible banner) lives in the frontend `receiver-experience.ts`.
 *
 * The receiver taxonomy mirrors the cloud-side `ReceiverKind`
 * (`ceralive-platform apps/api/lib/receiver/capabilities.ts`) but is defined
 * here independently — CeraUI is a self-contained repo (Rule D: no cross-repo
 * import). It is aligned with the lowercase relay-provider taxonomy
 * (`config.remote_provider`), not the platform's capitalised `'CeraLive'`.
 */
import { z } from 'zod';

// =============================================================================
// SRT receive profiles (named presets)
// =============================================================================

/** The 5 v1 SRT receive profiles. Array order is the display order. */
export const STREAM_PROFILE_PRESETS = [
	'balanced',
	'low-latency',
	'resilient',
	'classic',
	'low-latency-fec',
] as const;
export const streamProfilePresetSchema = z.enum(STREAM_PROFILE_PRESETS);
export type StreamProfilePreset = (typeof STREAM_PROFILE_PRESETS)[number];

/**
 * A profile id is one of the named presets OR `'custom'` (the operator tuned a
 * setting away from every preset). `'custom'` is never RECEIVER-advertised — it
 * is a UI-only state derived from the live control values.
 */
export const STREAM_PROFILE_IDS = [...STREAM_PROFILE_PRESETS, 'custom'] as const;
export const streamProfileIdSchema = z.enum(STREAM_PROFILE_IDS);
export type StreamProfileId = (typeof STREAM_PROFILE_IDS)[number];

/** The BELABOX-compatible baseline every receiver can serve. */
export const DEFAULT_NON_CERALIVE_PROFILE = 'classic' satisfies StreamProfilePreset;

// =============================================================================
// Recovery mode (SRT loss-recovery behaviour)
// =============================================================================

/**
 * The SRT loss-recovery behaviour the receiver runs. Mirrors the cloud
 * descriptor's `freezeMode` taxonomy (ceralive-platform receiver capabilities):
 * `reorderfreeze` is the CERALIVE/srt opt-in decay freeze, `srtlapatches` the
 * legacy BELABOX-fork fusion, `stock` plain libsrt.
 */
export const STREAM_RECOVERY_MODES = ['reorderfreeze', 'srtlapatches', 'stock'] as const;
export const streamRecoveryModeSchema = z.enum(STREAM_RECOVERY_MODES);
export type StreamRecoveryMode = (typeof STREAM_RECOVERY_MODES)[number];

/**
 * The OPERATOR-facing recovery choice (Stream Tuning "Advanced" disclosure),
 * deliberately distinct from the internal {@link StreamRecoveryMode} freeze
 * taxonomy — "freeze" is never exposed as a user concept. `standard` routes to
 * the L1 (full-recovery) listener; `bandwidth-saver` routes to L2/Classic, which
 * trims recovery traffic on capped connections. Only a CeraLive receiver honours
 * it; other receivers are receiver-managed (control disabled-with-reason).
 */
export const STREAM_RECOVERY_PREFERENCES = ['standard', 'bandwidth-saver'] as const;
export const streamRecoveryPreferenceSchema = z.enum(STREAM_RECOVERY_PREFERENCES);
export type StreamRecoveryPreference = (typeof STREAM_RECOVERY_PREFERENCES)[number];

/** The recommended default recovery preference (routes to the L1 listener). */
export const DEFAULT_RECOVERY_PREFERENCE = 'standard' satisfies StreamRecoveryPreference;

// =============================================================================
// Receiver kind (Stream Tuning taxonomy)
// =============================================================================

/**
 * Receiver taxonomy for the Stream Tuning card. Only `ceralive` advertises the
 * full profile set; `belabox` / `custom` / `unknown` collapse to the Classic
 * baseline ("don't assume capabilities for an unproven receiver").
 */
export const RECEIVER_PROFILE_KINDS = ['ceralive', 'belabox', 'custom', 'unknown'] as const;
export const receiverProfileKindSchema = z.enum(RECEIVER_PROFILE_KINDS);
export type ReceiverProfileKind = (typeof RECEIVER_PROFILE_KINDS)[number];

// =============================================================================
// Latency window + receiver-capability descriptor
// =============================================================================

/** A receiver-advertised SRT latency window (ms). */
export const latencyRangeSchema = z.object({
	min: z.number().int().nonnegative(),
	default: z.number().int().nonnegative(),
	max: z.number().int().nonnegative(),
});
export type LatencyRange = z.infer<typeof latencyRangeSchema>;

/**
 * Per-receiver capability descriptor that drives the Stream Tuning card. A pure
 * projection of the engine capability snapshot + the resolved receiver kind; it
 * is NOT persisted. The card reads it to decide which controls are offered (and,
 * for the ones that are not, why).
 */
export const receiverCapsSchema = z.object({
	kind: receiverProfileKindSchema,
	supportsFec: z.boolean(),
	supportedProfiles: z.array(streamProfilePresetSchema),
	latencyRange: latencyRangeSchema,
	recoveryMode: streamRecoveryModeSchema,
});
export type ReceiverCaps = z.infer<typeof receiverCapsSchema>;

// =============================================================================
// Selected stream profile
// =============================================================================

/**
 * The operator's selected SRT receive profile. `presetId` names the active
 * preset (or `'custom'`); the three fields are the expanded settings. This
 * scaffold does not yet persist it — the per-control `setConfig` wiring lands
 * with the latency / FEC / recovery / preset tasks.
 */
export const streamProfileSchema = z.object({
	presetId: streamProfileIdSchema,
	latencyMs: z.number().int().nonnegative(),
	fecEnabled: z.boolean(),
	recoveryMode: streamRecoveryModeSchema,
});
export type StreamProfile = z.infer<typeof streamProfileSchema>;
