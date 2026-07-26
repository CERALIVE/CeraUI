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
	EngineBitrate,
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
	/**
	 * Stream-gated throughput in kbps — zeroed while idle so the HUD never
	 * persists a bitrate from the last session (Live-Data Discipline, T6).
	 */
	throughputKbps: number | null;
	/**
	 * Measured interface throughput in kbps, independent of the stream state.
	 * Re-derived from kernel byte counters every netif tick, so an idle link
	 * self-zeroes rather than going stale — which is why it is NOT stream-gated.
	 * `null` when the backend does not report per-second rates.
	 */
	rateTxKbps: number | null;
	rateRxKbps: number | null;
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
	/**
	 * The bitrate actually in effect, kbps: the engine's APPLIED encoder rate
	 * (`status.engine_bitrate.applied_kbps`) when it reports one, else the
	 * configured ceiling as the pre-`engine_bitrate` fallback.
	 */
	bitrateKbps: number | null;
	/** The operator's configured ceiling (`config.max_br`), kbps, or `null`. */
	bitrateCeilingKbps: number | null;
	/**
	 * True only when the engine PROVED it is running below the ceiling — i.e. it
	 * reported an applied rate and that rate is under `bitrateCeilingKbps`. Never
	 * inferred from the ceiling alone, so an engine that reports nothing (or one
	 * running at the ceiling) is never accused of throttling.
	 */
	isBitrateBelowCeiling: boolean;
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
	/**
	 * The engine's applied-vs-ceiling bitrate pair (`status.engine_bitrate`).
	 * Optional so an omitted value is indistinguishable from an engine that never
	 * reports one — both fall back to the configured ceiling.
	 */
	engineBitrate?: EngineBitrate | null;
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
