/**
 * Go-Live readiness derivation — SINGLE SOURCE OF TRUTH (Task 9).
 *
 * Folds the four independent preconditions a stream start depends on into ONE
 * readable, testable verdict so every surface (the GoLiveCard in Task 10, the
 * bitrate one-owner in Task 12) makes the SAME decision:
 *
 *   • source      — `config.source` resolves to an AVAILABLE sources entry. A
 *                   lost device or an inactive rtmp/srt gateway blocks it.
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
	SourcesMessage,
} from "@ceraui/rpc/schemas";

import { capabilityTier } from "$lib/components/streaming/capability-tier";

import type { PipelineAvailability } from "./pipelineAvailability";

/** How the operator resolves a blocked/warned gate. `none` = nothing to do (wait). */
export type GateFix = "openSource" | "goNetwork" | "openServer" | "none";

/** A gate's severity. `ok` clears it; `warn` is advisory; `blocked` stops the start. */
export type GateStatus = "ok" | "warn" | "blocked";

/**
 * The resolved state of a single readiness gate. `reasonKey` is an i18n dot-path
 * key (never rendered text) the caller passes to `LL`; `fix` names the affordance
 * that resolves it. Both are absent on an `ok` gate.
 */
export interface GateState {
	readonly state: GateStatus;
	readonly reasonKey?: string;
	readonly fix?: GateFix;
}

/** The four gates, in operator-fix priority order. */
export type GoLiveGateKey = "source" | "network" | "destination" | "engine";

export interface GoLiveGates {
	readonly source: GateState;
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
	 */
	readonly gatewayStatus: PipelineAvailability;
}

/**
 * i18n reason keys — every one points at an EXISTING leaf so the caller can
 * render it without adding a string. Defined once, imported nowhere else.
 */
/** No source chosen / a stale-unresolvable id — the legacy `cannotStartNoPipeline` block. */
export const READINESS_SOURCE_REASON =
	"live.cannotStartNoPipeline" as const;
/** No enabled interface with an IP, or the control channel is down. */
export const READINESS_NETWORK_REASON = "network.view.noLinks" as const;
/** No usable server target — the legacy `cannotStartNoServer` block. */
export const READINESS_DESTINATION_REASON =
	"live.cannotStartNoServer" as const;
/** Engine offline / control channel down — the `engineUnavailable` calm-blocked tone. */
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
	"network",
	"destination",
	"engine",
] as const;

const OK: GateState = { state: "ok" };

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
	config: ConfigMessage | undefined,
	sources: SourcesMessage | undefined,
	gatewayStatus: PipelineAvailability,
): GateState {
	const sourceId = config?.source;
	if (!sourceId) return blocked(READINESS_SOURCE_REASON, "openSource");

	const entry = sources?.sources.find((source) => source.id === sourceId);
	if (!entry) return blocked(READINESS_SOURCE_REASON, "openSource");

	if (entry.lost === true) {
		return blocked(
			entry.unavailableReason ?? READINESS_SOURCE_REASON,
			"openSource",
		);
	}

	// The gateway verdict is CONSUMED from pipelineAvailability so the
	// requires_gateway rule lives in exactly one module.
	if (!gatewayStatus.available) {
		return blocked(gatewayStatus.reason, "openSource");
	}

	if (entry.available === false) {
		return blocked(
			entry.unavailableReason ?? READINESS_SOURCE_REASON,
			"openSource",
		);
	}

	return OK;
}

/**
 * Network gate — at least one enabled interface that has an IP. Mirrors
 * LiveView's `hasNetwork` exactly. A down control channel (`isConnected === false`)
 * also blocks it: the netif snapshot cannot be trusted and no start can be
 * dispatched while the socket is dead.
 */
function deriveNetworkGate(
	netif: NetifMessage | undefined,
	isConnected: boolean,
): GateState {
	if (!isConnected) return blocked(READINESS_NETWORK_REASON, "goNetwork");

	const hasNetwork = Object.values(netif ?? {}).some(
		(entry) => Boolean(entry?.enabled) && Boolean(entry?.ip),
	);
	return hasNetwork ? OK : blocked(READINESS_NETWORK_REASON, "goNetwork");
}

/**
 * Destination gate — a usable server target. Mirrors the plan's `hasServer`
 * (relay_server | selected_ingest_endpoint | srtla_addr), a superset of
 * LiveView's `serverTarget` that also honours a selected managed ingest slot.
 */
function deriveDestinationGate(config: ConfigMessage | undefined): GateState {
	const hasServer = Boolean(
		config?.relay_server ||
			config?.selected_ingest_endpoint ||
			config?.srtla_addr,
	);
	return hasServer ? OK : blocked(READINESS_DESTINATION_REASON, "openServer");
}

/**
 * Engine gate — the capability tier the engine advertises, mapped to the same
 * calm treatment the `CapabilityTierBanner` renders:
 *   • control channel down / engineUnavailable → blocked (offered set untrusted).
 *   • engineStarting → warn (booting; expected, not a failure).
 *   • schemaVersionMismatch → warn (advisory; options approximate).
 *   • normal → ok.
 * The engine has no operator fix (`none`) — you wait for it to reconnect.
 */
function deriveEngineGate(
	caps: CapabilitiesMessage | undefined,
	isConnected: boolean,
): GateState {
	if (!isConnected) {
		return blocked(READINESS_ENGINE_UNAVAILABLE_REASON, "none");
	}

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
 * blocked gate in {@link GATE_FIX_ORDER} (source → network → destination →
 * engine), or absent when nothing blocks.
 */
export function deriveGoLiveReadiness(
	input: GoLiveReadinessInput,
): GoLiveReadiness {
	const gates: GoLiveGates = {
		source: deriveSourceGate(input.config, input.sources, input.gatewayStatus),
		network: deriveNetworkGate(input.netif, input.isConnected),
		destination: deriveDestinationGate(input.config),
		engine: deriveEngineGate(input.caps, input.isConnected),
	};

	const primaryFixGate = GATE_FIX_ORDER.find(
		(key) => gates[key].state === "blocked",
	);
	const blocking = primaryFixGate !== undefined;

	return primaryFixGate !== undefined
		? { gates, blocking, primaryFixGate }
		: { gates, blocking };
}
