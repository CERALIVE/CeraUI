/**
 * RPC Subscriptions - Svelte 5 Runes Implementation
 *
 * This module manages real-time data subscriptions using Svelte 5 runes.
 * It provides reactive getters for all server-pushed data.
 */

import type {
	AddonState,
	CapabilitiesMessage,
	CaptureDevice,
	ConfigMessage,
	DeviceStats,
	DevicesMessage,
	KioskStatus,
	LinkTelemetryMessage,
	ModemList,
	NetifEntry,
	NetifMessage,
	NotificationsMessage,
	PipelinesMessage,
	RelayMessage,
	Revisions,
	SensorsStatus,
	StatusResponse,
	WifiStatus,
} from "@ceraui/rpc/schemas";

import { downloadLog } from "$lib/helpers/SystemHelper";
import { authStatusStore } from "$lib/stores/auth-status.svelte";
import { ingestBuffering } from "$lib/stores/buffering.svelte";
import {
	markSessionExpired,
	wasAuthenticated,
} from "$lib/stores/connection-ux.svelte";
import {
	dismiss as dismissNotification,
	push as pushNotification,
} from "$lib/stores/notifications.svelte";
import {
	resetPairingState,
	setControlChannelConnected,
} from "$lib/stores/pairing.svelte";
import { ingestStreamHealth } from "$lib/stores/stream-health.svelte";
import type { ManagedIngestAccount } from "$lib/streaming/receiver-experience";

import {
	confirmOperation,
	destroyAsyncOperations,
	failOperation,
	reconcileOperationsOnReconnect,
} from "./async-operation.svelte";
import type { ConnectionState } from "./client";
import { rpc, rpcClient } from "./client";
import {
	expireReactive,
	reconcileReactive,
	shouldIgnoreEchoReactive,
} from "./dirty-registry.svelte";
import { reauthenticateAndHydrate } from "./reconnect";
import { createSeqTracker } from "./seq-guard";

// ============================================
// Svelte 5 Reactive State ($state)
// ============================================

// Auth state
let authState = $state<{ success: boolean; auth_token?: string } | undefined>(
	undefined,
);

// Config state
let configState = $state<ConfigMessage | undefined>(undefined);

// Status state (aggregated)
let statusState = $state<
	| (StatusResponse & {
			is_streaming: boolean;
			wifi: WifiStatus;
			modems: ModemList;
	  })
	| undefined
>(undefined);

// Individual status components
let isStreamingState = $state<boolean>(false);
let sshState = $state<StatusResponse["ssh"] | undefined>(undefined);
let availableUpdatesState = $state<
	StatusResponse["available_updates"] | undefined
>(undefined);
let updatingState = $state<StatusResponse["updating"]>(null);

// Network state
let netifState = $state<NetifMessage | undefined>(undefined);
let wifiState = $state<WifiStatus | undefined>(undefined);
let modemsState = $state<ModemList | undefined>(undefined);

// Per-uplink srtla_send telemetry, folded into the `status` flow. `null` while
// srtla_send is not running or no fresh snapshot has arrived; `undefined` before
// the first status push. Links carry their own `stale` flag.
let linkTelemetryState = $state<LinkTelemetryMessage | null | undefined>(
	undefined,
);

// System state
let deviceStatsState = $state<DeviceStats | undefined>(undefined);
let sensorsState = $state<SensorsStatus | undefined>(undefined);
let revisionsState = $state<Revisions | undefined>(undefined);
let pipelinesState = $state<PipelinesMessage | undefined>(undefined);
let capabilitiesState = $state<CapabilitiesMessage | undefined>(undefined);
let audioCodecsState = $state<Record<string, { name: string }> | undefined>(
	undefined,
);

// Hotplug input picker (Task 34). `devices` is the live list; `activeInput` is
// the engine's current source (cerastream is the only engine).
let devicesState = $state<CaptureDevice[]>([]);
let activeInputState = $state<string | undefined>(undefined);

// Relay state
let relaysState = $state<RelayMessage | undefined>(undefined);

// Managed ingest slots (T18/T19): platform-pushed ingest endpoints mapped to
// selectable managed accounts, delivered via the `ingest.slots` broadcast. The
// operator's selection is persisted as `config.selected_ingest_endpoint`.
let managedIngestState = $state<ManagedIngestAccount[]>([]);

// Notifications state
let notificationsState = $state<NotificationsMessage | undefined>(undefined);

// Kiosk state (DC-2). Persisted toggle + live polled state, pushed by the
// backend `kiosk` broadcast on every transition. The settings UI reads the
// live `state` field, not just `enabled`, so it never shows "running" on a
// failed unit.
let kioskState = $state<KioskStatus | undefined>(undefined);

// Live per-add-on runtime state, keyed by id. The `addons` broadcast carries a
// PARTIAL map of only the changed add-ons, so it is merged per id, never replaced
// wholesale. Descriptors come from rpc.addons.list(); this tracks state only.
let addonsState = $state<Record<string, AddonState>>({});

// Connection state
let connectionState = $state<ConnectionState>("disconnected");
let isConnectedState = $state<boolean>(false);

// Boot gate: latches true on first "connected" event OR first inbound message,
// then never reverts. Event-driven with NO timeout — remote first-connect is
// legitimately slow and must never be failed by a clock (Oracle Q7).
let connectionReadyState = $state<boolean>(false);

// ============================================
// Reactive Getters (Svelte 5 Pattern)
// ============================================

export function getAuth() {
	return authState;
}

export function getConfig() {
	return configState;
}

export function getStatus() {
	return statusState;
}

export function getIsStreaming() {
	return isStreamingState;
}

export function getSsh() {
	return sshState;
}

export function getAvailableUpdates() {
	return availableUpdatesState;
}

export function getUpdating() {
	return updatingState;
}

export function getNetif() {
	return netifState;
}

export function getWifi() {
	return wifiState;
}

export function getModems() {
	return modemsState;
}

export function getLinkTelemetry() {
	return linkTelemetryState;
}

export function getSensors() {
	return sensorsState;
}

export function getDeviceStats() {
	return deviceStatsState;
}

export function getRevisions() {
	return revisionsState;
}

export function getPipelines() {
	return pipelinesState;
}

export function getCapabilities() {
	return capabilitiesState;
}

export function getAudioCodecs() {
	return audioCodecsState;
}

export function getDevices() {
	return devicesState;
}

export function getActiveInput() {
	return activeInputState;
}

export function getRelays() {
	return relaysState;
}

export function getManagedIngestAccounts(): readonly ManagedIngestAccount[] {
	return managedIngestState;
}

export function getSelectedIngestEndpoint(): string | undefined {
	return configState?.selected_ingest_endpoint;
}

export function getNotifications() {
	return notificationsState;
}

export function getKiosk() {
	return kioskState;
}

export function getAddons() {
	return addonsState;
}

export function getConnectionState() {
	return connectionState;
}

export function getIsConnected() {
	return isConnectedState;
}

/**
 * Whether the device has spoken to us at least once this page-load (first
 * "connected" event or first inbound message). Drives the boot shell's
 * "Connecting to device…" → live flip. Latches once; never reverts.
 */
export function getConnectionReady() {
	return connectionReadyState;
}

// ============================================
// Message Handlers
// ============================================

// Per-type drop-stale guard. The backend tags broadcasts with a top-level
// `seq` (lifted out in client.ts and forwarded here). Out-of-order or duplicate
// frames are ignored; lastSeen is reset on reconnect so a restarted server
// (seq back to 0) is accepted. Messages without `seq` bypass the guard.
const seqTracker = createSeqTracker();

/**
 * Per-modem merge of an incoming modems payload onto the current state.
 *
 * The backend broadcasts modem updates incrementally: a full snapshot carries
 * every field, but targeted broadcasts (configure, network-scan completion)
 * send only the changed modem(s) — and for those, only a subset of fields
 * (e.g. just `available_networks`, or status-only entries for the modems that
 * did not change). Replacing the whole map on each broadcast therefore wipes
 * the untouched fields (status, config, name), which flips a live modem to a
 * spurious no-SIM state until the next full snapshot. Merging field-by-field
 * per modem id keeps incremental updates non-destructive; a full snapshot still
 * overwrites every field it carries.
 */
function mergeModemList(
	prev: ModemList | undefined,
	incoming: ModemList,
): ModemList {
	const next: ModemList = { ...prev };
	for (const [id, modem] of Object.entries(incoming)) {
		if (!modem) continue;
		next[id] = { ...next[id], ...modem };
	}
	return next;
}

/**
 * Handle incoming messages and update state
 */
function handleMessage(type: string, data: unknown, seq?: number): void {
	// Drop out-of-order/duplicate broadcasts for this type before applying.
	// Messages without `seq` (local/legacy, or reconnect safety-hydrate
	// dispatches) bypass the guard.
	if (seq !== undefined && seqTracker.shouldDrop(type, seq)) {
		return;
	}

	if (!connectionReadyState) connectionReadyState = true;

	switch (type) {
		case "auth":
			authState = data as typeof authState;
			break;

		case "config": {
			// Lock-aware ingestion. The dirty-field registry is keyed on
			// ConfigMessage field names (max_br, acodec, delay, srtla_addr,
			// srt_latency, bitrate_overlay, resolution, framerate, ...). For each
			// field the server echoes: skip it if a stale optimistic lock guards
			// it (shouldIgnoreEchoReactive), otherwise apply it and reconcile the
			// lock (release once its RPC resolved and the server echoed the field).
			const incoming = data as ConfigMessage;
			const merged: ConfigMessage = { ...configState };
			for (const [field, value] of Object.entries(incoming)) {
				if (value === undefined) continue;
				if (shouldIgnoreEchoReactive(field, value)) continue;
				(merged as Record<string, unknown>)[field] = value;
				reconcileReactive(field, value);
			}
			configState = merged;
			break;
		}

		case "status": {
			// Status fields are not currently registry-guarded: the dirty-field
			// registry only covers ConfigMessage fields (see the "config" case).
			// Status-owned toggles (BondToggle / AsyncSwitch) register their own
			// fields in T14, so this merge is left untouched to avoid double-guarding.
			const statusData = data as StatusResponse;

			// Update individual states
			if (statusData.is_streaming !== undefined) {
				isStreamingState = statusData.is_streaming;
			}
			if (statusData.ssh !== undefined) {
				sshState = statusData.ssh;
			}
			if (statusData.available_updates !== undefined) {
				availableUpdatesState = statusData.available_updates;
			}
			if (statusData.updating !== undefined) {
				updatingState = statusData.updating;
			}
			if (statusData.wifi !== undefined) {
				wifiState = statusData.wifi;
			}
			if (statusData.modems !== undefined) {
				modemsState = mergeModemList(modemsState, statusData.modems);
			}
			if (statusData.linkTelemetry !== undefined) {
				linkTelemetryState = statusData.linkTelemetry;
			}
			// Store-and-forward buffering rides the engine `status` event bus (NOT
			// device-stats). undefined = no buffering field this frame (no-op).
			ingestBuffering(statusData.buffering);

			// Update aggregated status
			statusState = {
				...statusState,
				...statusData,
				is_streaming: isStreamingState,
				wifi: wifiState ?? {},
				modems: modemsState ?? {},
			} as typeof statusState;
			break;
		}

		case "netif": {
			// Lock-aware ingestion for the `enabled` field only.
			// BondToggle registers per-interface locks as `enabled_${name}` via
			// markPending/onRpcResolved. Guard only `enabled` — all other fields
			// (tp, ip, error, mac) flow through live without registry interaction.
			const incoming = data as NetifMessage;
			const merged: NetifMessage = { ...netifState };
			for (const [ifname, entry] of Object.entries(incoming)) {
				if (!entry) continue;
				const existing = merged[ifname] ?? ({} as NetifEntry);
				// Live fields — always apply.
				const live: Partial<NetifEntry> = {
					tp: entry.tp,
					...(entry.ip !== undefined ? { ip: entry.ip } : {}),
					...(entry.error !== undefined ? { error: entry.error } : {}),
					...(entry.mac !== undefined ? { mac: entry.mac } : {}),
				};
				// Guard the `enabled` field through the dirty-field registry.
				const field = `enabled_${ifname}`;
				let nextEnabled = existing.enabled ?? entry.enabled;
				if (!shouldIgnoreEchoReactive(field, entry.enabled)) {
					reconcileReactive(field, entry.enabled, undefined, { strict: true });
					nextEnabled = entry.enabled;
				}
				merged[ifname] = { ...existing, ...live, enabled: nextEnabled };
			}
			netifState = merged;
			break;
		}

		case "wifi": {
			// WiFi responses carry several shapes. The connect/new RESULT frames are
			// routed into the keyed async-operation store (the single feedback path
			// for the WifiSelectorDialog) — never a hardcoded toast here.
			const wifiData = data as {
				connect?: boolean | string[];
				device?: string | number;
				disconnect?: string;
				new?: { error?: string; success?: boolean; device?: string | number };
				hotspot?: {
					config?: {
						device?: string | number;
						success?: boolean;
						error?: string;
					};
				};
			};

			// Boolean connect result (saved network). The array ack (connect:
			// string[]) is a dispatch echo and is intentionally ignored.
			if (
				typeof wifiData.connect === "boolean" &&
				wifiData.device !== undefined
			) {
				const key = `wifi:${wifiData.device}`;
				if (wifiData.connect) {
					confirmOperation(key);
				} else {
					failOperation(key, "connect_failed");
				}
			}
			// New-network result.
			if (wifiData.new?.device !== undefined) {
				const key = `wifi:${wifiData.new.device}`;
				if (wifiData.new.success) {
					confirmOperation(key);
				} else if (wifiData.new.error) {
					failOperation(key, wifiData.new.error);
				}
			}
			// Deferred hotspot reconfigure result. `hotspotConfigure` only acks the
			// dispatch; the real outcome arrives here and resolves the separate
			// `hotspot-config:${device}` key the HotspotDialog save op stays pending on.
			if (wifiData.hotspot?.config?.device !== undefined) {
				const key = `hotspot-config:${wifiData.hotspot.config.device}`;
				if (wifiData.hotspot.config.success) {
					confirmOperation(key);
				} else {
					failOperation(key, wifiData.hotspot.config.error ?? "failed");
				}
			}
			break;
		}

		case "modems":
			// Modems data is usually part of status, but can come separately
			if (data && typeof data === "object") {
				modemsState = mergeModemList(modemsState, data as ModemList);
			}
			break;

		case "sensors":
			sensorsState = data as SensorsStatus;
			break;

		case "device-stats":
			deviceStatsState = data as DeviceStats;
			break;

		case "revisions":
			revisionsState = data as Revisions;
			break;

		case "pipelines":
			if (
				data &&
				typeof data === "object" &&
				"pipelines" in (data as Record<string, unknown>)
			) {
				pipelinesState = data as PipelinesMessage;
			} else {
				pipelinesState = {
					hardware: (data as { hardware?: string })?.hardware ?? "generic",
					pipelines: data as Record<string, unknown>,
				} as unknown as PipelinesMessage;
			}
			break;

		case "capabilities":
			if (data && typeof data === "object") {
				capabilitiesState = data as CapabilitiesMessage;
			}
			break;

		case "acodecs":
			audioCodecsState = data as Record<string, { name: string }>;
			break;

		case "devices": {
			// A device that drops out of a fresh broadcast was unplugged: retain it
			// flagged `lost` so the picker shows a disabled entry (and a switch to it
			// surfaces SOURCE_LOST) instead of silently vanishing.
			const msg = data as DevicesMessage;
			const incoming = msg.devices ?? [];
			const incomingIds = new Set(incoming.map((d) => d.input_id));
			const retainedLost: CaptureDevice[] = devicesState
				.filter((d) => !incomingIds.has(d.input_id))
				.map((d) => ({ ...d, lost: true }));
			devicesState = [...incoming, ...retainedLost];
			activeInputState = msg.active_input;
			break;
		}

		case "relays":
			relaysState = data as RelayMessage;
			break;

		case "ingest.slots": {
			// Each push carries the complete, authoritative account list (T18/T19);
			// a non-array payload is ignored so the store is never clobbered.
			const accounts = (data as { slots?: unknown })?.slots ?? data;
			if (Array.isArray(accounts)) {
				managedIngestState = accounts as ManagedIngestAccount[];
			}
			break;
		}

		case "notifications": {
			// `show` adds/updates; `remove` (backend `notificationRemove`, or
			// another client dismissing a persistent item) drops it live. The
			// remove-only frame carries no `show`, so both arrays are optional.
			const message = data as NotificationsMessage & { remove?: string[] };
			notificationsState = data as NotificationsMessage;
			for (const notification of message.show ?? []) {
				pushNotification(notification);
			}
			for (const name of message.remove ?? []) {
				dismissNotification(name);
			}
			break;
		}

		case "kiosk":
			// DC-2 live state. The backend pushes the full status on every kiosk
			// transition (toggle, start resolve, crash-loop auto-disable). Replace
			// wholesale — each broadcast carries the complete, authoritative status.
			if (data && typeof data === "object") {
				kioskState = data as KioskStatus;
			}
			break;

		case "addons":
			// Partial map of changed add-ons: merge per id so an untouched add-on's
			// state is preserved (mirrors the modem per-id merge above).
			if (data && typeof data === "object") {
				addonsState = {
					...addonsState,
					...(data as Record<string, AddonState>),
				};
			}
			break;

		case "remote-control":
			// Device-control channel up/down (the second outbound WS to the cloud
			// hub). Pairing comes from `config.remote_key`, never this frame; read
			// defensively so a partial frame can't throw.
			if (data && typeof data === "object") {
				setControlChannelConnected(
					(data as { connected?: unknown }).connected === true,
				);
			}
			break;

		case "health":
			// Tri-state stream-liveness rollup (Task 13). Read-only: feeds the HUD
			// indicator + raises a transition toast; never drives restart logic.
			ingestStreamHealth(data);
			break;

		case "bitrate":
			// Bitrate updates during streaming
			if (configState && (data as { max_br?: number }).max_br) {
				configState = {
					...configState,
					max_br: (data as { max_br: number }).max_br,
				};
			}
			break;

		case "log":
			// Download log file
			if (typeof data === "object" && data !== null) {
				downloadLog(data as { name: string; contents: string });
			}
			break;

		default:
			console.debug("Unhandled message type:", type, data);
	}

	// Advance lastSeen after applying so the next stale/duplicate is dropped.
	if (seq !== undefined) {
		seqTracker.advance(type, seq);
	}
}

const AUTH_STORAGE_KEY = "auth";

let reauthInFlight = false;

function readStoredToken(): string | null {
	return typeof localStorage !== "undefined"
		? localStorage.getItem(AUTH_STORAGE_KEY)
		: null;
}

function clearStoredToken(): void {
	if (typeof localStorage !== "undefined") {
		localStorage.removeItem(AUTH_STORAGE_KEY);
	}
}

function routeToLogin(): void {
	if (authStatusStore.value) {
		markSessionExpired();
		authStatusStore.set(false);
	}
}

async function runReconnectReauth(): Promise<void> {
	if (reauthInFlight) return;
	reauthInFlight = true;
	try {
		await reauthenticateAndHydrate({
			getStoredToken: readStoredToken,
			clearStoredToken,
			// The remember-me credential under localStorage `auth` is the password,
			// which the backend verifies via `input.password` (not as a `token`).
			login: (token) =>
				rpc.auth.login({ password: token, persistent_token: true }),
			getConfig: () => rpc.streaming.getConfig(),
			getStatus: () => rpc.status.getStatus(),
			dispatch: handleMessage,
			routeToLogin,
			onError: (error) => console.error("Reconnect re-auth failed:", error),
		});
	} finally {
		reauthInFlight = false;
	}
}

/**
 * Handle connection state changes
 */
function handleConnectionChange(state: ConnectionState): void {
	const previous = connectionState;
	connectionState = state;
	isConnectedState = state === "connected";

	// On the reconnect edge drop every still-pending OS-operation latch: the
	// post-reconnect getStatus hydrate (kicked async by runReconnectReauth below)
	// is the authoritative snapshot, so a stale pending must not linger. Steady
	// connected→connected ticks reconcile nothing.
	reconcileOperationsOnReconnect(previous, state);

	if (state === "connected") {
		if (!connectionReadyState) connectionReadyState = true;
		// Reconnect edge: a server that restarted resets its seq to 0, so clear
		// all per-type lastSeen to accept the fresh sequence. Guarding on
		// `previous !== "connected"` keeps steady connected ticks inert.
		if (previous !== "connected") {
			seqTracker.resetOnReconnect();
		}
		// Recovery toast: only emit when reconnecting after a prior drop (wasAuthenticated).
		// Suppress the initial connect of a page-load — that's owned by Layout's login flow.
		if (wasAuthenticated()) {
			pushNotification({
				name: "connection-recovered",
				type: "success",
				key: "notifications.connectionRecovered",
				msg: "Connection restored",
				is_dismissable: true,
				is_persistent: false,
				duration: 3,
			});
			void runReconnectReauth();
		}
	} else if (state === "disconnected") {
		pushNotification({
			name: "connection-lost",
			type: "error",
			key: "notifications.connectionLost",
			msg: "Connection lost",
			is_dismissable: true,
			is_persistent: false,
			duration: 3,
		});
	}
}

// ============================================
// Initialization
// ============================================

let isInitialized = false;

const LOCK_EXPIRY_TICK_MS = 5_000;
let lockExpiryTick: ReturnType<typeof setInterval> | undefined;

/**
 * Initialize subscriptions
 */
export function initSubscriptions(): void {
	if (isInitialized) return;
	isInitialized = true;

	// Set up message handler
	rpcClient.onMessage(handleMessage);

	// Set up connection handler
	rpcClient.onConnectionChange(handleConnectionChange);

	// Drive the dirty-field registry's TTL safety valve from the ingestion layer
	// so optimistic locks can never outlive FIELD_LOCK_TTL_MS even if a field is
	// never echoed back by the server.
	lockExpiryTick ??= setInterval(() => {
		expireReactive();
	}, LOCK_EXPIRY_TICK_MS);

	// Connect to server
	rpcClient.connect();
}

/**
 * Reset all state (for testing or logout)
 */
export function resetState(): void {
	authState = undefined;
	configState = undefined;
	statusState = undefined;
	isStreamingState = false;
	sshState = undefined;
	availableUpdatesState = undefined;
	updatingState = null;
	netifState = undefined;
	wifiState = undefined;
	modemsState = undefined;
	linkTelemetryState = undefined;
	sensorsState = undefined;
	deviceStatsState = undefined;
	revisionsState = undefined;
	pipelinesState = undefined;
	capabilitiesState = undefined;
	audioCodecsState = undefined;
	relaysState = undefined;
	managedIngestState = [];
	notificationsState = undefined;
	kioskState = undefined;
	addonsState = {};
	devicesState = [];
	activeInputState = undefined;
	connectionReadyState = false;
	resetPairingState();

	if (lockExpiryTick !== undefined) {
		clearInterval(lockExpiryTick);
		lockExpiryTick = undefined;
	}

	// Tear down the keyed async-operation store (sweep timer + effect root) for
	// test/logout symmetry — mirrors the per-field sync-state lifecycle.
	destroyAsyncOperations();
}

// ============================================
// Legacy API Compatibility
// ============================================

/**
 * Send a message (legacy API)
 * @deprecated Use rpc.* methods directly
 */
export function sendMessage(message: string): void {
	const parsed = JSON.parse(message);
	for (const [type, data] of Object.entries(parsed)) {
		rpcClient.sendLegacy(type, data);
	}
}

/**
 * Get the raw socket (legacy API)
 * @deprecated Use rpcClient directly
 */
export function getSocket(): WebSocket | null {
	return rpcClient.getSocket();
}

/**
 * Alias for backwards compatibility
 */
export const socket = {
	get send() {
		return (message: string) => {
			const ws = rpcClient.getSocket();
			if (ws?.readyState === WebSocket.OPEN) {
				ws.send(message);
			}
		};
	},
	get readyState() {
		return rpcClient.getSocket()?.readyState ?? WebSocket.CLOSED;
	},
};
