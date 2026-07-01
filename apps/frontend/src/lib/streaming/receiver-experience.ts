/**
 * receiver-experience — pure helpers for the receiver/server surface (Task 5).
 *
 * The Live destination's server dialog (`ServerDialog.svelte`) owns three
 * intertwined derivations that, until now, lived inline in the component:
 *
 *   1. destination — is the configured receiver a MANAGED relay server or a
 *      CUSTOM (manual) endpoint? (mirrors `ServerDialog.svelte:115`)
 *   2. receiver kind — the transport × destination cross product, derived via
 *      the `@ceraui/rpc` model (`deriveReceiverKind` + `serverSupportedProtocols`).
 *   3. the persisted `setConfig` payload — exactly which fields the save handler
 *      writes for each branch (mirrors `ServerDialog.svelte:263-295`).
 *
 * Everything here is PURE: no Svelte runes, no RPC calls, no Svelte imports. The
 * destination/kind truth table and the save-field selection are therefore
 * unit-testable in isolation, and the dialog can become presentational over it.
 *
 * The persisted-field semantics are unchanged from today's `handleSave`. The one
 * invariant this module hardens: the returned payload NEVER carries a key whose
 * value is `undefined` (the save handler filters those before locking fields, so
 * a `undefined`-valued key would slip past the dirty-registry lock loop).
 */

import {
	CLOUD_PROVIDERS,
	deriveReceiverKind,
	type LatencyRange,
	type ProviderSelection,
	RELAY_PROVIDER_KINDS,
	type ReceiverKind,
	type RelayProtocol,
	type RelayProviderKind,
	type RelayServer,
	relayProtocolSchema,
	SRTLA_MIN_LATENCY_MS,
	type StreamingConfigInput,
	serverSupportedProtocols,
} from "@ceraui/rpc/schemas";
import { parsePort } from "$lib/components/streaming/ValidationAdapter";

/**
 * Where the receiver lives: a MANAGED relay server (the catalog endpoint) or a
 * CUSTOM manual endpoint the operator typed in. This is the destination half of
 * the receiver-kind cross product.
 */
export type Destination = "managed" | "custom";

/** The persisted-config subset this module reads to derive the destination. */
export interface DestinationConfig {
	relay_server?: string | undefined;
}

/**
 * Derive the destination from the persisted config. A non-empty `relay_server`
 * means a managed relay endpoint; anything else (absent or empty) is a custom
 * manual endpoint. Mirrors the mode derivation at `ServerDialog.svelte:115`
 * (`config?.relay_server ? 'relay' : 'manual'`).
 */
export function deriveDestination(
	config: DestinationConfig | undefined,
): Destination {
	return config?.relay_server ? "managed" : "custom";
}

// =============================================================================
// Destination-as-provider model (receiver-coherence) — latency-first redesign
// =============================================================================

/**
 * The top-level receiver destination IS the provider choice: a managed cloud
 * (CeraLive Cloud / BELABOX Cloud) or a self-hosted custom receiver. Mirrors
 * `ProviderSelection` so the destination radiogroup and the cloud-remote config
 * share one taxonomy — picking a managed cloud here selects that provider.
 */
export type ReceiverDestinationChoice = ProviderSelection;

/**
 * The managed cloud destinations, DERIVED from `CLOUD_PROVIDERS` (filtered to the
 * managed clouds — `id !== 'custom'`), never a hardcoded `['ceralive','belabox']`
 * literal. A new managed cloud added to `CLOUD_PROVIDERS` appears automatically.
 */
export const MANAGED_DESTINATION_CHOICES: readonly ReceiverDestinationChoice[] =
	CLOUD_PROVIDERS.filter((provider) => provider.id !== "custom").map(
		(provider) => provider.id as ReceiverDestinationChoice,
	);

/** The default managed cloud when none is configured (first managed provider). */
const DEFAULT_MANAGED_CHOICE: ReceiverDestinationChoice =
	MANAGED_DESTINATION_CHOICES[0] ?? "ceralive";

/** The persisted-config subset {@link deriveDestinationChoice} reads. */
export interface DestinationChoiceConfig {
	relay_server?: string | undefined;
	srtla_addr?: string | undefined;
	remote_provider?: string | undefined;
	selected_ingest_endpoint?: string | undefined;
}

/** Is this destination choice a managed cloud (not the custom escape hatch)? */
export function isManagedChoice(choice: ReceiverDestinationChoice): boolean {
	return choice !== "custom";
}

/** Map a destination choice back to the binary managed/custom destination. */
export function choiceToDestination(
	choice: ReceiverDestinationChoice,
): Destination {
	return isManagedChoice(choice) ? "managed" : "custom";
}

/**
 * Resolve a configured `remote_provider` to a managed destination choice,
 * defaulting to the first managed cloud when absent / `custom` / unknown.
 */
function managedChoiceFromProvider(
	provider: string | undefined,
): ReceiverDestinationChoice {
	if (
		provider &&
		(MANAGED_DESTINATION_CHOICES as readonly string[]).includes(provider)
	) {
		return provider as ReceiverDestinationChoice;
	}
	return DEFAULT_MANAGED_CHOICE;
}

/**
 * Derive the destination-as-provider choice from the persisted config.
 *
 * Priority (R-2): a non-empty `selected_ingest_endpoint` is the platform-managed
 * (CeraLive) ingest-slot path and wins BEFORE the `srtla_addr`→custom fallback —
 * `buildManagedSlotConfig` persists `selected_ingest_endpoint` + `srtla_addr`
 * with NO `relay_server`, so without this guard a slot would misclassify as
 * Custom. Then a non-empty `relay_server` resolves to its managed provider (from
 * `remote_provider`); then a bare `srtla_addr` is a custom manual endpoint; else
 * the managed default.
 */
export function deriveDestinationChoice(
	config: DestinationChoiceConfig | undefined,
): ReceiverDestinationChoice {
	if (config?.selected_ingest_endpoint) {
		return managedChoiceFromProvider(config.remote_provider);
	}
	if (config?.relay_server) {
		return managedChoiceFromProvider(config.remote_provider);
	}
	if (config?.srtla_addr) return "custom";
	return managedChoiceFromProvider(config?.remote_provider);
}

/**
 * Brand label for a managed destination choice (e.g. "CeraLive Cloud"). Brand
 * product names are literal (i18n branding rule); sourced from `CLOUD_PROVIDERS`.
 */
export function managedCloudLabel(choice: ReceiverDestinationChoice): string {
	return (
		CLOUD_PROVIDERS.find((provider) => provider.id === choice)?.name ?? choice
	);
}

// =============================================================================
// Latency window (latency-only tuning)
// =============================================================================

/**
 * The single latency window every receiver gets when the engine has not
 * advertised its own range. Latency is the ARQ retransmit budget — the one real
 * knob. The floor is the SRTLA minimum (2 s), so the window is 2 s … 5 s (T2).
 */
export const DEFAULT_LATENCY_RANGE: LatencyRange = {
	min: SRTLA_MIN_LATENCY_MS,
	default: SRTLA_MIN_LATENCY_MS,
	max: 5000,
};

/** The capability subset {@link deriveLatencyRange} reads. */
export interface LatencyRangeSource {
	latency_range?: LatencyRange | undefined;
}

/**
 * The latency slider window: the engine-advertised `latency_range` when present,
 * else {@link DEFAULT_LATENCY_RANGE}. The ONLY latency-window source the
 * LatencySection consumes — no inline literals in the component. The advertised
 * min is floored to {@link SRTLA_MIN_LATENCY_MS} (T2) and the default clamped
 * into the resulting window; an advertised range whose max sits below the floor
 * is incoherent, so it is discarded for the default window.
 */
export function deriveLatencyRange(
	caps: LatencyRangeSource | undefined,
): LatencyRange {
	const advertised = caps?.latency_range;
	if (advertised === undefined) return DEFAULT_LATENCY_RANGE;
	const min = Math.max(advertised.min, SRTLA_MIN_LATENCY_MS);
	if (advertised.max < min) return DEFAULT_LATENCY_RANGE;
	const clampedDefault = Math.min(
		Math.max(advertised.default, min),
		advertised.max,
	);
	return { min, default: clampedDefault, max: advertised.max };
}

/** A relay-catalog grouping keyed by the server's provider origin (T9). */
export interface RelayProviderGroup {
	/** Provider id the servers are grouped under (the namespacing key). */
	providerId: string;
	/** Provider display name, when the servers carry tagged metadata. */
	providerName?: string;
	/** Provider taxonomy, or `"unknown"` for untagged (legacy) servers. */
	kind: RelayProviderKind | "unknown";
	servers: Array<[string, RelayServer]>;
}

/**
 * Group relay-catalog server entries by their tagged provider origin (T9), so
 * the server dialog can present multi-provider catalogs grouped by cloud.
 * Untagged (legacy) servers fall back to `fallbackProviderId` for DISPLAY only —
 * grouping never gates a server out. First-seen provider order is preserved.
 */
export function groupRelayServersByProvider(
	entries: ReadonlyArray<[string, RelayServer]>,
	fallbackProviderId: string,
): RelayProviderGroup[] {
	const groups = new Map<string, RelayProviderGroup>();
	for (const [id, server] of entries) {
		const providerId = server.provider?.id ?? fallbackProviderId;
		let group = groups.get(providerId);
		if (!group) {
			group = {
				providerId,
				providerName: server.provider?.name,
				kind: server.provider?.kind ?? "unknown",
				servers: [],
			};
			groups.set(providerId, group);
		}
		group.servers.push([id, server]);
	}
	return [...groups.values()];
}

/**
 * Match rule for "does this catalog server belong to `provider`?". Mirrors the
 * ServerDialog provider filter: a tagged server matches on its `provider.kind`,
 * and an UNTAGGED (legacy) server falls back to the active provider — so a
 * single-provider legacy catalog behaves exactly as before. Shared by the
 * per-provider D6 gate count and the managed-relay auto-selection.
 */
function relayServerBelongsToProvider(
	server: RelayServer,
	provider: string,
): boolean {
	return (server.provider?.kind ?? provider) === provider;
}

/**
 * Count the relay-catalog servers that belong to `provider` (T10). The
 * destination D6 gate uses this so "managed is available" reflects the SELECTED
 * provider's servers, not the whole multi-provider catalog: a provider with no
 * servers gates managed off even when another provider has some. Untagged legacy
 * servers belong to the active provider, so a single-provider catalog counts in
 * full (no behaviour change).
 */
export function countRelayServersForProvider(
	entries: ReadonlyArray<[string, RelayServer]>,
	provider: string,
): number {
	return entries.filter(([, server]) =>
		relayServerBelongsToProvider(server, provider),
	).length;
}

/**
 * Is a persisted `relay_server` stale for `provider`? (T18.) Stale = the saved id
 * is absent from the catalog, OR present but tagged to a DIFFERENT managed cloud
 * than `provider` — the state left behind when the operator switches provider in
 * `CloudRemoteDialog` without re-selecting a server. Empty/absent is never stale;
 * an untagged (legacy) server falls back to the active provider via
 * {@link relayServerBelongsToProvider}, so a single-provider legacy catalog never
 * reads as stale. The caller MUST guard on a loaded catalog (`relays !== undefined`)
 * — an empty `entries` while relays load is not staleness.
 */
export function isRelayServerStaleForProvider(
	relayServer: string | undefined,
	entries: ReadonlyArray<[string, RelayServer]>,
	provider: string,
): boolean {
	if (!relayServer) return false;
	const match = entries.find(([id]) => id === relayServer);
	if (!match) return true;
	return !relayServerBelongsToProvider(match[1], provider);
}

/**
 * Resolve a relay-provider id to its taxonomy. A predefined relay provider id
 * (`ceralive`, `belabox`, `custom`, + any future entry in `RELAY_PROVIDER_KINDS`)
 * maps to itself; anything else reads as `"unknown"`. Used to give untagged
 * (legacy) servers — grouped under the device's configured provider — a real
 * taxonomy so the managed-provider picker can decide if that provider is managed.
 */
function relayProviderKindForId(id: string): RelayProviderKind | "unknown" {
	return (RELAY_PROVIDER_KINDS as readonly string[]).includes(id)
		? (id as RelayProviderKind)
		: "unknown";
}

/**
 * One offerable managed cloud provider for the destination picker (T12). `custom`
 * is the self-hosted escape hatch and is NEVER a managed provider, so it never
 * appears here — the ServerDialog renders it through the always-available custom
 * destination path instead.
 */
export interface ManagedProviderOption {
	/** Provider id used as the picker value + the per-provider catalog filter key. */
	id: string;
	/** Provider display name when the catalog tagged it; else the consumer labels it. */
	name?: string;
	/** Provider taxonomy (always a managed kind — `custom`/`unknown` are excluded). */
	kind: RelayProviderKind;
	/** Number of catalog servers offered by this provider. */
	serverCount: number;
}

/**
 * Derive the MANAGED cloud providers a relay catalog actually offers (T12), in
 * first-seen order. This is the multi-cloud, select-not-fill source of truth for
 * the provider picker: the list is computed from the catalog the paired cloud(s)
 * pushed — never a hardcoded `['ceralive','belabox']` literal — so a new managed
 * cloud appears automatically once its servers arrive, and a cloud the device is
 * NOT paired to (no servers in the catalog) is simply absent.
 *
 * Rules:
 * - Servers are grouped by their tagged provider; untagged (legacy) servers fall
 *   to `fallbackProviderId` (the device's configured provider) for DISPLAY only.
 * - A group is offered only when its provider is a MANAGED cloud (its kind is in
 *   `RELAY_PROVIDER_KINDS` and is not `custom`) AND it has at least one server.
 *   The self-hosted `custom` provider and unknown ids are excluded — the custom
 *   receiver is reached through the destination radiogroup, never this picker.
 */
export function availableManagedProviders(
	entries: ReadonlyArray<[string, RelayServer]>,
	fallbackProviderId: string,
): ManagedProviderOption[] {
	const options: ManagedProviderOption[] = [];
	for (const group of groupRelayServersByProvider(
		entries,
		fallbackProviderId,
	)) {
		if (group.servers.length === 0) continue;
		const kind =
			group.kind === "unknown"
				? relayProviderKindForId(group.providerId)
				: group.kind;
		if (kind === "unknown" || kind === "custom") continue;
		options.push({
			id: group.providerId,
			name: group.providerName,
			kind,
			serverCount: group.servers.length,
		});
	}
	return options;
}

/**
 * Choose the ACTIVE managed provider for the picker (T12), the auto-select-if-one
 * rule for providers: an explicit operator pick (`draftProvider`) always wins;
 * otherwise the device's configured provider when it offers servers; otherwise
 * the first available provider (so a single offered provider — or a catalog that
 * only carries a non-configured cloud — auto-selects without a manual pick). Falls
 * back to `configProvider` when the catalog is empty so the value is never blank.
 */
export function resolveActiveManagedProvider(
	options: ReadonlyArray<ManagedProviderOption>,
	configProvider: string,
	draftProvider: string | undefined,
): string {
	if (draftProvider !== undefined) return draftProvider;
	if (options.some((option) => option.id === configProvider)) {
		return configProvider;
	}
	return options[0]?.id ?? configProvider;
}

/**
 * The outcome of auto-selecting a managed relay server for the active provider
 * (T10) — the relay-catalog mirror of {@link autoSelectIngestSlot}:
 * - `single`   — exactly one server for the provider → silent auto-select.
 * - `default`  — many servers, one carries the `default` flag → silent.
 * - `lastUsed` — many servers, none default, the persisted `relay_server` (the
 *   last-used id) still resolves → silent.
 * - `prompt`   — many servers, none default and no last-used: the operator must
 *   pick one (NEVER auto-selected silently).
 *
 * `undefined` (no servers for the provider) maps to the custom fallback, which
 * the destination radiogroup keeps reachable in every branch.
 */
export type ManagedRelaySelection =
	| {
			kind: "single" | "default" | "lastUsed";
			serverId: string;
			server: RelayServer;
	  }
	| { kind: "prompt"; servers: ReadonlyArray<[string, RelayServer]> }
	| undefined;

/**
 * Auto-select a managed relay server for `provider` from the relay catalog + the
 * persisted last-used `relay_server` id (T10). Rule (mirrors
 * {@link autoSelectIngestSlot}): exactly one server for the provider → that
 * server (silent); many → the `default` server, else the last-used server, else
 * prompt; none → `undefined` (custom fallback). Only the SELECTED provider's
 * servers are considered, so a single-server auto-pick is never made across
 * providers — a multi-provider catalog never silently jumps clouds.
 */
export function autoSelectManagedRelay(
	servers: ReadonlyArray<[string, RelayServer]>,
	selectedId: string | undefined,
	provider: string,
): ManagedRelaySelection {
	const own = servers.filter(([, server]) =>
		relayServerBelongsToProvider(server, provider),
	);
	if (own.length === 0) return undefined;
	const only = own[0];
	if (own.length === 1 && only) {
		return { kind: "single", serverId: only[0], server: only[1] };
	}
	const defaultServer = own.find(([, server]) => server.default);
	if (defaultServer) {
		return {
			kind: "default",
			serverId: defaultServer[0],
			server: defaultServer[1],
		};
	}
	const lastUsed = selectedId
		? own.find(([id]) => id === selectedId)
		: undefined;
	if (lastUsed) {
		return { kind: "lastUsed", serverId: lastUsed[0], server: lastUsed[1] };
	}
	return { kind: "prompt", servers: own };
}

/**
 * The relay transport to seed for a selected managed server (T10): the transport
 * to persist as `relay_protocol`, or `undefined` when no change is needed (no
 * advertised transports, or the current protocol is already advertised). Prefers
 * bonded SRTLA when offered, else the server's first advertised transport.
 *
 * This now fires for a SINGLE advertised transport too — previously only
 * multi-transport servers re-seeded the protocol, so a single-transport server
 * whose only transport differed from the draft left a stale `relay_protocol`
 * persisted. The per-server chooser stays the single user-facing writer; this
 * only computes a valid default.
 */
export function autoSelectManagedTransport(
	serverProtocols: readonly RelayProtocol[],
	currentProtocol: RelayProtocol,
): RelayProtocol | undefined {
	if (serverProtocols.length === 0) return undefined;
	if (serverProtocols.includes(currentProtocol)) return undefined;
	return serverProtocols.includes("srtla") ? "srtla" : serverProtocols[0];
}

export interface ResolveReceiverKindInput {
	/** Requested transport; `undefined` (legacy config) coerces to `srtla`. */
	protocol: RelayProtocol | undefined;
	/** Destination derived from the persisted config (see {@link deriveDestination}). */
	destination: Destination;
	/** The selected managed server, when one is in play (managed destination). */
	server?: RelayServer | undefined;
}

/**
 * Resolve the receiver kind from the requested protocol + destination, wrapping
 * the `@ceraui/rpc` receiver-kind model.
 *
 * For a MANAGED destination with a known server, the effective transport is
 * constrained to what that server actually advertises
 * ({@link serverSupportedProtocols}): the requested protocol wins when the
 * server supports it, otherwise we fall back to the server's primary transport.
 * For a CUSTOM destination the requested protocol is used as-is.
 *
 * Override-reload caveat (by design, NOT a bug): a relay override persists
 * `srtla_addr/port + relay_streamid_override` with NO `relay_server`, so on
 * reload `deriveDestination` returns `custom` → `hasRelayServer` is false →
 * this returns `srtla_custom` (never `srtla_relay`). See T1's `deriveReceiverKind`.
 */
export function resolveReceiverKind({
	protocol,
	destination,
	server,
}: ResolveReceiverKindInput): ReceiverKind {
	const hasRelayServer = destination === "managed";
	let effectiveProtocol = protocol;
	if (hasRelayServer && server) {
		const supported = serverSupportedProtocols(server);
		const requested = relayProtocolSchema.parse(protocol);
		effectiveProtocol = supported.includes(requested)
			? requested
			: (supported[0] ?? requested);
	}
	return deriveReceiverKind({ protocol: effectiveProtocol, hasRelayServer });
}

/**
 * i18n key per receiver kind for the badge label. The consumer resolves these
 * through the `$LL` proxy — never render the key string directly. The key names
 * are the stable contract (T2); the English copy lives under `live.server.kind.*`.
 */
const KIND_BADGE_LABEL_KEYS: Record<ReceiverKind, string> = {
	srtla_relay: "live.server.kind.srtlaRelay",
	srtla_custom: "live.server.kind.srtlaCustom",
	rist_relay: "live.server.kind.ristRelay",
	rist_custom: "live.server.kind.ristCustom",
	srt_custom: "live.server.kind.srtCustom",
};

/** Resolve the i18n badge-label key for a receiver kind. */
export function kindBadgeLabelKey(kind: ReceiverKind): string {
	return KIND_BADGE_LABEL_KEYS[kind];
}

/**
 * The bonded-links readiness state for the Live server surface (T13).
 *
 * SRTLA is the ONLY wired bonded path, so it is the only kind that may assert a
 * "bonded across N links" claim — and only while streaming, when the live link
 * count is actually known. RIST / plain-SRT never claim bonding (RIST egress is
 * resolver-only per the receiver model T3); they read as a fixed single link.
 *
 * - `bonded` — SRTLA, streaming, ≥2 active links → "Bonded across N links".
 * - `single` — SRTLA, streaming, exactly 1 active link → honest "Single link".
 * - `idle`   — SRTLA, telemetry absent (not streaming) → transport label only,
 *              NEVER a stale count.
 * - `fixed`  — non-SRTLA → single-link intended topology (no bonding claim).
 */
export type ServerReadiness =
	| { variant: "bonded"; count: number }
	| { variant: "single" }
	| { variant: "idle" }
	| { variant: "fixed" };

/**
 * Derive the bonded-links readiness for the Live server surface from the receiver
 * kind and the live active-link count.
 *
 * `linkCount` is `null` when the engine is not streaming (`getLinkTelemetry()`
 * returns `null`) — in that case an SRTLA receiver degrades to a label-only
 * `idle` state rather than asserting a stale count. A non-SRTLA kind is always
 * `fixed` (single-link topology) regardless of the count: bonding is never
 * claimed for a transport that cannot bond.
 */
export function deriveServerReadiness(
	kind: ReceiverKind,
	linkCount: number | null,
): ServerReadiness {
	const isSrtla = kind === "srtla_relay" || kind === "srtla_custom";
	if (!isSrtla) return { variant: "fixed" };
	if (linkCount === null || linkCount <= 0) return { variant: "idle" };
	if (linkCount === 1) return { variant: "single" };
	return { variant: "bonded", count: linkCount };
}

/**
 * The resolved draft values the save handler reads. All string fields are the
 * RAW operator inputs (trimmed by {@link buildServerSetConfig}); ports are RAW
 * strings parsed via the ValidationAdapter. `latency` is the already-resolved
 * value the caller persists (the dialog clamps it before calling).
 */
export interface ServerSetDraft {
	/** Resolved SRT latency to persist (caller-clamped). */
	latency: number;
	/** Requested transport; `undefined` (legacy) is coerced to `srtla`. */
	protocol: RelayProtocol | undefined;
	/** Manual endpoint address (custom destination). */
	addr: string;
	/** Manual endpoint port, RAW string (custom destination). */
	portStr: string;
	/** Manual SRT stream id (custom destination). */
	streamId: string;
	/** Managed relay stream-id override (always persisted, even ''). */
	relayStreamId: string;
	/** Selected managed relay server id. */
	relayServer: string;
	/** Selected managed relay account id (persisted only when non-empty). */
	relayAccount: string;
}

/** The derived branch selectors the save handler keys off. */
export interface ServerSetDerived {
	destination: Destination;
}

/** The managed-destination state {@link overrideClearsManagedBinding} reads. */
export interface ManagedBindingContext {
	destination: Destination;
	relayOverride: boolean;
	relayServer: string;
}

/**
 * True when saving would silently drop a managed relay-server binding (T18): a
 * managed destination, with the manual-endpoint override on, while a server is
 * still bound. {@link buildServerSetConfig}'s override branch persists
 * `srtla_addr/port` with NO `relay_server`, so the managed binding is replaced by
 * a manual endpoint — the dialog surfaces this before save instead of clearing it
 * silently.
 */
export function overrideClearsManagedBinding(
	ctx: ManagedBindingContext,
): boolean {
	return (
		ctx.destination === "managed" && ctx.relayOverride && ctx.relayServer !== ""
	);
}

/**
 * Drop every key whose value is `undefined`, so the persisted payload only
 * carries fields that will actually be sent. Mirrors the save handler's
 * `Object.entries(input).filter(([, v]) => v !== undefined)` before it locks
 * each field — a `undefined`-valued key would otherwise slip past that lock loop.
 */
function pruneUndefined(input: StreamingConfigInput): StreamingConfigInput {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (value !== undefined) out[key] = value;
	}
	return out as StreamingConfigInput;
}

/**
 * Build the exact `StreamingConfigInput` the server dialog persists. Two branches
 * (transport is always SRTLA; latency is the only tuning knob):
 *
 * - CUSTOM (manual): `relay_protocol, srtla_addr, srtla_port, srt_streamid, srt_latency`
 * - MANAGED (relay): `relay_protocol, relay_server, relay_account?, relay_streamid_override, srt_latency`
 *
 * Both branches set `selected_ingest_endpoint: ''` to clear any stale platform
 * ingest-slot identity (the slot path uses `buildManagedSlotConfig`), so the
 * destination always re-derives correctly after a non-slot save (round-3 mutual
 * exclusion). Invariants: `relay_protocol` is always present (legacy drafts
 * coerce to `srtla`); `relay_streamid_override` is always set in the managed
 * branch even when empty; `relay_account` persists only when non-empty; no
 * returned key ever has an `undefined` value (an unparsable port is pruned).
 */
export function buildServerSetConfig(
	draft: ServerSetDraft,
	derived: ServerSetDerived,
): StreamingConfigInput {
	const base: StreamingConfigInput = {
		srt_latency: draft.latency,
		relay_protocol: relayProtocolSchema.parse(draft.protocol),
		selected_ingest_endpoint: "",
	};

	if (derived.destination === "custom") {
		return pruneUndefined({
			...base,
			srtla_addr: draft.addr.trim(),
			srtla_port: parsePort(draft.portStr),
			srt_streamid: draft.streamId.trim(),
		});
	}

	return pruneUndefined({
		...base,
		relay_server: draft.relayServer,
		relay_account: draft.relayAccount ? draft.relayAccount : undefined,
		relay_streamid_override: draft.relayStreamId.trim(),
	});
}

/** The persisted-config subset the Live server summary reads (T11). */
export interface ServerSummaryConfig {
	srtla_addr?: string | undefined;
	srtla_port?: number | undefined;
	relay_server?: string | undefined;
	remote_provider?: string | undefined;
}

/** i18n resolvers the summary composes, keeping {@link buildServerSummary} `$LL`-free. */
export interface ServerSummaryLabels {
	notConfigured: string;
	kindLabel: (kind: ReceiverKind) => string;
	bondedAcross: (count: number) => string;
	singleLink: string;
	providerLabel: (provider: string | undefined) => string | undefined;
	/** Resolves the "feeds cloud OBS instance: <label>" line (T17); optional so existing call sites stay byte-identical. */
	feedsCloudObsInstance?: (label: string) => string;
}

const SUMMARY_SEPARATOR = " · ";

/**
 * Distil the saved receiver config into the destination/kind-aware Live server
 * summary (T11). Three shapes: none → `notConfigured`; managed →
 * `Provider · <kind badge> · <bonding clause>` (the bonding clause appended only
 * for the bonded SRTLA relay kind AND only when a live link count is observed,
 * so an idle/disconnected receiver never asserts a stale bonding fact); custom →
 * `addr:port · <kind badge>`. Pure — all copy arrives via {@link ServerSummaryLabels}.
 */
export function buildServerSummary(
	config: ServerSummaryConfig | undefined,
	kind: ReceiverKind | undefined,
	linkCount: number,
	labels: ServerSummaryLabels,
	activeSlot?: ManagedIngestAccount | undefined,
): string {
	const hasServer = Boolean(config?.srtla_addr || config?.relay_server);
	if (!hasServer || !kind) return labels.notConfigured;

	const base = buildConfiguredSummary(config, kind, linkCount, labels);

	const association = obsInstanceAssociation(activeSlot);
	if (association && labels.feedsCloudObsInstance) {
		return `${base}${SUMMARY_SEPARATOR}${labels.feedsCloudObsInstance(association.label)}`;
	}
	return base;
}

function buildConfiguredSummary(
	config: ServerSummaryConfig | undefined,
	kind: ReceiverKind,
	linkCount: number,
	labels: ServerSummaryLabels,
): string {
	if (deriveDestination(config) === "managed") {
		const parts: string[] = [];
		const provider = labels.providerLabel(config?.remote_provider);
		if (provider) parts.push(provider);
		parts.push(labels.kindLabel(kind));
		if (kind === "srtla_relay" && linkCount > 0) {
			parts.push(
				linkCount > 1 ? labels.bondedAcross(linkCount) : labels.singleLink,
			);
		}
		return parts.join(SUMMARY_SEPARATOR);
	}

	const addr = config?.srtla_addr ?? "";
	const target =
		addr && config?.srtla_port ? `${addr}:${config.srtla_port}` : addr;
	return target
		? `${target}${SUMMARY_SEPARATOR}${labels.kindLabel(kind)}`
		: labels.kindLabel(kind);
}

/**
 * A platform-pushed ingest slot mapped into the device's relay/receiver model
 * (T18). Mirrors the backend `ManagedIngestAccount` shape: identity is the stable
 * `endpointId` (never host+port), `key` is the slot's stream credential, and
 * `label` falls back to `endpointId` when the platform sends no `instanceLabel`.
 */
export interface ManagedIngestAccount {
	endpointId: string;
	host: string;
	port: number;
	protocol: string;
	key: string;
	label: string;
	region?: string;
	state?: string;
	default?: boolean;
	/** Cloud OBS instance the platform bound this slot to, or `null`/absent when unbound (T17). */
	obsInstanceId?: string | null;
	/** Human label of the bound cloud OBS instance, when the platform pushed one (T17). */
	instanceLabel?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function toManagedIngestAccount(
	row: unknown,
): ManagedIngestAccount | undefined {
	if (!isRecord(row)) return undefined;
	const endpointId = optionalString(row.endpointId);
	const host = optionalString(row.host);
	const protocol = optionalString(row.protocol);
	const key = optionalString(row.key) ?? optionalString(row.streamId);
	const port = typeof row.port === "number" ? row.port : undefined;
	if (
		endpointId === undefined ||
		host === undefined ||
		protocol === undefined ||
		key === undefined ||
		port === undefined
	) {
		return undefined;
	}
	const instanceLabel = optionalString(row.instanceLabel);
	const region = optionalString(row.region);
	const state = optionalString(row.state);
	return {
		endpointId,
		host,
		port,
		protocol,
		key,
		label: optionalString(row.label) ?? instanceLabel ?? endpointId,
		obsInstanceId:
			typeof row.obsInstanceId === "string" ? row.obsInstanceId : null,
		...(instanceLabel !== undefined ? { instanceLabel } : {}),
		...(region !== undefined ? { region } : {}),
		...(state !== undefined ? { state } : {}),
		...(typeof row.default === "boolean" ? { default: row.default } : {}),
	};
}

/**
 * Parse an inbound `ingest.slots` payload into managed accounts. Accepts a
 * `{ slots: [...] }` envelope or a bare array, tolerates BOTH the raw slot shape
 * (`streamId`/`instanceLabel`) and the mapped account shape (`key`/`label`), and
 * carries the OBS-instance metadata through. Malformed entries are dropped.
 */
export function parseIngestSlots(payload: unknown): ManagedIngestAccount[] {
	const rows = Array.isArray(payload)
		? payload
		: isRecord(payload) && Array.isArray(payload.slots)
			? payload.slots
			: [];
	const accounts: ManagedIngestAccount[] = [];
	for (const row of rows) {
		const account = toManagedIngestAccount(row);
		if (account) accounts.push(account);
	}
	return accounts;
}

/**
 * The cloud OBS instance a managed slot feeds, or `undefined` when unbound (T17).
 * Bound requires BOTH a non-null `obsInstanceId` AND a non-empty `instanceLabel`,
 * so an unbound slot yields `undefined` and the read-only line is simply absent
 * (never "undefined"). Read-only: the device observes, it never controls OBS.
 */
export function obsInstanceAssociation(
	account: ManagedIngestAccount | undefined,
): { label: string } | undefined {
	if (!account?.obsInstanceId) return undefined;
	const label = account.instanceLabel?.trim();
	if (!label) return undefined;
	return { label };
}

/**
 * The outcome of auto-selecting an ingest slot (T19):
 * - `managed` — a slot is chosen for the operator (silent: one eligible slot, or
 *   resolved by `default`/last-used among many). `reason` records which rule won.
 * - `prompt`  — multiple slots, none default and none last-used: the operator
 *   must pick one (NEVER auto-selected silently).
 * - `custom`  — no managed slots: fall through to the manual/custom endpoint.
 */
export type IngestSlotSelection =
	| {
			kind: "managed";
			account: ManagedIngestAccount;
			reason: "single" | "default" | "lastUsed";
	  }
	| { kind: "prompt"; accounts: readonly ManagedIngestAccount[] }
	| { kind: "custom" };

/**
 * Auto-select an ingest slot from the managed accounts + the persisted last-used
 * `selected_ingest_endpoint` (T19). Rule: exactly one slot → that slot (silent);
 * many → the `default` slot, else the last-used slot, else prompt; none → custom.
 * The manual/custom endpoint stays reachable in every branch — this only decides
 * the managed pre-selection, never disables the fallback.
 */
export function autoSelectIngestSlot(
	accounts: readonly ManagedIngestAccount[],
	selectedEndpointId: string | undefined,
): IngestSlotSelection {
	if (accounts.length === 0) return { kind: "custom" };
	if (accounts.length === 1) {
		const account = accounts[0];
		if (account) return { kind: "managed", account, reason: "single" };
	}
	const defaultSlot = accounts.find((account) => account.default);
	if (defaultSlot) {
		return { kind: "managed", account: defaultSlot, reason: "default" };
	}
	const lastUsed = selectedEndpointId
		? accounts.find((account) => account.endpointId === selectedEndpointId)
		: undefined;
	if (lastUsed)
		return { kind: "managed", account: lastUsed, reason: "lastUsed" };
	return { kind: "prompt", accounts };
}

/** Human label for a managed slot — the platform label, else its endpointId. */
export function managedSlotLabel(account: ManagedIngestAccount): string {
	return account.label || account.endpointId;
}

/**
 * The managed account a persisted `selected_ingest_endpoint` resolves to, or
 * `undefined` when none is selected or the id is no longer among the slots.
 */
export function findActiveSlot(
	accounts: readonly ManagedIngestAccount[],
	selectedEndpointId: string | undefined,
): ManagedIngestAccount | undefined {
	if (!selectedEndpointId) return undefined;
	return accounts.find((account) => account.endpointId === selectedEndpointId);
}

/**
 * Build the `streaming.setConfig` payload that persists a managed slot selection:
 * the slot's endpoint (host/port/protocol/stream-key) plus the stable
 * `selected_ingest_endpoint` identity. Pruned like {@link buildServerSetConfig}
 * so no key carries an `undefined` value (lock-loop safe).
 */
export function buildManagedSlotConfig(
	account: ManagedIngestAccount,
	latency: number,
): StreamingConfigInput {
	return pruneUndefined({
		srt_latency: latency,
		relay_protocol: relayProtocolSchema.catch("srtla").parse(account.protocol),
		srtla_addr: account.host,
		srtla_port: account.port,
		srt_streamid: account.key,
		selected_ingest_endpoint: account.endpointId,
	});
}
