/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project


    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * Transport-provider/protocol registry — type contracts.
 *
 * A `TransportAdapter` turns a relay/manual config into the concrete endpoint
 * the streamer connects to. Adapters are registered per protocol in
 * `registry.ts`; only `srtla` has a working resolver today (`srt` and `rist`
 * are placeholders that throw `NotImplementedError`).
 *
 * This module is intentionally free of runtime side effects so adapters stay
 * unit-testable in isolation — the relays-cache snapshot is passed in via the
 * config, never read from a singleton here.
 */

// Detection-method ids + provider taxonomy are sourced from the Task 3
// cloud-provider/relay schema so the taxonomy stays in one place
// ("subscription" | "manual" | "belabox").
import type {
	DetectionMethod as DetectionMethodId,
	RelayProviderKind,
	RelayProviderMeta,
} from "@ceraui/rpc/schemas";
import type {
	RelayProtocol,
	RelaysCache,
} from "../../../helpers/config-schemas.ts";

// =============================================================================
// Resolution input / output
// =============================================================================

/**
 * The resolution input for an adapter (the task's `cfg`).
 *
 * Carries the relay/manual config fields read by the current `streaming.ts`
 * resolver plus a snapshot of the relays cache (mirrors `getRelays()`).
 * Bundling the cache here keeps `resolveEndpoint(cfg)` pure and dependency-free.
 */
export interface TransportConfig {
	/** Selected relay server id (flat or provider-namespaced). */
	relay_server?: string;
	/** Selected relay account id (flat or provider-namespaced). */
	relay_account?: string;
	/** Manual SRTLA address (used when no relay server is selected). */
	srtla_addr?: string;
	/** Manual SRTLA port (used when no relay server is selected). */
	srtla_port?: number;
	/** Manual stream id (used when no relay account is selected). */
	srt_streamid?: string;
	/** Relays-cache snapshot; `undefined` when no relays are loaded. */
	relays?: RelaysCache;
}

/** The concrete endpoint a transport connects to. */
export interface ResolvedEndpoint {
	/** Resolved host/address. */
	addr: string;
	/** Resolved port. */
	port: number;
	/** Resolved stream id / ingest key. */
	streamid: string;
}

/** Human-readable descriptor for an adapter (used by UI/diagnostics). */
export interface TransportDescriptor {
	/** Protocol this adapter handles. */
	protocol: RelayProtocol;
	/** Display label. */
	label: string;
	/** Whether the adapter has a working runtime resolver. */
	implemented: boolean;
}

// =============================================================================
// Adapter contract
// =============================================================================

/**
 * A transport adapter for a single relay protocol.
 *
 * Implementations reproduce the protocol-specific resolution that used to live
 * inline in `streaming.ts`. `validate` and `resolveEndpoint` throw a plain
 * `Error` on invalid config (mirroring the original messages) so existing
 * callers keep their behaviour.
 */
export interface TransportAdapter {
	/** Protocol this adapter handles. */
	readonly protocol: RelayProtocol;
	/** Validate the config for this protocol. Throws on invalid config. */
	validate(cfg: TransportConfig): void;
	/** Resolve the streaming endpoint. Throws on invalid config. */
	resolveEndpoint(cfg: TransportConfig): ResolvedEndpoint;
	/** Return a human-readable descriptor. */
	describe(): TransportDescriptor;
}

// =============================================================================
// Raw inbound feed → normalized catalog
// =============================================================================

export interface RawRelayFeedServer {
	type?: unknown;
	name?: unknown;
	addr?: unknown;
	port?: unknown;
	default?: unknown;
	bcrp_port?: unknown;
}

export interface RawRelayFeedAccount {
	name?: unknown;
	ingest_key?: unknown;
	disabled?: unknown;
}

/**
 * A raw, untrusted relay feed pushed by a cloud provider — the historical
 * `relays` WebSocket message shape. A detection method validates/normalizes it.
 * The relay catalog is the only concern: the BCRP key is an orthogonal
 * transport secret and is deliberately not modelled here.
 */
export interface RawRelayFeed {
	servers?: Record<string, RawRelayFeedServer | undefined>;
	accounts?: Record<string, RawRelayFeedAccount | undefined>;
}

export interface NormalizedRelayServer {
	name: string;
	addr: string;
	port: number;
	protocol: RelayProtocol;
	provider: RelayProviderMeta;
	default?: true;
	bcrp_port?: string;
}

export interface NormalizedRelayAccount {
	name: string;
	ingest_key: string;
	provider: RelayProviderMeta;
	disabled?: true;
}

/**
 * A normalized relay catalog. Ids stay FLAT (un-namespaced) to match the
 * historical loader and the live flat-lookup resolver; provider identity rides
 * the additive `provider` field instead.
 */
export interface NormalizedRelayConfig {
	servers: Record<string, NormalizedRelayServer>;
	accounts: Record<string, NormalizedRelayAccount>;
}

// =============================================================================
// Detection-method strategy
// =============================================================================

/** Context handed to a detection method (provider identity used for tagging). */
export interface DetectionContext {
	provider: RelayProviderMeta;
}

/**
 * Strategy describing how a relay catalog is detected/sourced for a provider
 * (subscription push, manual entry, belabox feed). An extension point: register
 * implementations via `registerDetectionMethod`.
 *
 * `normalize` turns a raw provider feed into a provider-tagged catalog and
 * returns `undefined` when the feed yields no usable relay server — mirroring
 * the historical loader's rejection semantics. It is optional because some
 * methods (e.g. `manual`) carry no feed.
 */
export interface DetectionMethod {
	/** Stable detection-method id (matches the cloud-provider taxonomy). */
	readonly method: DetectionMethodId;
	/** Provider taxonomy relays from this method are tagged with. */
	readonly providerKind?: RelayProviderKind;
	/** Return a human-readable label for this strategy. */
	describe(): string;
	normalize?(
		feed: RawRelayFeed,
		ctx?: Partial<DetectionContext>,
	): NormalizedRelayConfig | undefined;
}

// =============================================================================
// Errors
// =============================================================================

/** Thrown when a registered protocol has no working resolver yet. */
export class NotImplementedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotImplementedError";
	}
}

/** Thrown by the registry when no adapter is registered for a protocol. */
export class UnknownProtocolError extends Error {
	constructor(protocol: string) {
		super(`Unknown transport protocol: ${protocol}`);
		this.name = "UnknownProtocolError";
	}
}
