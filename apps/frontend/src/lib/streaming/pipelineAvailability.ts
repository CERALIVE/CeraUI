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
 * i18n key for the disabled-reason tooltip shown on an rtmp/srt pipeline whose
 * gateway IS running but has no reachable LAN/hotspot address to advertise (the
 * `service_active: true, url: null, unavailable_reason: "no_lan_or_hotspot_address"`
 * state — e.g. modem-only connectivity, where a WWAN IP is never published).
 *
 * This is DISTINCT from {@link PIPELINE_GATEWAY_INACTIVE}: the gateway is up, so
 * the fix is "join a LAN or enable the device hotspot", not "start the service".
 * Keeping the two reasons separate lets every surface show the RIGHT copy for the
 * RIGHT problem. The English text lives in `packages/i18n/src/en/index.ts` under
 * `live.education.reason.gatewayNoAddress`.
 */
export const PIPELINE_GATEWAY_NO_ADDRESS =
	"live.education.reason.gatewayNoAddress" as const;

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
 * - An rtmp/srt pipeline has THREE outcomes:
 *   1. `service_active === true` AND a non-null `url` ⇒ AVAILABLE (a reachable
 *      LAN/hotspot publish address exists).
 *   2. `service_active === true` but `url === null` (the addressless
 *      `no_lan_or_hotspot_address` state — gateway up, no reachable LAN/hotspot
 *      address, e.g. modem-only) ⇒ blocked with {@link PIPELINE_GATEWAY_NO_ADDRESS}
 *      (a DISTINCT reason: the fix is "join a LAN / enable the hotspot", not
 *      "start the service").
 *   3. gateway inactive, the protocol slot `null` (board caps exclude it), or the
 *      whole `network_ingest` surface absent/`null` (an older backend that never
 *      emits it, or the status snapshot has not arrived yet) ⇒ blocked with
 *      {@link PIPELINE_GATEWAY_INACTIVE} — fail-safe: no proof the gateway is up ⇒
 *      do not offer a start that would fail.
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
	if (status?.service_active === true) {
		// Gateway running: available only when a reachable publish address exists.
		// A `null` url is the addressless state (modem-only) — a DISTINCT reason.
		if (status.url === null) {
			return { available: false, reason: PIPELINE_GATEWAY_NO_ADDRESS };
		}
		return AVAILABLE;
	}
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
