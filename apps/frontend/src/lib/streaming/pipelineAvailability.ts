/**
 * Network-ingest gateway availability — SINGLE SOURCE OF TRUTH (Task 19).
 *
 * A pipeline whose source is a LOCAL network-ingest server (rtmp/srt) can only
 * encode once its corresponding on-device gateway unit is running. Task 17 marks
 * exactly those pipeline entries with `requires_gateway: 'rtmp' | 'srt'`; Task 16
 * surfaces each gateway's live status on the `status` broadcast as
 * `network_ingest.{rtmp,srt}` (`service_active` + LAN publish `url`, or `null`
 * when the board's capability source kinds exclude that protocol).
 *
 * This module is the ONE place the "requires_gateway + inactive service ⇒ block"
 * rule lives, so every surface that shows or selects a pipeline (the EncoderDialog
 * source picker + preset grid, `StreamingConfigService.buildStreamingConfig`, and
 * anything the FE `ValidationAdapter` re-surfaces) makes the SAME decision. A
 * blocked pipeline is always DISABLED-WITH-REASON, never hidden.
 *
 * Pure + rune-free: unit-testable without mounting Svelte.
 */
import type { NetworkIngest } from "@ceraui/rpc/schemas";
import type { Pipeline, Pipelines } from "@ceraui/rpc/schemas";

/**
 * i18n key for the disabled-reason tooltip shown on an rtmp/srt pipeline whose
 * network-ingest gateway is not active. Consumers pass this to `LL`
 * (e.g. `LL.live.education.reason.gatewayInactive()`) — never render the key
 * string directly. It sits alongside the other disabled-option reason keys
 * ({@link OPTION_UNSUPPORTED_ON_PLATFORM} / {@link OPTION_FIXED_BY_SOURCE} in
 * ValidationAdapter). The English text lives in
 * `packages/i18n/src/en/index.ts` under `live.education.reason.gatewayInactive`.
 */
export const PIPELINE_GATEWAY_INACTIVE =
	"live.education.reason.gatewayInactive" as const;

/**
 * The availability verdict for a single pipeline. `available: true` ⇒ selectable
 * / startable; `available: false` carries the disabled-reason i18n key so the
 * caller renders it disabled-with-reason (a non-empty title/reason — never a bare
 * disable).
 */
export type PipelineAvailability =
	| { readonly available: true }
	| { readonly available: false; readonly reason: string };

const AVAILABLE: PipelineAvailability = { available: true };

/**
 * The ONE gateway-availability rule.
 *
 * - A pipeline with no `requires_gateway` (every direct-capture source: hdmi,
 *   uvc, test, …) is ALWAYS available — no gateway dependency.
 * - An rtmp/srt pipeline is available only when its gateway reports
 *   `service_active === true`. It is blocked (disabled-with-reason) when the
 *   gateway is inactive, when the protocol slot is `null` (board caps exclude it)
 *   or when the whole `network_ingest` surface is absent/`null` (an older backend
 *   that never emits it, or the status snapshot has not arrived yet) — fail-safe:
 *   no proof the gateway is up ⇒ do not offer a start that would fail.
 *
 * @param pipeline the pipeline entry (only its `requires_gateway` is read), or
 *   `undefined` when no source is selected — treated as available (nothing to gate).
 * @param networkIngest the `status.network_ingest` surface, or `null`/`undefined`.
 */
export function pipelineAvailability(
	pipeline: Pick<Pipeline, "requires_gateway"> | undefined,
	networkIngest: NetworkIngest | null | undefined,
): PipelineAvailability {
	const kind = pipeline?.requires_gateway;
	if (kind === undefined) return AVAILABLE;
	const status = networkIngest?.[kind];
	if (status?.service_active === true) return AVAILABLE;
	return { available: false, reason: PIPELINE_GATEWAY_INACTIVE };
}

/** Boolean convenience over {@link pipelineAvailability}. */
export function isPipelineAvailable(
	pipeline: Pick<Pipeline, "requires_gateway"> | undefined,
	networkIngest: NetworkIngest | null | undefined,
): boolean {
	return pipelineAvailability(pipeline, networkIngest).available;
}

/**
 * A pipeline entry tagged with its gateway-availability verdict. Mirrors the
 * {@link EncoderOption} / {@link PresetView} shape so a picker can iterate and
 * render each entry disabled-with-reason without re-deriving the rule.
 */
export interface PipelineView {
	readonly id: string;
	readonly pipeline: Pipeline;
	readonly availability: PipelineAvailability;
}

/**
 * Tag every pipeline in the broadcast map with its gateway-availability verdict,
 * in insertion order. An unavailable pipeline is RETURNED (not dropped) so the
 * source picker shows it disabled-with-reason, never hidden. Returns `[]` for an
 * absent map (still loading).
 */
export function pipelineViews(
	pipelines: Pipelines | undefined,
	networkIngest: NetworkIngest | null | undefined,
): PipelineView[] {
	if (!pipelines) return [];
	return Object.entries(pipelines).map(([id, pipeline]) => ({
		id,
		pipeline,
		availability: pipelineAvailability(pipeline, networkIngest),
	}));
}
