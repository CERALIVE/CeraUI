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

import type {
	RelayProtocol,
	RelaysCache,
} from "../../../helpers/config-schemas.ts";
// Detection-method ids are sourced from the Task 3 cloud-provider schema so the
// taxonomy stays in one place ("subscription" | "manual" | "belabox").
import type { DetectionMethod as DetectionMethodId } from "@ceraui/rpc/schemas";

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
// Detection-method strategy
// =============================================================================

/**
 * Strategy describing how a relay endpoint is detected/sourced for a provider
 * (subscription push, manual entry, belabox feed). An extension point: register
 * implementations via `registerDetectionMethod`. Not yet consumed by the
 * runtime resolver — wired in by a later task.
 */
export interface DetectionMethod {
	/** Stable detection-method id (matches the cloud-provider taxonomy). */
	readonly method: DetectionMethodId;
	/** Return a human-readable label for this strategy. */
	describe(): string;
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
