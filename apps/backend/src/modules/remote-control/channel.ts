/*
    CeraUI - web UI for the CeraLive project
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
 * Remote Control Plane v2.0 — device-side control channel
 * (remote-relay-support spec §4, §9, §10).
 *
 * This is a SECOND, INDEPENDENT outbound WebSocket from the device to the
 * platform device-gateway hub. It is deliberately NOT multiplexed onto the BCRPT
 * relay socket (`modules/remote/remote.ts`): it dials a different (build-time
 * pinned) endpoint, presents a different token audience (`purpose:
 * "device-control"`, not `"relay-config"`), runs its own reconnect/keepalive
 * lifecycle, and NEVER calls `addAuthedSocket` — so it carries zero local
 * UI-client authority. The two channels share no socket and no token.
 *
 * Lifecycle:
 *   1. Gate (spec §9): never dial until identity is resolved AND paired —
 *      `canDialControlChannel()` (paired && device_id available). An unpaired
 *      device returns immediately without dialing.
 *   2. Dial the pinned hub URL (`resolveControlChannelEndpoint().url`).
 *   3. On open: send the `device.hello` handshake advertising the serviceable
 *      command types + device capabilities (spec §4 / §14.2).
 *   4. WS-level keepalive ping while connected.
 *   5. On drop: reconnect with exponential backoff + jitter.
 *
 * Fail-soft, like `initIdentity()`: a missing pin / transient failure never
 * throws out of `initControlChannel()` and never blocks boot. Inbound command
 * routing is Task 14; status relay is Task 15 — both build on `sendFrame()` /
 * `isConnected()` exported here.
 */

import WebSocket, { type RawData } from "ws";

import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import { logger } from "../../helpers/logger.ts";
import { getConfig } from "../config.ts";
import { canDialControlChannel } from "../identity/index.ts";
import { verifyDeviceControlToken } from "../pairing/device-token.ts";
import {
	type ControlChannelEndpoint,
	resolveControlChannelEndpoint,
} from "../remote/control-endpoint.ts";
import { getLastCapabilities } from "../streaming/capabilities.ts";
import { isRealDevice } from "../system/device-detection.ts";
import { reportActiveProfile } from "./active-profile-reporter.ts";
import {
	COMMAND_REGISTRY,
	CommandSchema,
	type Frame,
	type Handshake,
	PROTOCOL_VERSION,
} from "./protocol.ts";

/**
 * Reconnect backoff bounds. Independent of the BCRPT relay's fixed 1s retry: the
 * control channel must not hammer the hub on a hard outage, so it backs off
 * exponentially up to a 30s ceiling.
 */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/**
 * WS-level keepalive cadence (spec §4 keepalive). This is a WebSocket control
 * ping, NOT an application frame — the protocol envelope has no `ping` kind.
 */
export const KEEPALIVE_INTERVAL_MS = 30_000;

type TimerHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;

/**
 * Structural seam over the outbound WebSocket so the channel is unit-testable
 * without a real network socket (same DI posture as the rest of the backend).
 * The default factory wraps `ws`; tests inject a controllable fake.
 */
export interface ControlSocket {
	send(data: string): void;
	ping(): void;
	close(): void;
	onOpen(listener: () => void): void;
	onClose(listener: () => void): void;
	onMessage(listener: (data: string) => void): void;
	onError(listener: (err: Error) => void): void;
}

export interface ControlChannelLogger {
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
}

export interface ControlChannelDeps {
	/** Spec §9 gate: paired AND device_id resolved. */
	canDial: () => boolean;
	/** Build-time pinned hub endpoint (throws if not provisioned — fail-closed). */
	resolveEndpoint: () => ControlChannelEndpoint;
	createSocket: (url: string, authToken?: string) => ControlSocket;
	/**
	 * Control-channel PASETO token source, self-verified before presentation.
	 * Wired to the persisted claim/control credential (`config.remote_key`) — the
	 * same token the pairing claim stored. {@link resolveAuthToken} self-verifies
	 * it via {@link verifyToken} (purpose + signature, spec §10) before presenting,
	 * so a non-device-control or unverifiable token is dropped and the channel
	 * falls back to the key-less path. Tests inject their own source here.
	 */
	getControlToken: () => string | undefined;
	/** Local token verification (spec §10): never present a token we know is bad. */
	verifyToken: (token: string) => unknown;
	/**
	 * Current runtime config snapshot — read at `device.hello` time to derive the
	 * device's media-destination receiver kind (`deviceCaps.receiverKind`) and the
	 * persisted `stream_profile` advertised as `deviceCaps.preferred_profile`.
	 */
	getConfig: () => RuntimeConfig;
	/**
	 * Engine-advertised SRT profile-catalog version for the `device.hello`
	 * `deviceCaps.profile_catalog_version` advertisement (spec §4.3). Reads the
	 * last capability snapshot; returns `undefined` when the engine has not
	 * advertised one (or no snapshot exists yet), in which case the field is
	 * omitted from the hello (additive-optional — never null-filled).
	 */
	getProfileCatalogVersion: () => string | undefined;
	logger: ControlChannelLogger;
	random: () => number;
	setTimer: (fn: () => void, ms: number) => TimerHandle;
	clearTimer: (timer: TimerHandle) => void;
	setKeepalive: (fn: () => void, ms: number) => IntervalHandle;
	clearKeepalive: (timer: IntervalHandle) => void;
	uuid: () => string;
}

function defaultCreateSocket(url: string, authToken?: string): ControlSocket {
	const ws =
		authToken !== undefined
			? new WebSocket(url, {
					headers: { Authorization: `Bearer ${authToken}` },
				})
			: new WebSocket(url);
	return {
		send: (data) => ws.send(data),
		ping: () => ws.ping(),
		close: () => ws.close(),
		onOpen: (listener) => ws.on("open", listener),
		onClose: (listener) => ws.on("close", listener),
		onMessage: (listener) =>
			ws.on("message", (raw: RawData) => listener(String(raw))),
		onError: (listener) => ws.on("error", listener),
	};
}

function defaultDeps(isReal: boolean): ControlChannelDeps {
	return {
		canDial: canDialControlChannel,
		resolveEndpoint: () => resolveControlChannelEndpoint(),
		createSocket: defaultCreateSocket,
		getControlToken: () => getConfig().remote_key,
		verifyToken: (token) =>
			verifyDeviceControlToken(token, undefined, { isRealDevice: isReal }),
		getConfig,
		getProfileCatalogVersion: () =>
			getLastCapabilities()?.profile_catalog_version,
		logger,
		random: Math.random,
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (timer) => clearTimeout(timer),
		setKeepalive: (fn, ms) => setInterval(fn, ms),
		clearKeepalive: (timer) => clearInterval(timer),
		uuid: () => crypto.randomUUID(),
	};
}

interface ChannelState {
	deps: ControlChannelDeps;
	socket: ControlSocket | undefined;
	connected: boolean;
	reconnectAttempt: number;
	reconnectTimer: TimerHandle | undefined;
	keepaliveTimer: IntervalHandle | undefined;
}

// Process-wide singleton (mirrors remote.ts module-state posture).
let state: ChannelState | undefined;

/**
 * Exponential backoff with equal jitter: `base·2^attempt` capped at `max`, then
 * a random point in the upper half `[cap/2, cap]`. The jitter de-synchronises a
 * fleet reconnecting after a hub blip so they don't thundering-herd the gateway,
 * while staying close to the intended step (≈1s on the first attempt).
 */
export function backoffDelay(attempt: number, random: () => number): number {
	const capped = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
	return capped / 2 + random() * (capped / 2);
}

/**
 * Derive the device's media-DESTINATION receiver kind for `deviceCaps.receiverKind`.
 *
 * The kind follows where media actually egresses, NOT `remote_provider` alone: a
 * managed destination (`relay_server` or a selected platform ingest slot) reports the
 * provider, but a manual `srtla_addr` override reports `'custom'` even on a
 * CeraLive-paired device — otherwise the platform would wrongly push it FEC/L1 for a
 * receiver that is in fact custom. Returns `undefined` (field omitted) when not derivable.
 */
export function deriveReceiverKind(
	config: Pick<
		RuntimeConfig,
		| "relay_server"
		| "selected_ingest_endpoint"
		| "srtla_addr"
		| "remote_provider"
	>,
): string | undefined {
	if (
		config.relay_server !== undefined ||
		config.selected_ingest_endpoint !== undefined
	) {
		return config.remote_provider;
	}
	if (config.srtla_addr !== undefined) {
		return "custom";
	}
	return undefined;
}

/**
 * Build the `device.hello` handshake frame (spec §4 / §14.2). The hello body
 * (`v`, `supportedTypes`, `deviceCaps`) rides in `payload` per the envelope
 * contract — the hub validates `payload` against its `HandshakeDeviceSchema`.
 *
 * `deviceCaps` advertises three additive-optional facts, each OMITTED when its
 * underlying value is unknown (never null-filled — the hub tolerates a hello
 * that carries none of them, spec §4.3):
 *   - `receiverKind` — the device's media-destination receiver kind.
 *   - `preferred_profile` — the persisted `stream_profile` (device-declared
 *     SRT-receive preference), when the operator/cloud has pinned one.
 *   - `profile_catalog_version` — the engine's advertised profile-catalog
 *     version, when a capability snapshot carries one.
 */
function buildDeviceHello(deps: ControlChannelDeps): Handshake {
	const config = deps.getConfig();
	const receiverKind = deriveReceiverKind(config);
	const preferredProfile = config.stream_profile;
	const profileCatalogVersion = deps.getProfileCatalogVersion();
	const deviceCaps: Record<string, unknown> = {
		...(receiverKind !== undefined ? { receiverKind } : {}),
		...(preferredProfile !== undefined
			? { preferred_profile: preferredProfile }
			: {}),
		...(profileCatalogVersion !== undefined
			? { profile_catalog_version: profileCatalogVersion }
			: {}),
	};
	return {
		v: PROTOCOL_VERSION,
		kind: "handshake",
		type: "device.hello",
		cid: deps.uuid(),
		payload: {
			v: PROTOCOL_VERSION,
			supportedTypes: [...COMMAND_REGISTRY],
			deviceCaps,
		},
	};
}

/** Resolve + self-verify the control token; drop it if it doesn't verify locally. */
function resolveAuthToken(deps: ControlChannelDeps): string | undefined {
	const token = deps.getControlToken();
	if (token === undefined) return undefined;

	if (deps.verifyToken(token) === null) {
		deps.logger.warn(
			"control-channel: stored control token failed local verification; connecting without it",
		);
		return undefined;
	}
	return token;
}

function startKeepalive(): void {
	if (!state) return;
	stopKeepalive();
	state.keepaliveTimer = state.deps.setKeepalive(() => {
		if (state?.socket && state.connected) {
			state.socket.ping();
		}
	}, KEEPALIVE_INTERVAL_MS);
}

function stopKeepalive(): void {
	if (state?.keepaliveTimer !== undefined) {
		state.deps.clearKeepalive(state.keepaliveTimer);
		state.keepaliveTimer = undefined;
	}
}

function handleOpen(): void {
	if (!state) return;
	const { deps } = state;
	state.connected = true;
	state.reconnectAttempt = 0;

	deps.logger.info("control-channel: connected, sending device.hello");
	sendFrame(buildDeviceHello(deps));
	// Re-seed the hub with the device's EFFECTIVE active profile on every
	// (re)connect (cloud Todo 15): the hub loses the snapshot on disconnect, so
	// force past the de-dup even when the config is unchanged.
	reportActiveProfile({ force: true });
	startKeepalive();
}

function handleClose(): void {
	if (!state) return;
	const { deps } = state;
	const wasConnected = state.connected;
	state.connected = false;
	state.socket = undefined;
	stopKeepalive();

	if (wasConnected) {
		deps.logger.warn("control-channel: disconnected, scheduling reconnect");
	}
	scheduleReconnect();
}

function handleError(err: Error): void {
	// `ws` always fires `close` after `error`, so reconnect is scheduled there.
	state?.deps.logger.error(`control-channel: socket error: ${err.message}`);
}

function handleMessage(data: string): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		state?.deps.logger.warn("control-channel: dropped non-JSON inbound frame");
		return;
	}

	// Only `command` frames are routed here (spec §5). Non-command inbound frames
	// (the hub.hello handshake, acks) and malformed commands are silently ignored;
	// the handshake reply is sent on open and status relay is the outbound path.
	const command = CommandSchema.safeParse(parsed);
	if (!command.success) {
		return;
	}

	// Lazy import keeps the heavy streaming/RPC dispatch graph off the channel's
	// module-load path (and breaks the channel↔router import cycle): it is pulled
	// in only when the first command actually arrives. routeCommand is best-effort
	// and never throws — fire-and-forget.
	void import("./command-router.ts").then((m) => m.routeCommand(command.data));
}

function scheduleReconnect(): void {
	if (!state) return;
	const { deps } = state;

	// Never stack timers — a single in-flight reconnect at a time.
	if (state.reconnectTimer !== undefined) return;

	const delay = backoffDelay(state.reconnectAttempt, deps.random);
	state.reconnectAttempt += 1;

	deps.logger.info(
		`control-channel: reconnecting in ${Math.round(delay)}ms (attempt ${state.reconnectAttempt})`,
	);
	state.reconnectTimer = deps.setTimer(() => {
		if (state) state.reconnectTimer = undefined;
		dial();
	}, delay);
}

function dial(): void {
	if (!state) return;
	const { deps } = state;

	let endpoint: ControlChannelEndpoint;
	try {
		endpoint = deps.resolveEndpoint();
	} catch (err) {
		// Endpoint pinning is fail-closed (control-endpoint.ts throws when the hub
		// URL is not provisioned). That is a build-time constant — it won't appear
		// at runtime — so log and stop rather than retry-loop. Boot is unaffected.
		deps.logger.warn(
			`control-channel: hub endpoint unavailable, not dialing: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return;
	}

	const authToken = resolveAuthToken(deps);

	deps.logger.info(`control-channel: dialing hub ${endpoint.host}`);
	const socket = deps.createSocket(endpoint.url, authToken);
	state.socket = socket;

	socket.onOpen(handleOpen);
	socket.onClose(handleClose);
	socket.onMessage(handleMessage);
	socket.onError(handleError);
}

/**
 * Tear down any live socket/timers so `initControlChannel()` is idempotent
 * across reboots and test cases.
 */
function teardown(): void {
	if (!state) return;
	if (state.reconnectTimer !== undefined) {
		state.deps.clearTimer(state.reconnectTimer);
	}
	stopKeepalive();
	if (state.socket !== undefined) {
		try {
			state.socket.close();
		} catch {
			// best-effort close
		}
	}
	state = undefined;
}

/**
 * Best-effort send of a control frame (spec §6 — NOT a delivery guarantee).
 * Returns `false` (without throwing) when the channel is not connected or the
 * underlying send fails. Other modules (status relay, command results) call this
 * after checking {@link isConnected}.
 */
export function sendFrame(frame: Frame): boolean {
	if (!state || state.socket === undefined || !state.connected) {
		return false;
	}
	try {
		state.socket.send(JSON.stringify(frame));
		return true;
	} catch (err) {
		state.deps.logger.warn(
			`control-channel: sendFrame failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return false;
	}
}

/** Whether the control channel is currently connected to the hub. */
export function isConnected(): boolean {
	return state?.connected === true;
}

/**
 * Boot entry point. Resolves the gate and, if paired, dials the pinned hub and
 * starts the reconnect/keepalive lifecycle. Fail-soft: never throws, never
 * blocks boot. Idempotent — a prior channel is torn down first.
 */
export async function initControlChannel(
	overrides: Partial<ControlChannelDeps> = {},
): Promise<void> {
	const isReal = await isRealDevice();
	const deps: ControlChannelDeps = { ...defaultDeps(isReal), ...overrides };

	teardown();
	state = {
		deps,
		socket: undefined,
		connected: false,
		reconnectAttempt: 0,
		reconnectTimer: undefined,
		keepaliveTimer: undefined,
	};

	// Gate (spec §9): an unpaired / unresolved device MUST NOT dial.
	if (!deps.canDial()) {
		deps.logger.info(
			"control-channel: unpaired, control channel gated (no dial)",
		);
		return;
	}

	dial();
}
