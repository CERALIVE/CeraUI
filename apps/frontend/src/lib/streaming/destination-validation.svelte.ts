/**
 * destination-validation — the Live "traffic light" verdict store (Task 5).
 *
 * The Live destination row shows a small traffic-light chip that goes green only
 * when the CURRENTLY-SAVED server endpoint has actually passed a `relay.validate`
 * reachability check. This store is the single source of truth for that verdict.
 *
 * The verdict is keyed by a FINGERPRINT of the resolved endpoint, never a plain
 * "validated: true" flag — so the green light is honest across every way the
 * endpoint can change:
 *
 *   1. The operator edits an endpoint-defining config field (see
 *      {@link ENDPOINT_FINGERPRINT_KEYS}) — the fingerprint changes → the stored
 *      verdict no longer matches → the light resets to "Not checked".
 *   2. A managed `relay_server` id resolves through the relays CATALOG. If the
 *      catalog later maps the same id to a different addr/port, the RESOLVED
 *      endpoint (part of the fingerprint) changes → a stale green light resets,
 *      even though no config field the operator can see changed.
 *
 * Federation-safety: this store is informational only. It NEVER gates Start and
 * the verdict is NEVER persisted to config.json — it lives purely in memory for
 * the session. `ServerDialog`'s save path does NOT depend on it (the RPC is run
 * by a LiveView-side orchestrator, so a federated dialog bundle that lacks the
 * `relay.validate` RPC still saves normally).
 *
 * The pure fingerprint/resolution helpers carry no runes so they are directly
 * unit-testable; only the verdict slot is reactive.
 */

import type { ConfigMessage, RelayMessage } from "@ceraui/rpc/schemas";

import {
	findActiveSlot,
	type ManagedIngestAccount,
} from "./receiver-experience";

/**
 * The ENDPOINT-DEFINING subset of the keys `buildServerSetConfig` +
 * `buildManagedSlotConfig` (receiver-experience.ts) can emit — every emitted key
 * EXCEPT the tuning fields that do not change reachability (`srt_latency`; those
 * two functions emit no fec/recovery fields in the latency-only model). A change
 * to any of these keys must invalidate a green light; a change to `srt_latency`
 * must NOT.
 *
 * A self-consistency unit test proves every member here is a key one of those two
 * functions can actually emit, so this list can never silently drift out of sync
 * with the save payload.
 */
export const ENDPOINT_FINGERPRINT_KEYS = [
	"relay_server",
	"relay_account",
	"relay_streamid_override",
	"relay_protocol",
	"srtla_addr",
	"srtla_port",
	"srt_streamid",
	"selected_ingest_endpoint",
] as const;
export type EndpointFingerprintKey = (typeof ENDPOINT_FINGERPRINT_KEYS)[number];

/** The verdict a `relay.validate` run produced for a given endpoint fingerprint. */
export type DestinationVerdict = "validated" | "failed" | undefined;

/**
 * The resolved endpoint the `relay.validate` call targets, derived exactly the
 * way the RPC input is built — so the fingerprint tracks the REACHABLE target,
 * not just config identity. `undefined` when no endpoint is resolvable yet.
 */
export interface ValidationEndpoint {
	addr: string;
	port: number;
	streamid?: string;
	protocol?: string;
}

/**
 * Resolve the endpoint a saved config points at, mirroring the save/validate
 * paths (`buildManagedSlotConfig` / `buildServerSetConfig` in
 * receiver-experience.ts). Priority mirrors `deriveDestinationChoice`:
 *
 *   1. A resolved managed platform ingest slot (`selected_ingest_endpoint` maps
 *      to a known account) — the live account is the source of truth, so a
 *      catalog-side host/port change on the slot re-keys the fingerprint.
 *   2. A managed `relay_server` — addr/port resolve through the relays CATALOG,
 *      so a catalog-side change to the same id's addr/port re-keys it too.
 *   3. A custom manual endpoint — `srtla_addr`/`srtla_port` persisted directly.
 *
 * Returns `undefined` when the target cannot be resolved (no server, or a managed
 * server id whose catalog entry has no addr/port yet — a still-loading catalog).
 */
export function resolveValidationEndpoint(
	config: ConfigMessage | undefined,
	relays: RelayMessage | undefined,
	managedAccounts: readonly ManagedIngestAccount[] | undefined,
): ValidationEndpoint | undefined {
	// 1. Managed platform slot — resolve from the live account (mirrors
	//    buildManagedSlotConfig + the relay.validate input the orchestrator builds).
	const slot = findActiveSlot(
		managedAccounts ?? [],
		config?.selected_ingest_endpoint,
	);
	if (slot) {
		return {
			addr: slot.host,
			port: slot.port,
			...(slot.key ? { streamid: slot.key } : {}),
			...(slot.protocol ? { protocol: slot.protocol } : {}),
		};
	}

	// 2. Managed relay server — addr/port come from the CATALOG, not config.
	if (config?.relay_server) {
		const server = relays?.servers?.[config.relay_server];
		if (server?.addr === undefined || server.port === undefined) {
			return undefined;
		}
		return {
			addr: server.addr,
			port: server.port,
			...(config.relay_streamid_override
				? { streamid: config.relay_streamid_override }
				: {}),
			...(config.relay_protocol ? { protocol: config.relay_protocol } : {}),
		};
	}

	// 3. Custom manual endpoint — persisted directly in config.
	if (config?.srtla_addr && config?.srtla_port !== undefined) {
		return {
			addr: config.srtla_addr,
			port: config.srtla_port,
			...(config.srt_streamid ? { streamid: config.srt_streamid } : {}),
			...(config.relay_protocol ? { protocol: config.relay_protocol } : {}),
		};
	}

	return undefined;
}

/** Recursively sort object keys and drop `undefined` for a stable serialization. */
function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const child = (value as Record<string, unknown>)[key];
			if (child !== undefined) out[key] = stableValue(child);
		}
		return out;
	}
	return value;
}

/**
 * A stable fingerprint over (i) the {@link ENDPOINT_FINGERPRINT_KEYS} subset of
 * config AND (ii) the RESOLVED validate-input endpoint. Stable = sorted keys +
 * `undefined` omitted, so two logically-equal configs always fingerprint equal.
 */
export function fingerprintForValidation(
	config: ConfigMessage | undefined,
	relays: RelayMessage | undefined,
	managedAccounts: readonly ManagedIngestAccount[] | undefined,
): string {
	const source = config as Record<string, unknown> | undefined;
	const subset: Record<string, unknown> = {};
	for (const key of ENDPOINT_FINGERPRINT_KEYS) {
		const value = source?.[key];
		if (value !== undefined) subset[key] = value;
	}
	const endpoint = resolveValidationEndpoint(config, relays, managedAccounts);
	return JSON.stringify(
		stableValue({ config: subset, endpoint: endpoint ?? null }),
	);
}

// =============================================================================
// Reactive verdict slot (session-only; never persisted)
// =============================================================================

interface VerdictState {
	fingerprint: string;
	verdict: DestinationVerdict;
}

// Module-level rune state (mirrors subscriptions.svelte.ts / stream-health): the
// reactive root is created at import time, before any render, so a cross-module
// `$derived` reader in LiveView observes writes.
let verdictState = $state<VerdictState | undefined>(undefined);

/**
 * Record the outcome of a `relay.validate` run for an endpoint fingerprint.
 * A passing run stores `validated`; a failing run stores `failed` — both keyed by
 * the fingerprint, so the verdict only ever applies to the exact endpoint tested.
 */
export function recordValidation(fingerprint: string, ok: boolean): void {
	verdictState = { fingerprint, verdict: ok ? "validated" : "failed" };
}

/** The stored verdict + fingerprint, or `undefined` when nothing was recorded. */
export function getDestinationVerdict(): VerdictState | undefined {
	return verdictState;
}

/**
 * True only when a `validated` verdict was recorded AND its fingerprint still
 * matches the CURRENT resolved fingerprint (so an edited endpoint, or a
 * catalog-side addr/port drift under the same id, resets the light to unchecked).
 */
export function getDestinationValidated(
	config: ConfigMessage | undefined,
	relays: RelayMessage | undefined,
	managedAccounts: readonly ManagedIngestAccount[] | undefined,
): boolean {
	if (verdictState?.verdict !== "validated") return false;
	return (
		verdictState.fingerprint ===
		fingerprintForValidation(config, relays, managedAccounts)
	);
}

/** Clear the recorded verdict (test isolation seam). */
export function resetDestinationValidation(): void {
	verdictState = undefined;
}
