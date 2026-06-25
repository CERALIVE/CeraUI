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
	DEFAULT_NON_CERALIVE_PROFILE,
	deriveReceiverKind,
	type LatencyRange,
	PRESET_CONFIGS,
	RELAY_PROVIDER_KINDS,
	type ReceiverCaps,
	type ReceiverKind,
	type ReceiverProfileKind,
	type RelayProtocol,
	type RelayProviderKind,
	type RelayServer,
	relayProtocolSchema,
	type StreamingConfigInput,
	type StreamProfileId,
	type StreamProfilePreset,
	type StreamRecoveryMode,
	type StreamRecoveryPreference,
	serverSupportedProtocols,
	streamProfilePresetSchema,
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
	/** Override endpoint address (managed + override). */
	overrideAddr: string;
	/** Override endpoint port, RAW string (managed + override). */
	overridePortStr: string;
	/** Managed/override relay stream-id override (always persisted, even ''). */
	relayStreamId: string;
	/** Selected managed relay server id. */
	relayServer: string;
	/** Selected managed relay account id (persisted only when non-empty). */
	relayAccount: string;
	/** FEC toggle (Task 18); persisted only when defined — undefined omits the key. */
	fecEnabled?: boolean;
	/** Recovery preference (Task 19); persisted only when defined. */
	recoveryMode?: StreamRecoveryPreference;
}

/** The derived branch selectors the save handler keys off. */
export interface ServerSetDerived {
	destination: Destination;
	/** True when a managed server is using a manual endpoint override. */
	relayOverride: boolean;
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
 * Build the exact `StreamingConfigInput` the server dialog persists, encapsulating
 * today's `handleSave` field selection (`ServerDialog.svelte:263-295`) with no
 * behaviour change. Three branches:
 *
 * - CUSTOM (manual): `relay_protocol, srtla_addr, srtla_port, srt_streamid, srt_latency`
 * - MANAGED + override: `relay_protocol, srtla_addr, srtla_port, relay_streamid_override, srt_latency`
 * - MANAGED (relay): `relay_protocol, relay_server, relay_account?, relay_streamid_override, srt_latency`
 *
 * Invariants:
 * - `relay_protocol` is ALWAYS present and never `undefined` — a legacy draft
 *   with no protocol coerces to `srtla` via `relayProtocolSchema`.
 * - `relay_streamid_override` is ALWAYS set in the override/managed branches,
 *   even when empty (`''`).
 * - `relay_account` is persisted only when non-empty (matches today's
 *   `if (relayAccount)` guard).
 * - No returned key ever has a `undefined` value (port parsing may yield
 *   `undefined`, which is pruned).
 */
export function buildServerSetConfig(
	draft: ServerSetDraft,
	derived: ServerSetDerived,
): StreamingConfigInput {
	const base: StreamingConfigInput = {
		srt_latency: draft.latency,
		relay_protocol: relayProtocolSchema.parse(draft.protocol),
		...(draft.fecEnabled !== undefined
			? { fec_enabled: draft.fecEnabled }
			: {}),
		...(draft.recoveryMode !== undefined
			? { recovery_mode: draft.recoveryMode }
			: {}),
	};

	if (derived.destination === "custom") {
		// Manual custom SRTLA target.
		return pruneUndefined({
			...base,
			srtla_addr: draft.addr.trim(),
			srtla_port: parsePort(draft.portStr),
			srt_streamid: draft.streamId.trim(),
		});
	}

	if (derived.relayOverride) {
		// Managed server with a manual endpoint override — persists like a custom
		// endpoint but carries the relay stream-id override (no relay_server).
		return pruneUndefined({
			...base,
			srtla_addr: draft.overrideAddr.trim(),
			srtla_port: parsePort(draft.overridePortStr),
			relay_streamid_override: draft.relayStreamId.trim(),
		});
	}

	// Managed relay server.
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

// =============================================================================
// Stream-tuning (SRT receive profiles) — Task 16
// =============================================================================

// The conservative SRT latency window every receiver can honour (ms). A
// non-CeraLive receiver is held to the BELABOX-compatible safe ceiling
// regardless of any caps it forges (mirrors the cloud descriptor's
// SAFE_LATENCY_MAX_MS = 2000).
const SAFE_LATENCY_RANGE: LatencyRange = { min: 100, default: 1500, max: 2000 };

// The latency window a CeraLive receiver gets when the engine has not yet
// advertised its own range (mirrors the cloud descriptor's L1_LATENCY_MAX_MS).
const CERALIVE_FALLBACK_LATENCY_RANGE: LatencyRange = {
	min: 100,
	default: 1500,
	max: 5000,
};

// i18n dot-path keys for the disabled-with-reason tooltips. The consumer
// resolves them through the `$LL` proxy — this module stays `$LL`-free.
const REASON_NON_CERALIVE = "settings.streamTuning.reasonNonCeraLive";
const REASON_FEC_UNSUPPORTED = "settings.streamTuning.reasonFecUnsupported";
const REASON_RECEIVER_MANAGED = "settings.streamTuning.reasonReceiverManaged";
const REASON_PROFILE_UNSUPPORTED =
	"settings.streamTuning.reasonProfileUnsupported";

/**
 * Map a configured relay/remote provider to the Stream Tuning receiver kind.
 * Only a managed CeraLive cloud is treated as a CeraLive receiver; every other
 * provider (BELABOX, a custom/self-hosted receiver, or none) is conservatively
 * non-CeraLive, so the card never assumes capabilities for an unproven receiver.
 */
export function deriveReceiverProfileKind(
	provider: string | undefined,
): ReceiverProfileKind {
	if (provider === "ceralive") return "ceralive";
	if (provider === "belabox") return "belabox";
	if (provider === "custom") return "custom";
	return "unknown";
}

/** The engine-advertised profile facts {@link deriveReceiverCaps} projects from. */
export interface ReceiverCapsSource {
	/** `supported_profiles` from the capability snapshot (cerastream Todo 10). */
	supportedProfiles?: readonly string[] | undefined;
	/** `fec_capable` from the capability snapshot. */
	fecCapable?: boolean | undefined;
	/** `latency_range` from the capability snapshot. */
	latencyRange?: LatencyRange | undefined;
}

/**
 * Build the {@link ReceiverCaps} descriptor that drives the card from the
 * receiver kind + the engine capability snapshot.
 *
 * A CeraLive receiver trusts the engine: its advertised profiles, FEC flag, and
 * latency window flow through (with sane fallbacks when the snapshot is absent).
 * Any other receiver is clamped to the BELABOX-compatible Classic baseline —
 * latency-only, no FEC — and never inherits forged engine caps.
 */
export function deriveReceiverCaps(
	kind: ReceiverProfileKind,
	source: ReceiverCapsSource | undefined,
): ReceiverCaps {
	if (kind !== "ceralive") {
		return {
			kind,
			supportsFec: false,
			supportedProfiles: [DEFAULT_NON_CERALIVE_PROFILE],
			latencyRange: SAFE_LATENCY_RANGE,
			recoveryMode: "stock",
		};
	}

	const advertised: StreamProfilePreset[] = [];
	for (const profile of source?.supportedProfiles ?? []) {
		const parsed = streamProfilePresetSchema.safeParse(profile);
		if (parsed.success) advertised.push(parsed.data);
	}
	const supportedProfiles: StreamProfilePreset[] =
		advertised.length > 0 ? advertised : [DEFAULT_NON_CERALIVE_PROFILE];
	const supportsFec =
		source?.fecCapable === true &&
		supportedProfiles.includes("low-latency-fec");
	const hasFullProfileSet = supportedProfiles.length > 1;
	const recoveryMode: StreamRecoveryMode =
		supportsFec || hasFullProfileSet ? "reorderfreeze" : "stock";

	return {
		kind,
		supportsFec,
		supportedProfiles,
		latencyRange: source?.latencyRange ?? CERALIVE_FALLBACK_LATENCY_RANGE,
		recoveryMode,
	};
}

/**
 * The resolved control state for the Stream Tuning card. Latency is always
 * available; FEC, recovery mode, and the preset chips are gated. Each gated
 * control carries the i18n REASON key for its disabled tooltip when it is off,
 * so the card shows WHY a control is unavailable — never hides it.
 */
export interface StreamTuningExperience {
	/** True for a CeraLive receiver — the full-controls branch. */
	isCeraLiveReceiver: boolean;
	/** Latency is honoured by every receiver, so its control is always enabled. */
	latencyEnabled: boolean;
	/** The latency slider window. */
	latencyRange: LatencyRange;
	/** FEC toggle availability. */
	fecEnabled: boolean;
	/** Disabled-tooltip reason key for FEC, present only when `fecEnabled` is false. */
	fecDisabledReasonKey?: string;
	/** Recovery-mode control availability (CeraLive only). */
	recoveryModeEnabled: boolean;
	recoveryModeDisabledReasonKey?: string;
	/** The recommended default recovery preference (always `standard`). */
	defaultRecoveryMode: StreamRecoveryPreference;
	/** Profile-preset chips availability (CeraLive only). */
	presetsEnabled: boolean;
	presetsDisabledReasonKey?: string;
	/** Profiles offered as preset chips (Classic-only for non-CeraLive). */
	availableProfiles: readonly StreamProfilePreset[];
	/** The default/seed profile (Classic for non-CeraLive). */
	defaultProfile: StreamProfilePreset;
	/** Show the "Standard (BELABOX-compatible defaults)" banner. */
	showBelaboxBanner: boolean;
}

/**
 * Derive the Stream Tuning card's control state from the receiver capabilities.
 *
 * Two top-level branches:
 * - CeraLive receiver → full controls; FEC is enabled only when the receiver's
 *   libsrt build advertises it (else disabled-with-reason, never hidden).
 * - any other receiver → latency-only; FEC / recovery / presets are
 *   disabled-with-reason and the BELABOX-compatible banner is shown.
 */
export function deriveStreamTuningExperience(
	caps: ReceiverCaps,
): StreamTuningExperience {
	if (caps.kind !== "ceralive") {
		return {
			isCeraLiveReceiver: false,
			latencyEnabled: true,
			latencyRange: caps.latencyRange,
			fecEnabled: false,
			fecDisabledReasonKey: REASON_NON_CERALIVE,
			recoveryModeEnabled: false,
			recoveryModeDisabledReasonKey: REASON_RECEIVER_MANAGED,
			defaultRecoveryMode: "standard",
			presetsEnabled: false,
			presetsDisabledReasonKey: REASON_NON_CERALIVE,
			availableProfiles: caps.supportedProfiles,
			defaultProfile: DEFAULT_NON_CERALIVE_PROFILE,
			showBelaboxBanner: true,
		};
	}

	const defaultProfile = caps.supportedProfiles.includes("balanced")
		? "balanced"
		: (caps.supportedProfiles[0] ?? DEFAULT_NON_CERALIVE_PROFILE);

	return {
		isCeraLiveReceiver: true,
		latencyEnabled: true,
		latencyRange: caps.latencyRange,
		fecEnabled: caps.supportsFec,
		...(caps.supportsFec
			? {}
			: { fecDisabledReasonKey: REASON_FEC_UNSUPPORTED }),
		recoveryModeEnabled: true,
		defaultRecoveryMode: "standard",
		presetsEnabled: true,
		availableProfiles: caps.supportedProfiles,
		defaultProfile,
		showBelaboxBanner: false,
	};
}

// =============================================================================
// Preset snap-chips (named saved combinations) — Task 20
// =============================================================================

/** Chip display order (the task's row order); `custom` always trails. */
const PRESET_CHIP_ORDER: readonly StreamProfilePreset[] = [
	"low-latency",
	"balanced",
	"resilient",
	"low-latency-fec",
	"classic",
];

/** i18n dot-path label key per profile id (incl. the derived `custom`). */
const PRESET_LABEL_KEYS: Record<StreamProfileId, string> = {
	balanced: "settings.streamTuning.profileNames.balanced",
	"low-latency": "settings.streamTuning.profileNames.lowLatency",
	resilient: "settings.streamTuning.profileNames.resilient",
	classic: "settings.streamTuning.profileNames.classic",
	"low-latency-fec": "settings.streamTuning.profileNames.lowLatencyFec",
	custom: "settings.streamTuning.profileNames.custom",
};

/**
 * One preset snap-chip's render state. The component resolves `labelKey` /
 * `reasonKey` through the `$LL` proxy (this module stays `$LL`-free) and renders
 * a disabled chip with `reasonKey` as its tooltip — capability-unavailable
 * presets are DISABLED-with-reason, never hidden.
 */
export interface PresetChip {
	presetId: StreamProfileId;
	labelKey: string;
	disabled: boolean;
	/** i18n reason key for the disabled tooltip; present only when `disabled`. */
	reasonKey?: string;
}

/**
 * Build the preset snap-chip row from the resolved Stream Tuning experience: the
 * 5 named presets in display order plus the derived `custom` chip. A chip is
 * disabled-with-reason (never hidden) when the receiver can't honour it:
 * - presets gated off entirely (non-CeraLive) → every chip carries the gate reason;
 * - a FEC preset on a receiver whose build lacks FEC → the FEC reason;
 * - a preset the receiver doesn't advertise → the profile-unsupported reason.
 * `custom` is the manual-tuning state, reachable only by editing a control, so it
 * is gated off exactly when presets are.
 */
export function getPresetChips(
	experience: StreamTuningExperience,
): PresetChip[] {
	const chips = PRESET_CHIP_ORDER.map((presetId): PresetChip => {
		const labelKey = PRESET_LABEL_KEYS[presetId];
		if (!experience.presetsEnabled) {
			return {
				presetId,
				labelKey,
				disabled: true,
				...(experience.presetsDisabledReasonKey
					? { reasonKey: experience.presetsDisabledReasonKey }
					: {}),
			};
		}
		if (PRESET_CONFIGS[presetId].fecEnabled && !experience.fecEnabled) {
			return {
				presetId,
				labelKey,
				disabled: true,
				reasonKey: experience.fecDisabledReasonKey ?? REASON_FEC_UNSUPPORTED,
			};
		}
		if (!experience.availableProfiles.includes(presetId)) {
			return {
				presetId,
				labelKey,
				disabled: true,
				reasonKey: REASON_PROFILE_UNSUPPORTED,
			};
		}
		return { presetId, labelKey, disabled: false };
	});

	chips.push({
		presetId: "custom",
		labelKey: PRESET_LABEL_KEYS.custom,
		disabled: !experience.presetsEnabled,
		...(experience.presetsEnabled || !experience.presetsDisabledReasonKey
			? {}
			: { reasonKey: experience.presetsDisabledReasonKey }),
	});
	return chips;
}

/** The live control values a preset is matched against. */
export interface PresetMatchValues {
	latencyMs: number;
	fecEnabled: boolean;
	recoveryMode: StreamRecoveryPreference;
}

/**
 * Resolve which chip is active from the live control values: the preset whose
 * expanded {latency, FEC, recovery} combination matches exactly, else `custom`.
 * Editing any one control therefore drops the active chip to `custom` for free —
 * no preset matches a bespoke combination.
 */
export function matchActivePreset(values: PresetMatchValues): StreamProfileId {
	for (const presetId of PRESET_CHIP_ORDER) {
		const config = PRESET_CONFIGS[presetId];
		if (
			config.latencyMs === values.latencyMs &&
			config.fecEnabled === values.fecEnabled &&
			config.recoveryMode === values.recoveryMode
		) {
			return presetId;
		}
	}
	return "custom";
}
