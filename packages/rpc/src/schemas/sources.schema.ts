/**
 * StreamSource schema — the device-first source model (Wave 1, Todo 1).
 *
 * A StreamSource is the SINGLE operator-facing "what am I streaming" unit. It is
 * the contract foundation every later todo (unified `sources` broadcast, the Live
 * source list, config.source persistence) builds on. Each source is exactly one of
 * four ORIGINS, discriminated on the `origin` field:
 *
 *   • capture  — a CONCRETE engine capture device (a real camera / HDMI / USB
 *                input enumerated by the engine's list-devices). `id` = the engine
 *                input_id. Carries `kind` (the deviceKind that bridges the device
 *                to a pipeline id), `displayName` (the REAL hardware name, shown
 *                verbatim — this is what kills the USB-as-HDMI mislabel), and
 *                `devicePath`.
 *   • coarse   — a capability source with NO concrete device behind it yet: a
 *                legacy engine that doesn't enumerate devices, or a capability the
 *                engine advertises before the device is enumerated. `id` = the
 *                pipelineId. Carries `labelKey`.
 *   • virtual  — the test pattern (exactly one row). Carries `labelKey`.
 *   • network  — a LAN RTMP/SRT ingest source. Carries `labelKey`,
 *                `requiresGateway`, and the publish `url` (null until the gateway
 *                is up).
 *
 * `kind` lives ONLY on the capture variant — non-capture origins have no device
 * kind, and pipeline ids are NOT `deviceKindSchema` members (Momus-r2 defect 1).
 *
 * `labelKey` is ALWAYS an i18n dot-path key from the EXISTING `settings.sources.*`
 * key family (the same keys `PipelineHelper.getSourceLabel` already resolves) —
 * NEVER an English literal. `VIDEO_SOURCE_LABELS` stays only as the frontend
 * helper's last-resort fallback for an id with no key (oracle-r2 defect 4).
 */
import { z } from 'zod';
import {
	deviceKindSchema,
	deviceModeSchema,
	framerateSchema,
	hardwareTypeSchema,
	pipelineAudioKindSchema,
	requiresGatewaySchema,
	resolutionSchema,
} from './streaming.schema';

/** The four StreamSource origins (the discriminated-union discriminator). */
export const sourceOriginSchema = z.enum(['capture', 'coarse', 'virtual', 'network']);
export type SourceOrigin = z.infer<typeof sourceOriginSchema>;

/**
 * Fields common to EVERY origin. `kind` is deliberately NOT here — it exists only
 * on the capture variant. `modes` is `[]` for coarse / virtual / network sources
 * and for a capture device whose modes the engine has not (yet) enumerated.
 */
export const streamSourceBase = z.object({
	id: z.string(),
	pipelineId: z.string(),
	modes: z.array(deviceModeSchema),
	supportsAudio: z.boolean(),
	supportsResolutionOverride: z.boolean(),
	supportsFramerateOverride: z.boolean(),
	defaultResolution: resolutionSchema.optional(),
	defaultFramerate: framerateSchema.optional(),
	// Audio provenance (reuses the pipeline registry field). `selectable` = the
	// operator picks an ALSA/device source; `embedded` = audio muxed into an
	// rtmp/srt publish; `none` = the source carries no audio.
	audioKind: pipelineAudioKindSchema,
	available: z.boolean(),
	// i18n dot-path key naming WHY the source is unavailable (e.g.
	// 'live.education.reason.gatewayInactive') — NEVER a raw English string.
	unavailableReason: z.string().optional(),
	// Set when a capture device was unplugged mid-session (unavailable grace).
	lost: z.boolean().optional(),
});
export type StreamSourceBase = z.infer<typeof streamSourceBase>;

/** capture — a concrete engine device (id = input_id). `kind` is REQUIRED here. */
export const captureSourceSchema = streamSourceBase.extend({
	origin: z.literal('capture'),
	kind: deviceKindSchema,
	displayName: z.string(),
	devicePath: z.string(),
	// Reboot-stable hardware identity (cerastream `stable_id`). Lets routing
	// self-heal a persisted selection whose node id went stale after a replug.
	stableId: z.string().optional(),
});
export type CaptureStreamSource = z.infer<typeof captureSourceSchema>;

/** coarse — a capability source with no concrete device (id = pipelineId). */
export const coarseSourceSchema = streamSourceBase.extend({
	origin: z.literal('coarse'),
	labelKey: z.string(),
});
export type CoarseStreamSource = z.infer<typeof coarseSourceSchema>;

/** virtual — the test pattern. */
export const virtualSourceSchema = streamSourceBase.extend({
	origin: z.literal('virtual'),
	labelKey: z.string(),
});
export type VirtualStreamSource = z.infer<typeof virtualSourceSchema>;

/** network — a LAN rtmp/srt ingest source; `url` is null until the gateway is up. */
export const networkSourceSchema = streamSourceBase.extend({
	origin: z.literal('network'),
	labelKey: z.string(),
	requiresGateway: requiresGatewaySchema,
	url: z.string().nullable(),
});
export type NetworkStreamSource = z.infer<typeof networkSourceSchema>;

/** The device-first StreamSource discriminated union (keyed on `origin`). */
export const streamSourceSchema = z.discriminatedUnion('origin', [
	captureSourceSchema,
	coarseSourceSchema,
	virtualSourceSchema,
	networkSourceSchema,
]);
export type StreamSource = z.infer<typeof streamSourceSchema>;

/** The `sources` broadcast payload — hardware + the full StreamSource list. */
export const sourcesMessageSchema = z.object({
	hardware: hardwareTypeSchema,
	sources: z.array(streamSourceSchema),
});
export type SourcesMessage = z.infer<typeof sourcesMessageSchema>;
