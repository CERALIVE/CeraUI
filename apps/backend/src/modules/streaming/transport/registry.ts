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
 * Transport-provider/protocol registry.
 *
 * Module-level singleton mapping each relay protocol to a `TransportAdapter`
 * and each detection-method id to a `DetectionMethod` strategy. Both are open
 * extension points (`registerProtocol`, `registerDetectionMethod`).
 *
 * `srtla` ships with a working adapter; `srt` and `rist` are registered as
 * placeholders whose resolver throws `NotImplementedError` until their
 * transports land. `getAdapter` throws `UnknownProtocolError` for anything that
 * has no registered adapter.
 */

import type { RelayProtocol } from "../../../helpers/config-schemas.ts";

import { srtlaAdapter } from "./srtla-adapter.ts";
import {
	type DetectionMethod,
	NotImplementedError,
	type ResolvedEndpoint,
	type TransportAdapter,
	type TransportConfig,
	type TransportDescriptor,
	UnknownProtocolError,
} from "./types.ts";

// =============================================================================
// Singleton registries
// =============================================================================

const adapters = new Map<RelayProtocol, TransportAdapter>();
const detectionMethods = new Map<string, DetectionMethod>();

// =============================================================================
// Extension points
// =============================================================================

/** Register (or override) the adapter for a protocol. */
export function registerProtocol(adapter: TransportAdapter): void {
	adapters.set(adapter.protocol, adapter);
}

/** Register (or override) a detection-method strategy. */
export function registerDetectionMethod(method: DetectionMethod): void {
	detectionMethods.set(method.method, method);
}

// =============================================================================
// Lookups
// =============================================================================

/** Resolve the adapter for a protocol, or throw `UnknownProtocolError`. */
export function getAdapter(protocol: string): TransportAdapter {
	const adapter = adapters.get(protocol as RelayProtocol);
	if (!adapter) throw new UnknownProtocolError(protocol);
	return adapter;
}

/** Resolve a detection-method strategy by id, or `undefined` if unregistered. */
export function getDetectionMethod(method: string): DetectionMethod | undefined {
	return detectionMethods.get(method);
}

/** List the protocols that currently have a registered adapter. */
export function listProtocols(): RelayProtocol[] {
	return [...adapters.keys()];
}

// =============================================================================
// Placeholder adapters (srt / rist)
// =============================================================================

/**
 * Build a placeholder adapter for a protocol whose transport is not yet
 * implemented. `validate`/`resolveEndpoint` both throw `NotImplementedError`.
 */
function createPlaceholderAdapter(
	protocol: RelayProtocol,
	label: string,
	message: string,
): TransportAdapter {
	const fail = (): never => {
		throw new NotImplementedError(message);
	};
	return {
		protocol,
		validate(_cfg: TransportConfig): void {
			fail();
		},
		resolveEndpoint(_cfg: TransportConfig): ResolvedEndpoint {
			return fail();
		},
		describe(): TransportDescriptor {
			return { protocol, label, implemented: false };
		},
	};
}

// =============================================================================
// Default registrations
// =============================================================================

registerProtocol(srtlaAdapter);
registerProtocol(
	createPlaceholderAdapter("srt", "SRT", "SRT not yet implemented"),
);
registerProtocol(
	createPlaceholderAdapter("rist", "RIST", "RIST not yet implemented"),
);
