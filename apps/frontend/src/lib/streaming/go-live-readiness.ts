/**
 * Go-Live readiness derivation — SINGLE SOURCE OF TRUTH (Task 9).
 *
 * Folds the five independent setup checks into one
 * readable, testable verdict so every surface (the GoLiveCard in Task 10, the
 * bitrate one-owner in Task 12) makes the SAME decision:
 *
 *   • source      — `config.source` resolves to an AVAILABLE sources entry. A
 *                   lost device or an inactive rtmp/srt gateway blocks it.
 *   • audio       — the selected audio and codec are usable with the pipeline
 *                   and transport, based on the current evidence supplied.
 *   • network     — at least one enabled interface that has an IP (mirrors
 *                   LiveView's `hasNetwork`), and a live control channel.
 *   • destination — a usable server target (relay_server / selected ingest
 *                   endpoint / manual SRTLA address).
 *   • engine      — the capability tier the engine advertises (a starting or
 *                   unavailable engine per {@link capabilityTier} / the
 *                   `CapabilityTierBanner`).
 *
 * This is a CONSOLIDATION of the rules that already live in `LiveView.svelte`
 * (`hasNetwork` / `hasServer` / `canStartStream`), `startStreaming.ts`
 * (`hasServerTarget`), `pipelineAvailability.ts` (the gateway verdict), and
 * `capability-tier.ts` (the engine tier) — NOT a policy change. No start-blocking
 * rule is weakened; the module only reads them from one place.
 *
 * Pure + rune-free (no `$state`, no RPC, no Svelte): the gateway verdict is
 * ACCEPTED as input (`gatewayStatus`) rather than re-derived here, so the ONE
 * `pipelineAvailability` rule is never duplicated. Fully unit-testable without
 * mounting a component.
 */
import type {
	CapabilitiesMessage,
	ConfigMessage,
	NetifMessage,
	RelayMessage,
	SourcesMessage,
	StreamSource,
} from "@ceraui/rpc/schemas";

import { capabilityTier } from "$lib/components/streaming/capability-tier";

import type { PipelineAvailability } from "./pipelineAvailability";
import type { ManagedIngestAccount } from "./receiver-experience";
import { hasServerTarget } from "./startStreaming";

/** How the operator resolves a blocked/warned gate. `none` = nothing to do (wait). */
export type GateFix =
	| "openSource"
	| "chooseAnotherSource"
	| "goNetwork"
	| "openServer"
	| "openAudio"
	| "chooseAudioSource"
	| "none";

/** A gate's severity. `ok` clears it; `warn` is advisory; `blocked` stops the start. */
export type GateStatus = "ok" | "warn" | "blocked" | "unknown";

/**
 * The resolved state of a single readiness gate. `reasonKey` is an i18n dot-path
 * key (never rendered text) the caller passes to `LL`; `fix` names the affordance
 * that resolves it. Both are absent on an `ok` gate.
 */
export type GateState =
	| {
			readonly state: "ok" | "unknown";
			readonly reasonKey?: never;
			readonly fix?: never;
	  }
	| {
			readonly state: "warn" | "blocked";
			readonly reasonKey: string;
			readonly fix: GateFix;
	  };

/** The setup gates, in operator-fix priority order. */
export type GoLiveGateKey =
	| "source"
	| "audio"
	| "network"
	| "destination"
	| "engine";

export interface GoLiveGates {
	readonly source: GateState;
	readonly audio: GateState;
	readonly network: GateState;
	readonly destination: GateState;
	readonly engine: GateState;
}

/**
 * The full readiness verdict. `blocking` is TRUE iff any gate is `blocked` (a
 * `warn` never blocks). `primaryFixGate` names the first blocked gate to fix, in
 * {@link GATE_FIX_ORDER}; it is absent when nothing is blocked.
 */
export interface GoLiveReadiness {
	readonly gates: GoLiveGates;
	readonly blocking: boolean;
	readonly primaryFixGate?: GoLiveGateKey;
}

/** The inputs the derivation reads — plain data, no runes and no RPC. */
export interface GoLiveReadinessInput {
	/** The saved backend config snapshot (`getConfig()`). */
	readonly config: ConfigMessage | undefined;
	/** The live capabilities snapshot (`getCapabilities()`) — drives the engine tier. */
	readonly caps: CapabilitiesMessage | undefined;
	/** The unified sources list (`getSources()`) — the source gate resolves against it. */
	readonly sources: SourcesMessage | undefined;
	/** The network-interface map (`getNetif()`) — the network gate reads enabled+IP. */
	readonly netif: NetifMessage | undefined;
	/** Whether the frontend↔backend control channel is up (`getIsConnected()`). */
	readonly isConnected: boolean;
	/**
	 * The {@link pipelineAvailability} verdict for the CURRENTLY-SELECTED source's
	 * pipeline — accepted as input so the gateway rule is never re-derived here.
	 * For a source with no gateway dependency this is `{ available: true }`.
	 * `undefined` means the selected gateway has no current-link observation.
	 */
	readonly gatewayStatus: PipelineAvailability | undefined;
	readonly audio?: GateState;
	/**
	 * The relays CATALOG snapshot (`getRelays()`) — `undefined` WHILE LOADING (and
	 * in a federated bundle that never pulls it). When LOADED, the destination gate
	 * warns on a `relay_server` id the catalog no longer offers (C7). Omitted /
	 * `undefined` is fail-open — the presence-only behaviour, never a false warn.
	 */
	readonly relays?: RelayMessage | undefined;
	/**
	 * The platform-pushed managed ingest slots (`getManagedIngestAccounts()`) —
	 * `undefined` WHILE LOADING / in federation. When LOADED, the destination gate
	 * BLOCKS on a `selected_ingest_endpoint` the slot list no longer offers (a
	 * platform-revoked slot, C7). Omitted / `undefined` is fail-open.
	 */
	readonly managedSlots?: readonly ManagedIngestAccount[] | undefined;
}

/**
 * i18n reason keys — every one points at an EXISTING leaf so the caller can
 * render it without adding a string. Defined once, imported nowhere else.
 */
/** No source chosen / a stale-unresolvable id — the legacy `cannotStartNoPipeline` block. */
export const READINESS_SOURCE_REASON = "live.cannotStartNoPipeline" as const;
/** An observed interface map has no enabled interface with an IP. */
export const READINESS_NETWORK_REASON = "network.view.noLinks" as const;
/** No usable server target — the legacy `cannotStartNoServer` block. */
export const READINESS_DESTINATION_REASON = "live.cannotStartNoServer" as const;
/**
 * A selected managed ingest slot the LOADED slot list no longer offers — the
 * platform revoked it (C7). Blocks: the operator must pick a live slot.
 */
export const READINESS_DESTINATION_SLOT_REVOKED_REASON =
	"live.destinationSlotRevoked" as const;
/**
 * A managed `relay_server` id absent from the LOADED catalog — advisory only
 * (C7). WARNS, never blocks: the save may still resolve, matching the
 * informational traffic-light philosophy.
 */
export const READINESS_DESTINATION_SERVER_STALE_REASON =
	"live.destinationServerStale" as const;
/** Current capabilities say the engine is unavailable. */
export const READINESS_ENGINE_UNAVAILABLE_REASON =
	"live.education.tier.engineUnavailable.title" as const;
/** Engine still booting — advisory, never blocks. */
export const READINESS_ENGINE_STARTING_REASON =
	"live.education.tier.engineStarting.title" as const;
/** Engine speaks a different caps schema — advisory, never blocks. */
export const READINESS_ENGINE_SCHEMA_REASON =
	"live.education.tier.schemaVersionMismatch.title" as const;

/** The order `primaryFixGate` scans for the first blocked gate. */
export const GATE_FIX_ORDER: readonly GoLiveGateKey[] = [
	"source",
	"audio",
	"network",
	"destination",
	"engine",
] as const;

const OK: GateState = { state: "ok" };
const UNKNOWN: GateState = { state: "unknown" };

function blocked(reasonKey: string, fix: GateFix): GateState {
	return { state: "blocked", reasonKey, fix };
}

function warn(reasonKey: string, fix: GateFix): GateState {
	return { state: "warn", reasonKey, fix };
}

/**
 * Source gate — `config.source` must resolve to an AVAILABLE entry in the unified
 * sources list. Ordered so the most specific block wins:
 *   1. no source selected, or the id is absent from the offered set → unresolvable.
 *   2. a `lost` device (was present, now gone) → blocked with its own reason.
 *   3. the accepted `gatewayStatus` verdict says the rtmp/srt gateway is not
 *      usable → blocked with THAT reason (consumed, never re-derived — Task 19).
 *   4. any other unavailability the sources builder already resolved → blocked.
 */
function deriveSourceGate(
	observed: boolean,
	entry: StreamSource | undefined,
	gatewayStatus: PipelineAvailability | undefined,
	rejectedPipeline: boolean,
): GateState {
	if (!observed) return UNKNOWN;
	if (!entry) return blocked(READINESS_SOURCE_REASON, "openSource");

	if (entry.lost === true) {
		return blocked(
			entry.unavailableReason ?? READINESS_SOURCE_REASON,
			"openSource",
		);
	}

	// The gateway verdict is CONSUMED from pipelineAvailability so the
	// requires_gateway rule lives in exactly one module.
	if (gatewayStatus?.available === false) {
		return blocked(gatewayStatus.reason, "chooseAnotherSource");
	}

	if (entry.available === false) {
		return blocked(
			entry.unavailableReason ?? READINESS_SOURCE_REASON,
			"openSource",
		);
	}

	if (gatewayStatus === undefined) return UNKNOWN;
	return rejectedPipeline ? blocked(READINESS_SOURCE_REASON, "openSource") : OK;
}

/**
 * An observed network needs an enabled interface with an IP. Missing or
 * disconnected evidence cannot prove that the device has no links.
 */
function deriveNetworkGate(
	netif: NetifMessage | undefined,
	isConnected: boolean,
): GateState {
	if (!isConnected || !netif) return UNKNOWN;

	const hasNetwork = Object.values(netif).some(
		(entry) => Boolean(entry?.enabled) && Boolean(entry?.ip),
	);
	return hasNetwork ? OK : blocked(READINESS_NETWORK_REASON, "goNetwork");
}

/**
 * A selected managed ingest slot is not itself an assembled server target.
 *
 * Beyond presence it validates the target against the two catalogs the platform
 * pushes, each only ONCE they are LOADED (`!== undefined` — the T18 loaded-guard
 * rule); a still-loading / federated `undefined` catalog is fail-open (presence
 * only), never a false verdict:
 *   (a) a `selected_ingest_endpoint` the loaded slot list no longer offers was
 *       revoked platform-side → BLOCKED (openServer): it cannot resolve.
 *   (b) a `relay_server` id absent from the loaded catalog → WARN (openServer),
 *       NOT blocked: the save may still resolve and a warn matches the
 *       informational traffic-light philosophy.
 */
function deriveDestinationGate(
	config: ConfigMessage | undefined,
	relays: RelayMessage | undefined,
	managedSlots: readonly ManagedIngestAccount[] | undefined,
): GateState {
	if (!config) return UNKNOWN;
	const { selected_ingest_endpoint: selectedSlot, relay_server: relayServer } =
		config;

	if (
		selectedSlot &&
		managedSlots !== undefined &&
		!managedSlots.some((slot) => slot.endpointId === selectedSlot)
	) {
		return blocked(READINESS_DESTINATION_SLOT_REVOKED_REASON, "openServer");
	}

	if (!hasServerTarget(config))
		return blocked(READINESS_DESTINATION_REASON, "openServer");

	if (
		relayServer &&
		relays !== undefined &&
		relays.servers?.[relayServer] === undefined
	) {
		return warn(READINESS_DESTINATION_SERVER_STALE_REASON, "openServer");
	}

	return OK;
}

/**
 * Engine gate — the capability tier the engine advertises, mapped to the same
 * calm treatment the `CapabilityTierBanner` renders:
 *   • disconnected or no current capabilities → unknown.
 *   • observed engineUnavailable → blocked.
 *   • engineStarting → warn (booting; expected, not a failure).
 *   • schemaVersionMismatch → warn (advisory; options approximate).
 *   • normal → ok.
 * The engine has no operator fix (`none`) — you wait for it to reconnect.
 */
function deriveEngineGate(
	caps: CapabilitiesMessage | undefined,
	isConnected: boolean,
): GateState {
	if (!isConnected || !caps) return UNKNOWN;

	switch (capabilityTier(caps)) {
		case "engineUnavailable":
			return blocked(READINESS_ENGINE_UNAVAILABLE_REASON, "none");
		case "engineStarting":
			return warn(READINESS_ENGINE_STARTING_REASON, "none");
		case "schemaVersionMismatch":
			return warn(READINESS_ENGINE_SCHEMA_REASON, "none");
		case "normal":
			return OK;
	}
}

/**
 * Derive the full Go-Live readiness from a snapshot of plain inputs.
 *
 * `blocking` is provably `any gate blocked`; `primaryFixGate` is the first
 * blocked gate in {@link GATE_FIX_ORDER} (source → audio → network →
 * destination → engine), or absent when nothing blocks.
 */
export function deriveGoLiveReadiness(
	input: GoLiveReadinessInput,
): GoLiveReadiness {
	const gates = deriveGoLiveGates(input);

	const primaryFixGate = GATE_FIX_ORDER.find(
		(key) => gates[key].state === "blocked",
	);
	const blocking = primaryFixGate !== undefined;

	return primaryFixGate !== undefined
		? { gates, blocking, primaryFixGate }
		: { gates, blocking };
}

export function deriveGoLiveGates(
	input: GoLiveReadinessInput,
	source = {
		entry: input.sources?.sources.find(({ id }) => id === input.config?.source),
		rejectedPipeline: false,
	},
): GoLiveGates {
	return {
		source: deriveSourceGate(
			input.config !== undefined && input.sources !== undefined,
			source.entry,
			input.gatewayStatus,
			source.rejectedPipeline,
		),
		audio: input.audio ?? OK,
		network: deriveNetworkGate(input.netif, input.isConnected),
		destination: deriveDestinationGate(
			input.config,
			input.relays,
			input.managedSlots,
		),
		engine: deriveEngineGate(input.caps, input.isConnected),
	};
}
