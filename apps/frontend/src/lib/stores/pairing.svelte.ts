/**
 * Pairing & remote-control store — Task 8 (CeraUI N1).
 *
 * The single source of truth for two related questions:
 *   1. Is this device paired to a cloud account, and to WHICH provider?
 *   2. What is the device-control channel's status (the 3-state Settings row)?
 *
 * MULTI-CLOUD SAFETY (open-source contract)
 * -----------------------------------------
 * Pairing is `remote_key` PRESENCE — never `remote_provider === 'ceralive'`.
 * `remote_provider` only IDENTIFIES which managed cloud a paired device belongs
 * to; gating on a single provider literal would break self-hosted, BELABOX, and
 * any future managed cloud. `getRemoteProvider()` therefore NEVER defaults to
 * `'ceralive'` — an absent provider reads as "no managed provider" for gating.
 *
 * Pairing facts (`isPairedToCloud`, `getRemoteProvider`, `isPairedToManagedCloud`)
 * are pure reads off the authoritative config broadcast (`getConfig()`), so they
 * need no local reactive state. The control-channel connectivity (up/down) is a
 * separate runtime signal owned by the backend remote-control module; it is
 * folded in via {@link setControlChannelConnected} — ingested from the
 * `remote-control` broadcast in `subscriptions.svelte.ts`, or driven directly by
 * a dev seam / test.
 *
 * Architecture mirrors `stream-health.svelte.ts` / `buffering.svelte.ts`: all
 * decision logic lives in pure, rune-free exported functions; the reactive layer
 * (the dual-URL global singleton) is the only place that touches runes.
 */
import type { ProviderSelection } from "@ceraui/rpc/schemas";

import { getConfig } from "$lib/rpc/subscriptions.svelte";

/**
 * The render-ready 3-state remote-control indicator rollup (Settings row — NOT
 * the HUD, whose 5-signal contract is frozen):
 *   - `not-paired`          — no `remote_key`.
 *   - `paired-disconnected` — `remote_key` present, control channel down.
 *   - `connected`           — `remote_key` present, control channel up.
 */
export type RemoteControlStatus =
	| "not-paired"
	| "paired-disconnected"
	| "connected";

/**
 * Managed-cloud providers — a hosted cloud account that pushes a relay catalog /
 * ingest slots. `custom` is the self-hosted / BYO provider and is intentionally
 * NOT a managed provider, so managed-cloud surfaces stay gated for it while the
 * custom receiver path is always reachable. New managed providers are added HERE
 * — never gate on a single literal at a call site.
 */
const MANAGED_PROVIDERS: ReadonlySet<ProviderSelection> =
	new Set<ProviderSelection>(["ceralive", "belabox"]);

/** Paired to a cloud account ⇔ a `remote_key` is present. Provider-agnostic. */
export function isPairedToCloud(): boolean {
	return getConfig()?.remote_key !== undefined;
}

/**
 * The managed cloud provider this device is paired to, or `undefined`. NEVER
 * defaults to `'ceralive'` — an absent provider must read as "no managed
 * provider" for gating, not as the CeraLive cloud.
 */
export function getRemoteProvider(): ProviderSelection | undefined {
	return getConfig()?.remote_provider ?? undefined;
}

/** Whether a provider id is one of the managed clouds (not custom/self-hosted). */
export function isManagedProvider(
	provider: ProviderSelection | undefined,
): boolean {
	return provider !== undefined && MANAGED_PROVIDERS.has(provider);
}

/**
 * Gate for managed-cloud surfaces (managed destination choice, ingest slots):
 * paired AND the provider is a managed cloud. False for unpaired devices and for
 * custom/self-hosted pairings. The custom/self-hosted receiver path stays
 * available regardless — callers must NEVER gate the custom path on this.
 */
export function isPairedToManagedCloud(): boolean {
	return isPairedToCloud() && isManagedProvider(getRemoteProvider());
}

/**
 * Pure 3-state derivation (unit-testable without runes or config):
 *   - no remote_key                      → "not-paired"
 *   - remote_key + control channel down  → "paired-disconnected"
 *   - remote_key + control channel up    → "connected"
 */
export function deriveRemoteControlStatus(
	hasRemoteKey: boolean,
	controlChannelUp: boolean,
): RemoteControlStatus {
	if (!hasRemoteKey) return "not-paired";
	return controlChannelUp ? "connected" : "paired-disconnected";
}

// ============================================
// Control-channel connectivity (runes singleton)
// ============================================

interface PairingStore {
	setControlChannelConnected(connected: boolean): void;
	isControlChannelConnected(): boolean;
	reset(): void;
}

function createPairingStore(): PairingStore {
	let controlChannelConnected = $state(false);
	return {
		setControlChannelConnected: (connected: boolean) => {
			controlChannelConnected = connected;
		},
		isControlChannelConnected: () => controlChannelConnected,
		reset: () => {
			controlChannelConnected = false;
		},
	};
}

// Held on `globalThis` under a shared symbol AND created eagerly — the same
// dual-URL guard `stream-health.svelte.ts` / `notifications.svelte.ts` use. In
// Vite dev this `.svelte.ts` is served under two browser URLs (one for `.svelte`
// importers like the Settings row, one for `.ts` importers like subscriptions),
// so a plain module-level rune would split producer and consumer into two
// stores. The shared key gives both copies ONE reactive store.
const STORE_KEY = Symbol.for("ceraui.pairingStore");
type GlobalWithStore = typeof globalThis & { [STORE_KEY]?: PairingStore };

const singletonStore: PairingStore = ((): PairingStore => {
	const g = globalThis as GlobalWithStore;
	const existing = g[STORE_KEY] ?? createPairingStore();
	g[STORE_KEY] = existing;
	return existing;
})();

function store(): PairingStore {
	return singletonStore;
}

/**
 * Fold the remote-control channel connectivity into the store. Fed by the
 * `remote-control` broadcast (subscriptions) when the backend reports the
 * device-control channel up/down, or driven directly by a dev seam / test.
 * Pairing itself comes from `config.remote_key`, never from this signal.
 */
export function setControlChannelConnected(connected: boolean): void {
	store().setControlChannelConnected(connected);
}

/** Whether the device-control channel to the cloud hub is currently up. */
export function isControlChannelConnected(): boolean {
	return store().isControlChannelConnected();
}

/** The current 3-state remote-control rollup for the Settings indicator row. */
export function getRemoteControlStatus(): RemoteControlStatus {
	return deriveRemoteControlStatus(
		isPairedToCloud(),
		isControlChannelConnected(),
	);
}

/** Reset control-channel state (test/logout symmetry). */
export function resetPairingState(): void {
	store().reset();
}
