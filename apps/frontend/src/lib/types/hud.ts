/**
 * HUD data contract — Task 8
 *
 * Pure type definitions for the live-telemetry HUD. These shapes are derived
 * from the non-deprecated `subscriptions.svelte.ts` getter surface (modems,
 * wifi, sensors, streaming, connection state) by `hud.svelte.ts`.
 *
 * Keep this file rune-free and dependency-light so it can be imported by both
 * the runes store and plain unit tests.
 */
import type {
	ConfigMessage,
	ModemList,
	NetifMessage,
	SensorsStatus,
	UpdatingStatus,
	WifiStatus,
} from "@ceraui/rpc/schemas";

/**
 * WebSocket connection lifecycle (mirrors `ConnectionState` in rpc/client.ts).
 * Re-declared locally to keep this module free of runtime imports.
 */
export type HudConnectionState =
	| "connecting"
	| "connected"
	| "disconnected"
	| "error";

/**
 * A single bonded uplink (modem or wifi) as the HUD wants to render it.
 *
 * `signal` is `null` — never `0` — when the link cannot report a value
 * (no-SIM modem, unavailable status, negative/sentinel reading). A `null`
 * signal is a distinct "no data" state, not "0% signal".
 */
export interface LinkSignal {
	/** Stable identifier — modem `ifname`/key or wifi interface name. */
	id: string;
	type: "modem" | "wifi" | "ethernet";
	/** 0–5, maps to the `--link-1`..`--link-6` CSS color variables. */
	linkIndex: number;
	/** 0–100, or `null` when unavailable (no-SIM / null / sentinel). */
	signal: number | null;
	/** Operator name, SSID, or a generic fallback label. */
	label: string;
	isConnected: boolean;
	isStale: boolean;
	/** Throughput in kbps, or `null` when unavailable. */
	throughputKbps: number | null;
	/** Whether this link is enabled/active. */
	enabled: boolean;
	/** Modem connection state: connected, scanning, disconnected, or no_sim. */
	connectionState: "connected" | "scanning" | "disconnected" | "no_sim";
}

/**
 * The complete, render-ready HUD snapshot.
 *
 * Last-known values are preserved across disconnects; consumers use the
 * `*Stale` / `isFullyStale` flags to visually de-emphasise aged data rather
 * than clearing it to `null`.
 */
export interface HudState {
	// Streaming ---------------------------------------------------------------
	isStreaming: boolean;
	isStreamingStale: boolean;
	/** Target/working bitrate in kbps (from `config.max_br`), or `null`. */
	bitrateKbps: number | null;
	isBitrateStale: boolean;

	// Network links (up to 6 bonded links) -----------------------------------
	links: LinkSignal[];

	/** ifnames whose own data aged past the global threshold while siblings stayed fresh. */
	staleInterfaces: Set<string>;

	// SoC sensors -------------------------------------------------------------
	/** °C */
	temperature: number | null;
	/** V */
	voltage: number | null;
	/** A (mA inputs are converted to A) */
	current: number | null;
	isSensorsStale: boolean;

	// Connection --------------------------------------------------------------
	isConnected: boolean;
	/** True once the WS has been down longer than `STALE_THRESHOLD_MS`. */
	isFullyStale: boolean;

	// Update status -----------------------------------------------------------
	isUpdating: boolean;

	// Last-updated timestamps per data source (epoch ms, or null if never). ---
	lastUpdatedAt: {
		streaming: number | null;
		sensors: number | null;
		modems: number | null;
	};
}

/**
 * Raw, point-in-time inputs the derivation needs. Mirrors the relevant
 * `subscriptions.svelte.ts` getters; passed explicitly so `deriveHudState`
 * stays a pure, unit-testable function.
 */
export interface HudSources {
	isStreaming: boolean;
	isConnected: boolean;
	connectionState: HudConnectionState;
	config: ConfigMessage | undefined;
	modems: ModemList | undefined;
	wifi: WifiStatus | undefined;
	netif: NetifMessage | undefined;
	sensors: SensorsStatus | undefined;
	updating: UpdatingStatus | undefined;
}

/**
 * Per-source "last fresh data" timestamps (epoch ms) plus the moment the WS
 * connection was lost. Drives all staleness computation against a clock.
 */
export interface HudTimestamps {
	streaming: number | null;
	sensors: number | null;
	modems: number | null;
	wifi: number | null;
	/** Epoch ms when `isConnected` last flipped to `false`; null while up. */
	connectionLostAt: number | null;
}
