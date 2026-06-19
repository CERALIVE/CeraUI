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
