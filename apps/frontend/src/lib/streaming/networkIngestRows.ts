/**
 * Network-ingest source rows — SHARED derivation (Task 12).
 *
 * Two Live-destination surfaces render the rtmp/srt LAN ingest gateways as
 * first-class SOURCES: the detailed `NetworkIngestSection.svelte` card (the
 * QR/instructions home) and the `SourceSection.svelte` Input Sources list. Both
 * MUST read the SAME truth — the same `status.network_ingest` state, the same
 * gateway-availability verdict, and the same embedded-audio flag — so this module
 * is the single structural derivation both consume. Presentation (i18n copy,
 * markup) stays per-component; the LOGIC lives here exactly once.
 *
 * The gateway-availability decision is ALWAYS routed through
 * {@link pipelineAvailability} — never re-derived inline as `!service_active` /
 * `url === null`. That is the repo anti-pattern rule (root AGENTS.md → "Don't
 * re-derive the gateway-inactive disabled-with-reason rule inline").
 *
 * Pure + rune-free: unit-testable without mounting Svelte.
 */
import type {
	CapabilitiesMessage,
	NetworkIngest,
	Pipelines,
	RequiresGateway,
} from "@ceraui/rpc/schemas";

import {
	PIPELINE_GATEWAY_NO_ADDRESS,
	pipelineAvailability,
} from "./pipelineAvailability";

/** Protocols in display order; each renders only when its status entry is non-null. */
export const NETWORK_INGEST_PROTOCOL_ORDER: readonly RequiresGateway[] = [
	"rtmp",
	"srt",
];

/**
 * Resolve the pipeline id that publishes via `protocol`: the registry entry whose
 * `requires_gateway === protocol` (the pipeline id equals the source id by
 * contract, so fall back to the protocol key when the registry hasn't loaded).
 */
export function pipelineIdForProtocol(
	protocol: RequiresGateway,
	pipelines: Pipelines | undefined,
): string {
	if (pipelines) {
		for (const [id, pipeline] of Object.entries(pipelines)) {
			if (pipeline.requires_gateway === protocol) return id;
		}
	}
	return protocol;
}

/**
 * Whether the engine's capability snapshot advertises EMBEDDED audio for this
 * network-ingest source (`sources[].supports_audio`). rtmp/srt publishes carry
 * their own muxed audio, so a truthful engine reports `supports_audio: true` for
 * them. Matched by pipeline id first, then the protocol key (the two are equal by
 * contract; the fallback makes the lookup robust before the registry loads).
 * Absent caps ⇒ `false` (back-compat: an old engine that never advertises it).
 */
export function sourceSupportsEmbeddedAudio(
	capabilities: CapabilitiesMessage | undefined,
	pipelineId: string,
	protocol: RequiresGateway,
): boolean {
	const sources = capabilities?.sources;
	if (!sources) return false;
	const match = sources.find(
		(source) => source.id === pipelineId || source.id === protocol,
	);
	return match?.supports_audio ?? false;
}

/**
 * Structural row for one network-ingest protocol. Carries every DATA fact both
 * surfaces need; each surface maps this to its own i18n copy + markup so there is
 * no divergent derivation of the underlying truth.
 */
export interface NetworkIngestRow {
	readonly protocol: RequiresGateway;
	readonly pipelineId: string;
	/** Publish URL, or `null` in the addressless (`no_lan_or_hotspot_address`) state. */
	readonly url: string | null;
	readonly serviceActive: boolean;
	readonly selected: boolean;
	/** The gateway blocks selection (service down, board-excluded, or addressless). */
	readonly gatewayBlocked: boolean;
	/** Gateway up but no reachable LAN/hotspot address (a DISTINCT reason). */
	readonly addressless: boolean;
	/** Blocked for ANY reason (gateway blocked OR streaming). */
	readonly disabled: boolean;
	/** Disabled purely because a stream is live (gateway itself is fine). */
	readonly streamingLocked: boolean;
	/** Engine caps advertise embedded audio for this source (`supports_audio`). */
	readonly supportsAudio: boolean;
}

export interface DeriveNetworkIngestRowsParams {
	/** `status.network_ingest` — a `null`/absent protocol yields no row. */
	readonly networkIngest: NetworkIngest | null | undefined;
	/** `getPipelines()?.pipelines` — resolves the pipeline id per protocol. */
	readonly pipelines?: Pipelines | undefined;
	/** `getCapabilities()` — the source of the embedded-audio flag. */
	readonly capabilities?: CapabilitiesMessage | undefined;
	/** The currently-selected `config.pipeline` (drives the "selected" state). */
	readonly selectedPipeline?: string | undefined;
	/** Streaming locks pipeline switching (config.pipeline can't change live). */
	readonly isStreaming?: boolean;
}

/**
 * Derive the ordered network-ingest source rows. An absent (`null`) protocol slot
 * yields NO row (the board doesn't offer it); every offered protocol yields a row
 * even when blocked, so callers render it disabled-with-reason — never hidden.
 */
export function deriveNetworkIngestRows(
	params: DeriveNetworkIngestRowsParams,
): NetworkIngestRow[] {
	const {
		networkIngest,
		pipelines,
		capabilities,
		selectedPipeline,
		isStreaming = false,
	} = params;
	if (!networkIngest) return [];
	const rows: NetworkIngestRow[] = [];
	for (const protocol of NETWORK_INGEST_PROTOCOL_ORDER) {
		const entry = networkIngest[protocol];
		// Absent (null) ⇒ the board doesn't offer this source: yield nothing.
		if (!entry) continue;
		const pipelineId = pipelineIdForProtocol(protocol, pipelines);
		// Gateway-availability is the ONE shared rule: route it through
		// pipelineAvailability instead of re-deriving `!service_active`/`url` inline.
		// The row is definitionally a gateway source (rtmp/srt), so fall back to a
		// synthetic gateway pipeline if the registry hasn't loaded — fail-safe.
		const availability = pipelineAvailability(
			pipelines?.[pipelineId] ?? { requires_gateway: protocol },
			networkIngest,
		);
		const gatewayBlocked = !availability.available;
		const addressless =
			gatewayBlocked && availability.reason === PIPELINE_GATEWAY_NO_ADDRESS;
		rows.push({
			protocol,
			pipelineId,
			url: entry.url,
			serviceActive: entry.service_active,
			selected: selectedPipeline === pipelineId,
			gatewayBlocked,
			addressless,
			disabled: gatewayBlocked || isStreaming,
			streamingLocked: !gatewayBlocked && isStreaming,
			supportsAudio: sourceSupportsEmbeddedAudio(
				capabilities,
				pipelineId,
				protocol,
			),
		});
	}
	return rows;
}
