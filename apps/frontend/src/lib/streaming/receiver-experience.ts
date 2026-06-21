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
	deriveReceiverKind,
	type ReceiverKind,
	type RelayProtocol,
	type RelayServer,
	relayProtocolSchema,
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
}

/** The derived branch selectors the save handler keys off. */
export interface ServerSetDerived {
	destination: Destination;
	/** True when a managed server is using a manual endpoint override. */
	relayOverride: boolean;
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
): string {
	const hasServer = Boolean(config?.srtla_addr || config?.relay_server);
	if (!hasServer || !kind) return labels.notConfigured;

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
	if (lastUsed) return { kind: "managed", account: lastUsed, reason: "lastUsed" };
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
