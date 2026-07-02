/**
 * ingestReadiness — pure derivation for the Live destination's idle ingest panel.
 *
 * While a server is configured but the stream is idle, the ingest area shows one
 * of two calm, informational states derived from the SAME `getNetif()` feed the
 * onboarding checklist already reads (no new subscription):
 *
 * - `links-ready` → at least one enabled interface has an IP: the operator has
 *   bonded links standing by. We name the ready links (iface names only) so the
 *   panel is honest about readiness WITHOUT surfacing any telemetry value —
 *   there is no live bond yet, so RTT/NAK/weight would be stale-looking
 *   fabrications (Live-Data Discipline, mirroring `IngestStats`' idle behaviour).
 * - `empty` → no enabled+IP'd interface: the current empty state, pointing the
 *   operator at Network.
 *
 * This is PURE (no runes, no RPC, no Svelte) so it is unit-testable in isolation
 * and the component stays presentational — matching the `sourceSummary.ts` /
 * `receiver-experience.ts` extraction pattern.
 */
import type { NetifMessage } from "@ceraui/rpc/schemas";

export type IngestReadiness =
	| { state: "links-ready"; count: number; ifaces: string[] }
	| { state: "empty" };

/**
 * Derive the idle ingest-panel state from the network-interface map.
 *
 * A link counts as "ready" only when it is BOTH enabled AND has an IP — the same
 * predicate `hasNetwork` uses for the onboarding checklist. An `undefined`/null
 * map (no snapshot yet — the connection-ready gate normally precludes this) is
 * treated as `empty`: a calm, telemetry-free default that never renders a
 * premature or wrong ready-count.
 */
export function deriveIngestReadiness(
	netif: NetifMessage | undefined | null,
): IngestReadiness {
	const ifaces: string[] = [];
	for (const [name, entry] of Object.entries(netif ?? {})) {
		if (entry?.enabled && entry?.ip) ifaces.push(name);
	}
	if (ifaces.length === 0) return { state: "empty" };
	return { state: "links-ready", count: ifaces.length, ifaces };
}
