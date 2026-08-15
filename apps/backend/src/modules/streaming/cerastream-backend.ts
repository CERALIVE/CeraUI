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

// CerastreamBackend: the StreamingBackend implementation for the Rust `cerastream`
// engine — the only engine CeraUI drives. Every operation is a structured
// JSON-RPC call over cerastream's control socket (`@ceralive/cerastream`):
//
//   * config  -> the unified config is serialized via the binding's canonical
//                serializer + pushed over IPC (`start` / `reload-config`).
//   * errors  -> the engine emits STRUCTURED Tier-2 error events; they are mapped
//                onto Task-7's code table by `cerastream-error-mapping.ts` (no
//                stderr regex lives on this path).
//   * telemetry/device events -> bridged into the existing `status` broadcast.
//
// cerastream is a systemd-owned service (ADR-0005): CeraUI CONNECTS to it, it
// never spawns it, so `start`/`stop` drive the pipeline over IPC rather than an OS
// process. Every effectful collaborator is injected (`CerastreamBackendDeps`) so
// the contract suite drives a real backend against an in-memory fake client.
//
// THE SESSION-SCOPED CONTROL CONNECTION *IS* THE SESSION.
//
// `this.client` is opened once, in `start()`, and held for the session's whole
// lifetime. The published `@ceralive/cerastream` client is dialled with
// `autoReconnect` at its default (false) and exposes NO close/error event, no
// `isConnected()`, and no `reconnect()` — so once its Unix socket drops, that
// instance is permanently unusable and every later call rejects with
// `CerastreamConnectionError("control connection is not open")`. Only a fresh
// `connect()` produces a usable client.
//
// That is the OPPOSITE of the rule the raw `active_encode` bridge follows
// (`active-passthrough.ts`): there the socket is a READER, so losing it says
// nothing about the session and its caches must age out instead of being wiped.
// Here the socket is the ONLY handle CeraUI has on the engine-side pipeline, and
// cerastream is systemd-owned — a dropped control connection means the process we
// were driving went away, and a restarted engine has no memory of the session.
// So a proven-dead control connection IS a session boundary and must retire the
// session. Confirmed live during Wave H: cerastream restarted mid-session, three
// `switchInput` calls rejected with `control connection is not open`, and nothing
// ever noticed — `is_streaming` stayed true, `reconcileRuntimeState()` kept
// re-affirming "streaming" from stale telemetry (it trusts `this.client !==
// undefined` as proof of a live session), and every later action failed until the
// whole backend process was restarted.
//
// `noteConnectionLoss()` is the one seam that acts on it: it drops the dead
// client + subscription + telemetry and hands off to `onSessionConnectionLost`,
// whose production wiring raises the existing `engine-crashed` indicator and
// retires the session through the orchestrator — so the device lands in a real
// `idle` and the NEXT `streaming.start` dials a fresh connection and succeeds.
// It is proven ONLY by a `CerastreamConnectionError` from the CURRENT session's
// client (never a guess, never an engine RPC error, never a timeout).

import { existsSync } from "node:fs";
import {
	CERASTREAM_BIN,
	type CerastreamClient,
	CerastreamConnectionError,
	CerastreamRpcError,
	CerastreamTimeoutError,
	type ChangeConfigParams,
	type ChangeConfigResult,
	type ConnectOptions,
	connect,
	DEFAULT_BALANCER,
	DEFAULT_CONFIG_PATH,
	DEFAULT_MAX_BITRATE,
	DEFAULT_MIN_BITRATE,
	DEFAULT_SRT_LATENCY,
	type EventParams,
	type ListDevicesParams,
	type ListDevicesResult,
	type PartialCerastreamConfig,
	type ReloadConfigParams,
	type ReloadConfigResult,
	type RuntimeErrorEvent,
	SCHEMA_VERSION,
	type StartParams,
	type Subscription,
	type SwitchAudioParams,
	type SwitchAudioResult,
	type SwitchInputParams,
	type SwitchInputResult,
	startParamsSchema,
	startResultSchema,
	switchAudioParamsSchema,
	switchAudioResultSchema,
	writeCerastreamConfig,
} from "@ceralive/cerastream";
import type {
	ActiveEncode,
	BufferingStatus,
	ConfigChangePhase,
	PreviewEncoderRealized,
} from "@ceraui/rpc/schemas";
import { toEngineResolution } from "@ceraui/rpc/schemas";
import { z } from "zod";
import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import { logger as defaultLogger } from "../../helpers/logger.ts";
import { ENGINE_STATE_RECONCILE_TIMEOUT } from "../../helpers/timing-constants.ts";
import { getConfig, saveConfig } from "../config.ts";
import { setup } from "../setup.ts";
import {
	notificationBroadcast,
	notificationExists,
	notificationRemove,
} from "../ui/notifications.ts";
import { type AudioMode, resolveAudioMode } from "./audio.ts";
import {
	clearSelectedCaptureDegraded,
	noteSelectedCaptureDegraded,
} from "./capture-degraded.ts";
import type { ResolvedCerastreamError } from "./cerastream-error-mapping.ts";
import { resolveCerastreamError } from "./cerastream-error-mapping.ts";
import { SRTLA_LISTEN_PORT } from "./constants.ts";
import { deviceRegistry } from "./devices.ts";
import { isEmbeddedAudioPipeline } from "./embedded-audio.ts";
import { validateBitrate } from "./encoder.ts";
import {
	createLaunchTransaction,
	type LaunchTransaction,
} from "./launch-transaction.ts";
import { asRawRequestClient } from "./raw-request.ts";
import { ENGINE_CLOSE_DEADLINE_MS } from "./start-lifecycle-timing.ts";
import type {
	BackendErrorListener,
	BitrateParams,
	EngineRuntimeState,
	EngineTelemetry,
	StreamingBackend,
	StreamRunOptions,
} from "./streaming-backend.ts";
import { PROCESS_ERROR_CODES } from "./streamloop/process-error-patterns.ts";

const CERASTREAM_PIPELINE_PATH = "/tmp/cerastream-pipeline.txt";

/**
 * Engine error codes a healthy session boundary PROVES are history. Membership
 * requires an engine-authored recovery signal that contradicts the error's own
 * claim — not merely that the error looks transient.
 */
const ENGINE_ERRORS_CLEARED_BY_HEALTHY_SESSION: ReadonlySet<string> = new Set([
	PROCESS_ERROR_CODES.CAPTURE_VIDEO_ERROR,
]);

/** The status/notification surface the backend bridges engine events onto. */
export interface CerastreamBridge {
	notify(
		name: string,
		type: "success" | "warning" | "error",
		msg: string,
		duration: number,
		isPersistent: boolean,
		isDismissable: boolean,
	): void;
	notificationExists(name: string): boolean;
	removeNotification(name: string): void;
	broadcastStatus(): void;
	broadcastBuffering(payload: BufferingStatus): void;
}

/** Minimal logger surface (winston satisfies it; tests pass a silent stub). */
export interface CerastreamLogger {
	debug(message: string, meta?: unknown): void;
	info(message: string, meta?: unknown): void;
	warn(message: string, meta?: unknown): void;
	error(message: string, meta?: unknown): void;
}

/** Injected collaborators; defaults wire the real CeraUI modules. */
export interface CerastreamBackendDeps {
	connect: (options?: ConnectOptions) => Promise<CerastreamClient>;
	connectOptions: ConnectOptions;
	getConfig: () => RuntimeConfig;
	saveConfig: () => void;
	bridge: CerastreamBridge;
	execPath: string;
	configPath: string;
	logger: CerastreamLogger;
	// Interim fallback for the active video input when the persisted
	// `config.selected_video_input` is absent; injected (not read from the
	// registry singleton directly) so the start assembly stays unit-testable.
	getActiveInput: () => string | undefined;
	// Task 13 embedded-audio gate: true when the pipeline routes embedded
	// (muxed) network-ingest audio AND the engine advertises it, so the start
	// assembly omits `audio.device` and the engine routes embedded audio.
	// Injected so the assembly stays unit-testable without global state.
	isEmbeddedAudioActive: (pipelineId: string | undefined) => boolean;
	scheduleTimeout: (
		callback: () => void,
		delayMs: number,
	) => ReturnType<typeof setTimeout>;
	cancelTimeout: (timer: ReturnType<typeof setTimeout>) => void;
	// Called at most ONCE per session, when the session's control connection is
	// PROVEN dead (see the module header). `site` names the call that found it.
	onSessionConnectionLost: (site: string) => void;
	onConfigChangePhase?: (event: {
		attemptId: string;
		phase: ConfigChangePhase;
		reason?: string;
	}) => void;
}

function defaultBridge(): CerastreamBridge {
	return {
		notify: notificationBroadcast,
		notificationExists: (name) => Boolean(notificationExists(name)),
		removeNotification: (name) => {
			notificationRemove(name);
		},
		broadcastStatus: () => {
			// Lazy import keeps the websocket/streaming graph out of this module's
			// import cycle; the nudge fires long after boot so a dynamic import is fine.
			void (async () => {
				try {
					const [
						{ broadcastMsg },
						{ getIsStreaming },
						{ getActiveEncodeStatus },
						{ getEngineBitrateStatus },
						{ getPreviewEncoderRealizedStatus },
					] = await Promise.all([
						import("../ui/websocket-server.ts"),
						import("./streaming.ts"),
						import("./active-encode-status.ts"),
						import("./engine-bitrate-status.ts"),
						import("./preview-encoder-status.ts"),
					]);
					// Explicit on every nudge, never by omission: the frontend status
					// merge deliberately preserves an omitted field, so a value pushed
					// only while it exists can be raised but never retracted — which
					// left a stopped session's encode on screen under a "Live" badge.
					// `engine_bitrate` rides the same nudge because the adaptive
					// controller's own `bitrate` event is what triggers it, so this is
					// the path by which a throttled rate reaches the operator live.
					// `preview_encoder_realized` rides it for the retraction half of
					// that same reason: its fallback text is the most misleading thing
					// on screen once the session it described is over.
					broadcastMsg("status", {
						is_streaming: getIsStreaming(),
						active_encode: getActiveEncodeStatus(),
						engine_bitrate: getEngineBitrateStatus(),
						preview_encoder_realized: getPreviewEncoderRealizedStatus(),
					});
				} catch (err) {
					defaultLogger.debug("cerastream: status broadcast skipped", { err });
				}
			})();
		},
		broadcastBuffering: (payload) => {
			void (async () => {
				try {
					const { broadcastMsg } = await import("../ui/websocket-server.ts");
					broadcastMsg("status", { buffering: payload });
				} catch (err) {
					defaultLogger.debug("cerastream: buffering broadcast skipped", {
						err,
					});
				}
			})();
		},
	};
}

/**
 * Read the additive store-and-forward fields off a cerastream `status` event
 * (cerastream Task 32). Returns `null` when the engine does not advertise
 * buffering (`buffering` absent) — the capability gate the UI honors so an older
 * engine renders no indicator. Numeric counters are read defensively so a partial
 * frame can never throw.
 */
export function extractBufferingStatus(event: unknown): BufferingStatus | null {
	if (event === null || typeof event !== "object") return null;
	const e = event as Record<string, unknown>;
	if (typeof e.buffering !== "boolean") return null;
	const spooled = e.spooled_bytes;
	const headroom = e.data_headroom_bytes;
	return {
		active: e.buffering,
		...(typeof spooled === "number" && Number.isFinite(spooled) && spooled >= 0
			? { spooled_bytes: spooled }
			: {}),
		...(typeof headroom === "number" &&
		Number.isFinite(headroom) &&
		headroom >= 0
			? { data_headroom_bytes: headroom }
			: {}),
		...(typeof e.disk_warning === "boolean"
			? { disk_warning: e.disk_warning }
			: {}),
	};
}

/**
 * Read the additive `active_encode` field off a cerastream `status` event
 * (cerastream Todo 10 `ActiveEncode`) — the RESOLVED runtime encode, not the
 * requested StartParams. Returns `null` when the engine does not report it
 * (`active_encode` absent/partial), so an older engine surfaces no field — the
 * same capability gate `extractBufferingStatus` applies. `codec`/`resolution`/
 * `framerate` are all required for a usable payload; `active_input`/`decoder`/
 * `input_codec` are optional. `input_codec` (cerastream T3) is the incoming
 * network-leg codec (`h264`/`h265`), present only for a network-ingest session on
 * a new-enough engine — defensively copied only when a string so an older engine
 * (field absent) simply omits it. Read defensively so a malformed frame can never
 * throw.
 */
export function extractActiveEncode(event: unknown): ActiveEncode | null {
	if (event === null || typeof event !== "object") return null;
	const ae = (event as Record<string, unknown>).active_encode;
	if (ae === null || typeof ae !== "object") return null;
	const a = ae as Record<string, unknown>;
	if (
		typeof a.codec !== "string" ||
		typeof a.resolution !== "string" ||
		typeof a.framerate !== "number" ||
		!Number.isFinite(a.framerate)
	) {
		return null;
	}
	return {
		codec: a.codec,
		resolution: a.resolution,
		framerate: a.framerate,
		...(typeof a.active_input === "string"
			? { active_input: a.active_input }
			: {}),
		...(typeof a.decoder === "string" ? { decoder: a.decoder } : {}),
		...(typeof a.input_codec === "string"
			? { input_codec: a.input_codec }
			: {}),
		...(typeof a.passthrough === "boolean"
			? { passthrough: a.passthrough }
			: {}),
	};
}

/**
 * Read the additive `preview_encoder_realized` field off a cerastream `status`
 * event (cerastream 2026.7.6) — what the LIVE session's PREVIEW branch is
 * actually encoding with, a sibling of `active_encode` rather than a part of it.
 * Returns `null` when the engine does not report it, which is the normal case for
 * a session with no preview branch as well as for a pre-2026.7.6 engine — the
 * same capability gate `extractActiveEncode` applies.
 *
 * `realized_element` and `mode` are both required for a usable payload, and a
 * `mode` outside the known pair is refused outright: a half-read pair would be
 * indistinguishable from a genuine software realization, which is exactly the
 * confusion the four-readings rule exists to prevent. `fallback_reason` is copied
 * only when its discriminant is one the UI can render, and `property-failure`
 * additionally requires the refused `property` it must name.
 */
export function extractPreviewEncoderRealized(
	event: unknown,
): PreviewEncoderRealized | null {
	if (event === null || typeof event !== "object") return null;
	const raw = (event as Record<string, unknown>).preview_encoder_realized;
	if (raw === null || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.realized_element !== "string") return null;
	if (r.mode !== "software" && r.mode !== "hardware") return null;
	return {
		realized_element: r.realized_element,
		mode: r.mode,
		...(typeof r.selected_element === "string"
			? { selected_element: r.selected_element }
			: {}),
		...spreadFallbackReason(r.fallback_reason),
	};
}

function spreadFallbackReason(raw: unknown): {
	fallback_reason?: PreviewEncoderRealized["fallback_reason"];
} {
	if (raw === null || typeof raw !== "object") return {};
	const reason = raw as Record<string, unknown>;
	if (reason.code === "factory-missing") {
		return { fallback_reason: { code: "factory-missing" } };
	}
	if (
		reason.code === "property-failure" &&
		typeof reason.property === "string"
	) {
		return {
			fallback_reason: {
				code: "property-failure",
				property: reason.property,
			},
		};
	}
	return {};
}

/**
 * The engine's `reload-config` `audio.delay_ms_signed` field is a 0.4.0 addition
 * — a ≥0.4.0 engine takes the SIGNED value verbatim; an older engine only
 * understands the legacy unsigned `delay_ms`. Parses "MAJOR.MINOR[.PATCH]"; an
 * absent/unparseable version is fail-safe `false` (route to the legacy path).
 */
export function supportsSignedReloadDelay(
	schemaVersion: string | undefined,
): boolean {
	if (!schemaVersion) return false;
	const [major, minor] = schemaVersion.split(".").map(Number);
	if (major === undefined || Number.isNaN(major) || Number.isNaN(minor))
		return false;
	return major > 0 || (major === 0 && (minor ?? 0) >= 4);
}

/**
 * Whether the engine understands the additive `audio.mode` discriminator
 * (schema ≥ 0.6.0). The published `@ceralive/cerastream` client Zod-STRIPS the
 * unknown `mode` field, so a supporting engine must be driven through the raw
 * `start` bridge below; an older engine is sent the typed (mode-less) params and
 * falls back to its legacy device inference. Fail-safe `false` on an
 * absent/unparseable version.
 */
export function supportsAudioMode(schemaVersion: string | undefined): boolean {
	if (!schemaVersion) return false;
	const [major, minor] = schemaVersion.split(".").map(Number);
	if (major === undefined || Number.isNaN(major) || Number.isNaN(minor))
		return false;
	return major > 0 || (major === 0 && (minor ?? 0) >= 6);
}

/**
 * Whether the engine understands the additive `video_passthrough` start field
 * (schema ≥ 0.5.0, cerastream Todo 16). Like `audio.mode`, the published client
 * strips the unknown field, so a supporting engine is driven through the raw
 * `start` bridge. Fail-safe `false` on an absent/unparseable version.
 */
export function supportsVideoPassthrough(
	schemaVersion: string | undefined,
): boolean {
	if (!schemaVersion) return false;
	const [major, minor] = schemaVersion.split(".").map(Number);
	if (major === undefined || Number.isNaN(major) || Number.isNaN(minor))
		return false;
	return major > 0 || (major === 0 && (minor ?? 0) >= 5);
}

/**
 * Whether the engine understands the additive `reload-config`
 * `audio.meter_device` field (schema ≥ 0.9.0) — the operator's audio-source pick
 * threaded down to the ALWAYS-IDLE level meter. Like `audio.mode`, the published
 * client Zod-STRIPS the unknown field, so a supporting engine must be driven
 * through the raw `reload-config` bridge. Fail-safe `false` on an
 * absent/unparseable version: an older engine keeps its own auto-pick, which is
 * exactly the pre-0.9.0 behaviour.
 */
export function supportsMeterDevicePreference(
	schemaVersion: string | undefined,
): boolean {
	if (!schemaVersion) return false;
	const [major, minor] = schemaVersion.split(".").map(Number);
	if (major === undefined || Number.isNaN(major) || Number.isNaN(minor))
		return false;
	return major > 0 || (major === 0 && (minor ?? 0) >= 9);
}

// Local schema extension for the raw `start` bridge: the published client's
// frozen `startParamsSchema` has no `audio.mode` or `video_passthrough`, so a
// start carrying either is validated here and dispatched over the raw JSON-RPC
// primitive (no npm publish).
const audioModeSchema = z.enum(["none", "default", "device"]);
const videoPassthroughRawSchema = z.enum(["auto", "force", "off"]);
export const startParamsWithAudioModeSchema = startParamsSchema.extend({
	audio: z
		.object({
			mode: audioModeSchema.optional(),
			device: z.string().optional(),
			codec: z.string().optional(),
			delay_ms: z.number().int().optional(),
		})
		.optional(),
	video_passthrough: videoPassthroughRawSchema.optional(),
});
export type StartParamsWithAudioMode = z.infer<
	typeof startParamsWithAudioModeSchema
>;

/**
 * Production reaction to a proven-dead session control connection: raise the
 * existing `engine-crashed` indicator, then retire the session through its single
 * owner (the orchestrator) so the device lands in a real `idle`.
 *
 * Order is load-bearing — `reportEngineState` is gated on `isStreaming` inside
 * the reporter, so it has to run BEFORE the stop clears that flag or the operator
 * is never told why their stream ended.
 *
 * Fire-and-forget by design: this runs from inside a rejected RPC's catch, and a
 * teardown failure must never replace the error the caller is already handling.
 * Imports are dynamic to keep the session/lifecycle graph off this module's load
 * path (same posture as `defaultBridge`).
 */
function defaultOnConfigChangePhase(event: {
	attemptId: string;
	phase: ConfigChangePhase;
	reason?: string;
}): void {
	void import("./stream-session-orchestrator.ts")
		.then(({ noteStreamSessionConfigChangePhase }) => {
			noteStreamSessionConfigChangePhase(event);
		})
		.catch((err: unknown) => {
			defaultLogger.error("cerastream: could not route a config-change phase", {
				event,
				err,
			});
		});
}

function defaultOnSessionConnectionLost(site: string): void {
	void (async () => {
		try {
			const [{ stopStreamSession }, { reportEngineState }, { getIsStreaming }] =
				await Promise.all([
					import("./stream-session-orchestrator.ts"),
					import("./lifecycle-indicators.ts"),
					import("./streaming.ts"),
				]);
			reportEngineState({ isStreaming: getIsStreaming(), reachable: false });
			// `engine_loss` is what keeps this path distinguishable from an operator
			// Stop, which reaches the very same `stopStreamSession`. The cause is
			// the ONLY thing that tells the armed-stream marker to survive.
			const stopped = await stopStreamSession("engine_loss");
			defaultLogger.warn(
				"cerastream: engine session retired after a control-connection loss",
				{ site, stop: stopped.result },
			);
			// The engine-loss retirement IS the reconnect event for a SIGKILLed
			// engine: the reconnect loop settled at boot and never re-arms, so
			// nothing else notices systemd bringing cerastream back. The run polls
			// for an authoritative runtime state and is self-serialising, so a
			// second loss cannot start a second one.
			const { runStreamRestoration } = await import("./stream-restoration.ts");
			void runStreamRestoration();
		} catch (err) {
			defaultLogger.error(
				"cerastream: could not retire the session after a control-connection loss",
				{ site, err },
			);
		}
	})();
}

function defaultCerastreamBackendDeps(): CerastreamBackendDeps {
	return {
		connect,
		connectOptions: setup.cerastream_socket
			? { socketPath: setup.cerastream_socket }
			: {},
		getConfig,
		saveConfig,
		bridge: defaultBridge(),
		execPath: setup.cerastream_path ?? CERASTREAM_BIN,
		configPath: DEFAULT_CONFIG_PATH,
		logger: defaultLogger,
		getActiveInput: () => deviceRegistry.getActiveInput(),
		isEmbeddedAudioActive: isEmbeddedAudioPipeline,
		scheduleTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
		cancelTimeout: (timer) => clearTimeout(timer),
		onSessionConnectionLost: defaultOnSessionConnectionLost,
		onConfigChangePhase: defaultOnConfigChangePhase,
	};
}

function classifyRuntimeState(
	state: unknown,
	streaming: unknown,
): EngineRuntimeState {
	if (state === "streaming" && streaming) return "streaming";
	if (state === "idle" && !streaming) return "idle";
	return "unknown";
}

/**
 * Outcome of a startup `hello` handshake against the engine. The protocol MAJOR
 * is the hard compatibility contract (the engine rejects a mismatched major and
 * the client's `helloResultSchema` is a literal); `schema_version` differences
 * within a major are additive-only and informational (ADR-0002 §4).
 */
export type EngineProbeStatus =
	| "compatible"
	| "protocol_incompatible"
	| "unreachable"
	| "error";

export interface EngineProbe {
	status: EngineProbeStatus;
	protocol?: string;
	engineVersion?: string;
	schemaVersion?: string;
	detail?: string;
}

function probeErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** A ZodError raised inside the bindings' own bundled Zod copy (cross-instance
 * `instanceof` is unreliable, so match by name) means the engine returned a
 * hello shape the frozen literal schema rejected — a protocol mismatch. */
function isZodLikeError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { name?: string }).name === "ZodError"
	);
}

export function classifyConnectHandshakePhase(
	error: unknown,
): "connect" | "hello" {
	if (
		error instanceof CerastreamTimeoutError ||
		error instanceof CerastreamRpcError ||
		isZodLikeError(error)
	) {
		return "hello";
	}
	return "connect";
}

/** Classify a failed `connect()`/handshake into an {@link EngineProbe}. */
export function classifyEngineProbeError(err: unknown): EngineProbe {
	if (err instanceof CerastreamRpcError) {
		if (
			err.dataCode === "cerastream.protocol.unsupported_version" ||
			err.code === -32000
		) {
			return { status: "protocol_incompatible", detail: err.message };
		}
		return { status: "error", detail: err.message };
	}
	if (isZodLikeError(err)) {
		return {
			status: "protocol_incompatible",
			detail: "engine returned an unexpected hello shape",
		};
	}
	if (
		err instanceof CerastreamConnectionError ||
		err instanceof CerastreamTimeoutError
	) {
		return { status: "unreachable", detail: probeErrorMessage(err) };
	}
	return { status: "error", detail: probeErrorMessage(err) };
}

export class CerastreamBackend implements StreamingBackend {
	private readonly deps: CerastreamBackendDeps;
	private readonly errorListeners: Array<BackendErrorListener> = [];

	private client: CerastreamClient | undefined;
	private subscription: Subscription | undefined;
	private active = false;
	private telemetry: EngineTelemetry | null = null;
	// The engine error currently occupying the shared `cerastream` notification
	// slot. Tracked because that slot is shared by every non-srtla engine error,
	// so a blind remove-by-name would retract whichever error happens to be
	// standing rather than the one the recovery signal actually falsifies.
	private standingEngineError: ResolvedCerastreamError | undefined;
	// Serializes non-stop IPC ops; stop interrupts a pending start through its client.
	private queue: Promise<void> = Promise.resolve();
	private interrupt: Promise<void> = Promise.resolve();

	constructor(deps: Partial<CerastreamBackendDeps> = {}) {
		this.deps = { ...defaultCerastreamBackendDeps(), ...deps };
	}

	get execPath(): string {
		return this.deps.execPath;
	}

	get tempPipelinePath(): string {
		return CERASTREAM_PIPELINE_PATH;
	}

	get configPath(): string {
		return this.deps.configPath;
	}

	configExists(): boolean {
		return existsSync(this.deps.configPath);
	}

	writeConfig(config: RuntimeConfig): string {
		const path = this.deps.configPath;
		try {
			writeCerastreamConfig(this.toEngineConfig(config), path);
		} catch (err) {
			// The engine owns its on-device config dir; CeraUI persists best-effort.
			this.deps.logger.debug("cerastream: writeConfig best-effort failed", {
				err,
			});
		}
		return path;
	}

	buildRunArgs(config: RuntimeConfig, _opts: StreamRunOptions): Array<string> {
		// Vestigial on this engine: cerastream is systemd-owned and driven over IPC,
		// never by argv. Persist the config for parity and return a nominal argv.
		this.writeConfig(config);
		return ["--config", this.deps.configPath];
	}

	async start(
		config: RuntimeConfig,
		opts: StreamRunOptions,
		transaction?: LaunchTransaction,
	): Promise<void> {
		this.active = true;
		this.clearRecoveredEngineError();
		const params = this.buildStartParams(config, opts);
		const launchTransaction =
			transaction ?? createLaunchTransaction("backend-start");
		try {
			await this.enqueue(async () => {
				let confirmStreaming: (() => void) | undefined;
				const streamingStatus = new Promise<void>((resolve) => {
					confirmStreaming = resolve;
				});
				const client = await launchTransaction.acquirePhase(
					"connect",
					() => this.deps.connect(this.deps.connectOptions),
					(client) => client.close(),
					classifyConnectHandshakePhase,
				);
				this.client = client;
				const subscription = await launchTransaction.acquirePhase(
					"subscribe",
					() =>
						client.subscribeEvents({}, (event) => {
							this.handleEvent(event);
							if (
								event.type === "status" &&
								classifyRuntimeState(event.state, event.streaming) ===
									"streaming"
							) {
								confirmStreaming?.();
							}
						}),
					(subscription) => subscription.close(),
				);
				this.subscription = subscription;
				launchTransaction.register(async () => {
					try {
						await client.stop();
					} catch (error) {
						this.deps.logger.debug(
							"cerastream: rollback stop best-effort failed",
							{
								error,
							},
						);
					}
				});
				const result = await launchTransaction.runPhase("start-rpc", () =>
					this.dispatchStart(client, params),
				);
				await launchTransaction.runPhase("playing-wait", async () => {
					const parsed = startResultSchema.parse(result);
					if (parsed.state !== "streaming") await streamingStatus;
				});
			}, "start");
		} catch (error) {
			await launchTransaction.rollback();
			this.active = false;
			this.client = undefined;
			this.subscription = undefined;
			throw error;
		}
	}

	// Send `start` so `audio.mode` / `video_passthrough` survive: an engine that
	// understands either is driven through the raw JSON-RPC primitive (the typed
	// client Zod-strips both unknown fields); an older engine gets the typed call
	// and its legacy inference.
	private async dispatchStart(
		client: CerastreamClient,
		params: StartParamsWithAudioMode,
	): Promise<unknown> {
		const version = client.hello.schema_version;
		if (supportsAudioMode(version) || supportsVideoPassthrough(version)) {
			return asRawRequestClient(client, "start").rawRequest("start", params);
		}
		return client.start(params as StartParams);
	}

	// A close that never answers is no more informative than one that rejects —
	// which this path already treats as "proceed" — so bound it and let the stop
	// complete either way rather than stranding the session.
	private closeWithinDeadline(
		client: CerastreamClient | undefined,
	): Promise<void> {
		if (client === undefined) return Promise.resolve();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const bound = new Promise<void>((resolve) => {
			timer = this.deps.scheduleTimeout(() => {
				this.deps.logger.warn(
					"cerastream: the engine did not close its control socket within the bound; completing the stop anyway",
					{ deadlineMs: ENGINE_CLOSE_DEADLINE_MS },
				);
				resolve();
			}, ENGINE_CLOSE_DEADLINE_MS);
		});
		return Promise.race([client.close(), bound]).finally(() => {
			if (timer !== undefined) this.deps.cancelTimeout(timer);
		});
	}

	stop(onStopped: () => void): boolean {
		if (!this.active) return false;
		this.active = false;
		// A crashed or already-gone engine sends no final idle status, so the
		// stop itself has to be the clearing signal.
		this.clearSessionScopedTelemetry();
		// Same rule, same reason: a `capture_video_error` is a claim about ONE
		// session, and this ends it. Routed through the one clearing seam so the
		// snapshot and the notification can never disagree about whether the
		// session's failure is still current.
		this.clearRecoveredEngineError();
		const client = this.client;
		const subscription = this.subscription;
		const operation = (async () => {
			subscription?.close();
			void client?.stop().catch((error) => {
				this.deps.logger.debug("cerastream: stop request interrupted", {
					error,
				});
			});
			try {
				await this.closeWithinDeadline(client);
			} catch {
				// already closing
			} finally {
				if (this.client === client) this.client = undefined;
				if (this.subscription === subscription) this.subscription = undefined;
				onStopped();
			}
		})();
		this.interrupt = operation.catch((error) =>
			this.handleOpFailure("stop", error),
		);
		return true;
	}

	setBitrate(params: BitrateParams): number | undefined {
		const maxBr = validateBitrate(params);
		if (maxBr === undefined) return undefined;

		const config = this.deps.getConfig();
		const previous = config.max_br;
		try {
			config.max_br = maxBr;
			this.deps.saveConfig();
			const client = this.client;
			if (client) {
				void this.enqueue(
					() => client.setBitrate({ max_bitrate: maxBr }).then(() => undefined),
					"set-bitrate",
				);
			}
			return maxBr;
		} catch (err) {
			config.max_br = previous;
			this.deps.logger.error("cerastream: failed to set bitrate", { err });
			throw err;
		}
	}

	reloadConfig(): void {
		const client = this.client;
		if (!client) return;
		const params = this.toReloadParams(
			this.deps.getConfig(),
			client.hello.schema_version,
		);
		void this.enqueue(
			() => client.reloadConfig(params).then(() => undefined),
			"reload-config",
		);
	}

	onError(listener: BackendErrorListener): void {
		this.errorListeners.push(listener);
	}

	getTelemetry(): EngineTelemetry | null {
		return this.telemetry;
	}

	// `active_encode`, `bitrate` and `preview_encoder_realized` all describe a LIVE
	// session — what the engine is encoding, the rate its adaptive controller
	// settled on, and what the preview branch realized. None may outlive the
	// session: a retained `bitrate` renders a stopped stream under a live-looking
	// rate exactly as a retained `active_encode` renders it under a "Live" badge,
	// and a retained realized pair leaves a fallback reason on screen explaining a
	// stream that is no longer running.
	private clearSessionScopedTelemetry(): void {
		const previous = this.telemetry;
		if (previous === null) return;
		if (
			previous.active_encode === undefined &&
			previous.bitrate === undefined &&
			previous.preview_encoder_realized === undefined
		)
			return;
		const next = { ...previous };
		delete next.active_encode;
		delete next.bitrate;
		delete next.preview_encoder_realized;
		this.telemetry = next;
		this.deps.bridge.broadcastStatus();
	}

	async reconcileRuntimeState(): Promise<EngineRuntimeState> {
		const existing = this.telemetry;
		if (existing !== null && this.client !== undefined) {
			return classifyRuntimeState(existing.state, existing.streaming);
		}

		let client: CerastreamClient | undefined;
		let subscription: Subscription | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let acceptingEvents = true;
		try {
			client = await this.deps.connect({
				...this.deps.connectOptions,
				autoReconnect: false,
				requestTimeoutMs: ENGINE_STATE_RECONCILE_TIMEOUT,
			});
			let resolveRuntimeState:
				| ((runtimeState: EngineRuntimeState) => void)
				| undefined;
			const runtimeStateEvent = new Promise<EngineRuntimeState>((resolve) => {
				resolveRuntimeState = resolve;
			});
			subscription = await client.subscribeEvents(
				{ topics: ["status"] },
				(event) => {
					if (!acceptingEvents) return;
					this.handleEvent(event);
					if (event.type === "status") {
						resolveRuntimeState?.(
							classifyRuntimeState(event.state, event.streaming),
						);
					}
				},
			);
			timer = this.deps.scheduleTimeout(
				() => resolveRuntimeState?.("idle"),
				ENGINE_STATE_RECONCILE_TIMEOUT,
			);
			const runtimeState = await runtimeStateEvent;
			acceptingEvents = false;
			if (runtimeState === "streaming") {
				this.client = client;
				this.subscription = subscription;
				this.active = true;
				return runtimeState;
			}
			subscription?.close();
			await client.close();
			return runtimeState;
		} catch (error) {
			acceptingEvents = false;
			subscription?.close();
			await client?.close();
			this.deps.logger.debug("cerastream: runtime-state query unresolved", {
				error,
			});
			return "unknown";
		} finally {
			if (timer !== undefined) this.deps.cancelTimeout(timer);
		}
	}

	/**
	 * Connect, run the `hello` handshake, and disconnect — a cheap startup probe
	 * of engine compatibility independent of any stream. The engine is a
	 * systemd-owned service, so `close()` only drops our connection; it never
	 * spawns or stops the engine. A protocol-major mismatch surfaces here as
	 * `protocol_incompatible` instead of waiting for the first stream to fail.
	 */
	async probeEngine(): Promise<EngineProbe> {
		let client: CerastreamClient | undefined;
		try {
			client = await this.deps.connect(this.deps.connectOptions);
			const hello = client.hello;
			if (hello.schema_version !== SCHEMA_VERSION) {
				this.deps.logger.warn(
					"cerastream: engine schema_version differs from bindings (additive-only, informational)",
					{ engine: hello.schema_version, bindings: SCHEMA_VERSION },
				);
			}
			return {
				status: "compatible",
				protocol: hello.protocol,
				engineVersion: hello.engine_version,
				schemaVersion: hello.schema_version,
			};
		} catch (err) {
			return classifyEngineProbeError(err);
		} finally {
			try {
				await client?.close();
			} catch {
				// Best-effort disconnect of a probe connection; never respawns the engine.
			}
		}
	}

	// ---- additive cerastream-only RPC passthroughs (NOT on the frozen seam) ----

	async switchInput(params: SwitchInputParams): Promise<SwitchInputResult> {
		return this.withSessionClient("switch-input", (client) =>
			client.switchInput(params),
		);
	}

	async listDevices(params?: ListDevicesParams): Promise<ListDevicesResult> {
		return this.withSessionClient("list-devices", (client) =>
			client.listDevices(params),
		);
	}

	async changeConfig(params: ChangeConfigParams): Promise<ChangeConfigResult> {
		return this.withSessionClient("change-config", (client) =>
			client.changeConfig(params),
		);
	}

	/**
	 * Device snapshot for the device registry (Todo 17). Returns the engine's
	 * `list-devices` result ONLY while a control client is live (a stream session
	 * holds the connection); returns `null` when idle so the registry falls back
	 * to its local v4l2 scan. Never opens a connection of its own — no per-poll
	 * connect churn — and never throws (a failed call degrades to `null`).
	 */
	async listDevicesIfActive(): Promise<ListDevicesResult | null> {
		const client = this.client;
		if (!client) return null;
		try {
			return await client.listDevices();
		} catch (err) {
			this.deps.logger.debug("cerastream: registry listDevices failed", {
				err,
			});
			// `devices.ts` re-polls this every couple of seconds for the whole
			// session, so it is the first call to touch a dead control connection —
			// which makes detection proactive with no watchdog timer to mis-fire.
			this.noteConnectionLoss(client, err, "list-devices-poll");
			return null;
		}
	}

	// `switch-audio` is an additive Phase-1.5 method kept OUT of the binding's
	// frozen V1 `requestSchemas`, so the typed client exposes no `switchAudio()`.
	// Dispatch it through the client's raw JSON-RPC primitive, validating both
	// ends with the bindings' exported schemas so the call stays contract-safe.
	async switchAudio(params: SwitchAudioParams): Promise<SwitchAudioResult> {
		const parsed = switchAudioParamsSchema.parse(params);
		const raw = await this.withSessionClient("switch-audio", (client) =>
			asRawRequestClient(client, "switch-audio").rawRequest(
				"switch-audio",
				parsed,
			),
		);
		return switchAudioResultSchema.parse(raw);
	}

	async reloadAudioDelay(delayMs: number): Promise<ReloadConfigResult> {
		return this.withSessionClient("reload-audio-delay", (client) => {
			if (supportsSignedReloadDelay(client.hello.schema_version)) {
				return client.reloadConfig({ audio: { delay_ms_signed: delayMs } });
			}
			const applied = Math.max(0, delayMs);
			this.deps.logger.info(
				"cerastream: engine schema_version < 0.4.0 — sending legacy unsigned audio.delay_ms (clamped to >= 0)",
				{
					schemaVersion: client.hello.schema_version,
					requested: delayMs,
					applied,
				},
			);
			return client.reloadConfig({ audio: { delay_ms: applied } });
		});
	}

	/** Test seam: resolve once every queued IPC op has settled. */
	async settle(): Promise<void> {
		await Promise.all([this.queue, this.interrupt]);
	}

	/** Bridge one engine event onto notifications / telemetry / status. */
	handleEvent(event: EventParams): void {
		switch (event.type) {
			case "error":
				this.handleErrorEvent(event);
				break;
			case "srt-stats":
				this.telemetry = {
					...this.telemetry,
					srt: {
						rtt_ms: event.rtt_ms,
						send_buffer: event.send_buffer,
						pkt_loss: event.pkt_loss,
					},
				};
				this.deps.bridge.broadcastStatus();
				break;
			case "bitrate":
				this.telemetry = {
					...this.telemetry,
					bitrate: { current: event.current_bitrate, max: event.max_bitrate },
				};
				this.deps.bridge.broadcastStatus();
				break;
			case "status": {
				if (
					classifyRuntimeState(event.state, event.streaming) === "streaming"
				) {
					this.clearRecoveredEngineError();
				}
				const buffering = extractBufferingStatus(event);
				const activeEncode = extractActiveEncode(event);
				// A partial mid-stream frame keeps the last known encode, but an
				// engine reporting it is NOT streaming cannot have a live one — so
				// that retention stops at the session boundary instead of outliving it.
				const retainedEncode = event.streaming
					? this.telemetry?.active_encode
					: undefined;
				const nextEncode = activeEncode ?? retainedEncode;
				// The adaptive bitrate reading is session-scoped for the same reason:
				// the engine sends no farewell `bitrate` event, so an idle status frame
				// is the only signal that the last applied rate is now history.
				const nextBitrate = event.streaming
					? this.telemetry?.bitrate
					: undefined;
				// The realized preview encoder follows `active_encode` exactly: kept
				// across a partial mid-stream frame, retired the moment the engine says
				// it is not streaming — so a fallback reason never explains a stream
				// that has already stopped.
				const realizedPreview = extractPreviewEncoderRealized(event);
				const retainedPreview = event.streaming
					? this.telemetry?.preview_encoder_realized
					: undefined;
				const nextPreview = realizedPreview ?? retainedPreview;
				const carried = { ...this.telemetry };
				delete carried.active_encode;
				delete carried.bitrate;
				delete carried.preview_encoder_realized;
				this.telemetry = {
					...carried,
					state: event.state,
					streaming: event.streaming,
					...(event.active_input ? { active_input: event.active_input } : {}),
					...(buffering ? { buffering } : {}),
					...(nextEncode ? { active_encode: nextEncode } : {}),
					...(nextBitrate ? { bitrate: nextBitrate } : {}),
					...(nextPreview ? { preview_encoder_realized: nextPreview } : {}),
				};
				this.deps.bridge.broadcastStatus();
				if (buffering) this.deps.bridge.broadcastBuffering(buffering);
				break;
			}
			case "switch":
				this.telemetry = {
					...this.telemetry,
					active_input: event.active_input,
				};
				this.deps.bridge.broadcastStatus();
				break;
			case "device":
				this.deps.bridge.broadcastStatus();
				break;
			case "config-change":
				// The BUS, not the RPC reply, is what settles a transaction whose
				// engine escalates and exits: the reply then rejects on a dead socket
				// and would otherwise leave the UI stuck in `applying`.
				this.deps.onConfigChangePhase?.({
					attemptId: event.attempt_id,
					phase: event.phase,
					...(event.reason === undefined ? {} : { reason: event.reason }),
				});
				break;
			case "preview":
				break;
		}
	}

	private handleErrorEvent(event: RuntimeErrorEvent): void {
		this.noteDegradedSelectedCapture(event);
		const resolved = resolveCerastreamError(
			event.code,
			event.source,
			event.reason,
		);
		const suppressed =
			resolved.suppressIfSrtlaNotified &&
			this.deps.bridge.notificationExists("srtla");
		if (!suppressed) {
			this.deps.bridge.notify(
				resolved.channel,
				"error",
				resolved.message,
				5,
				true,
				true,
			);
			this.standingEngineError = resolved;
		}

		const raw = `cerastream ${event.source} error [${event.code}]${
			event.reason ? `: ${event.reason}` : ""
		}`;
		for (const listener of this.errorListeners) listener(raw);
	}

	/**
	 * Retract a standing engine error the current session boundary falsifies.
	 *
	 * `capture_video_error` claims the capture card failed and that no restart is
	 * scheduled — a claim about ONE session. Two engine-authored events prove it is
	 * history, and neither is a timer: a concordant `streaming` status frame (the
	 * engine is delivering video right now), and the start of a NEW session (which
	 * must not inherit the previous one's failure — the same session-boundary rule
	 * `active_encode` follows). Codes whose recovery signal has not been
	 * established are deliberately absent from the table and stay latched.
	 */
	private clearRecoveredEngineError(): void {
		// The degraded-selected snapshot describes the SAME session this boundary
		// falsifies, so it retracts HERE and nowhere else — it deliberately has no
		// clearing path of its own to drift from this one. It is dropped ahead of
		// the standing-error gate rather than behind it because the `cerastream`
		// notification slot is SHARED: a later unrelated error occupying it would
		// otherwise return early and latch a capture claim the boundary disproved.
		clearSelectedCaptureDegraded();
		const standing = this.standingEngineError;
		if (standing === undefined) return;
		if (!ENGINE_ERRORS_CLEARED_BY_HEALTHY_SESSION.has(standing.code)) return;
		this.standingEngineError = undefined;
		this.deps.bridge.removeNotification(standing.channel);
	}

	/**
	 * Record that the OPERATOR'S OWN selected capture leg came up degraded.
	 *
	 * `capture_degraded` is not a wire event: cerastream reports this as the
	 * EXISTING `capture_video_error` additionally carrying `selected: true`, so
	 * that pair is the whole signal and no other code may raise it. Scoping it to
	 * the one code in {@link ENGINE_ERRORS_CLEARED_BY_HEALTHY_SESSION} is what
	 * makes the retraction above sufficient — a code with no established recovery
	 * signal would latch forever.
	 */
	private noteDegradedSelectedCapture(event: RuntimeErrorEvent): void {
		if (event.code !== PROCESS_ERROR_CODES.CAPTURE_VIDEO_ERROR) return;
		if (event.selected !== true) return;
		const config = this.deps.getConfig();
		noteSelectedCaptureDegraded({
			sourceId: config.selected_video_input ?? config.source,
			stableId: config.source_stable_id,
			state: {
				code: event.code,
				...(event.reason === undefined ? {} : { reason: event.reason }),
			},
		});
	}

	private enqueue(op: () => Promise<void>, label: string): Promise<void> {
		const operation = this.queue.then(op);
		this.queue = operation.catch((err) => this.handleOpFailure(label, err));
		return operation;
	}

	private handleOpFailure(label: string, err: unknown): void {
		this.deps.logger.error(`cerastream: ${label} failed`, { err });
		if (label === "start") {
			this.active = false;
			this.client = undefined;
			this.subscription = undefined;
			return;
		}
		this.noteConnectionLoss(this.client, err, label);
	}

	/**
	 * Run one session-scoped RPC and, when it fails because the control
	 * connection is gone, retire the session before re-throwing. The caller still
	 * sees its original error — this only adds the state change that was missing.
	 */
	private async withSessionClient<Result>(
		site: string,
		op: (client: CerastreamClient) => Promise<Result>,
	): Promise<Result> {
		const client = this.requireClient();
		try {
			return await op(client);
		} catch (error) {
			this.noteConnectionLoss(client, error, site);
			throw error;
		}
	}

	/**
	 * Act on PROOF that the session's control connection is dead — a
	 * `CerastreamConnectionError` raised by the client we are still holding for a
	 * session we still believe is active. Anything else (an engine RPC error, a
	 * request timeout, a rejection from an already-superseded client, a rejection
	 * during our own `stop()`) is deliberately NOT proof and is ignored.
	 *
	 * The dead client is dropped FIRST: `this.client !== undefined` is what
	 * `reconcileRuntimeState()` trusts as evidence of a live session, so leaving
	 * it in place is exactly how a phantom "streaming" state kept re-affirming
	 * itself from stale telemetry. Dropping it also makes the next reconcile do a
	 * real probe, and makes every later session call fail fast and loudly instead
	 * of re-dispatching onto a socket that will never answer.
	 *
	 * `active` is deliberately LEFT SET so `stop()` still recognises the session
	 * it has to tear down (srtla_send is still running and still sending nothing).
	 */
	private noteConnectionLoss(
		client: CerastreamClient | undefined,
		error: unknown,
		site: string,
	): void {
		if (!(error instanceof CerastreamConnectionError)) return;
		if (client === undefined || client !== this.client) return;
		if (!this.active) return;

		this.deps.logger.error(
			"cerastream: session control connection lost; retiring the engine session",
			{ site, code: error.code, message: error.message },
		);

		try {
			this.subscription?.close();
		} catch {
			// The subscription rides the same dead socket; closing it is best-effort.
		}
		this.subscription = undefined;
		this.client = undefined;
		this.telemetry = null;
		this.deps.bridge.broadcastStatus();
		this.deps.onSessionConnectionLost(site);
	}

	/**
	 * Encode/input/audio fields forwarded identically to `start` and the
	 * persisted engine config. The spread idiom OMITS absent fields (never sends
	 * `{ key: undefined }`); resolution is mapped to the engine's "WxH" pixel
	 * form (a UI token is never sent); `config.delay` rides `audio.delay_ms`
	 * signed-verbatim (clamping is engine-side only, never on this path).
	 */
	private encodeInputAudioFields(
		config: RuntimeConfig,
		pipelineId: string | undefined,
	): {
		input_id?: string;
		codec?: "h264" | "h265";
		resolution?: string;
		framerate?: number;
		video_passthrough?: "auto" | "force" | "off";
		audio?: {
			mode?: AudioMode;
			device?: string;
			codec?: string;
			delay_ms?: number;
		};
	} {
		const inputId = config.selected_video_input ?? this.deps.getActiveInput();
		// The operator's audio pick maps onto the engine's `audio.mode`
		// discriminator (never a pseudo-source string leaked into `audio.device`):
		// "No audio" ⇒ none, "Pipeline default" / a network-embedded source ⇒
		// default, a real device ⇒ device + its ALSA id. An absent `asrc` omits the
		// section entirely (the engine's legacy inference, compat-preserved).
		const selection =
			config.asrc !== undefined
				? resolveAudioMode(
						config.asrc,
						this.deps.isEmbeddedAudioActive(pipelineId),
					)
				: undefined;
		const audio = {
			...(selection !== undefined ? { mode: selection.mode } : {}),
			...(selection?.device !== undefined ? { device: selection.device } : {}),
			...(config.acodec !== undefined ? { codec: config.acodec } : {}),
			...(config.delay !== undefined ? { delay_ms: config.delay } : {}),
		};
		return {
			...(inputId !== undefined ? { input_id: inputId } : {}),
			...(config.video_codec !== undefined
				? { codec: config.video_codec }
				: {}),
			...(config.video_passthrough !== undefined
				? { video_passthrough: config.video_passthrough }
				: {}),
			...(config.resolution !== undefined
				? { resolution: toEngineResolution(config.resolution) }
				: {}),
			...(config.framerate !== undefined
				? { framerate: config.framerate }
				: {}),
			// Absent hands the format choice back to the engine's own precedence,
			// which is H.264 first — byte-identical to every start before modes
			// existed. Only an operator who explicitly picked a mode sends one.
			...(config.input_mode !== undefined
				? { input_mode: config.input_mode }
				: {}),
			...(Object.keys(audio).length > 0 ? { audio } : {}),
		};
	}

	private buildStartParams(
		config: RuntimeConfig,
		opts: StreamRunOptions,
	): StartParamsWithAudioMode {
		const srt: {
			host: string;
			port: number;
			latency_ms: number;
			streamid?: string;
		} = {
			host: opts.host,
			port: opts.port,
			latency_ms: config.srt_latency ?? DEFAULT_SRT_LATENCY,
		};
		if (opts.streamid) srt.streamid = opts.streamid;

		return startParamsWithAudioModeSchema.parse({
			pipeline: config.pipeline ?? opts.pipeline,
			srt,
			bitrate: {
				min_bitrate: DEFAULT_MIN_BITRATE,
				max_bitrate: config.max_br ?? DEFAULT_MAX_BITRATE,
				balancer: config.balancer ?? DEFAULT_BALANCER,
			},
			...this.encodeInputAudioFields(config, config.pipeline ?? opts.pipeline),
		});
	}

	private toEngineConfig(config: RuntimeConfig): PartialCerastreamConfig {
		return {
			pipeline: config.pipeline ?? "default",
			srt: {
				host: config.srtla_addr ?? "127.0.0.1",
				port: config.srtla_port ?? SRTLA_LISTEN_PORT,
				latency_ms: config.srt_latency ?? DEFAULT_SRT_LATENCY,
			},
			bitrate: {
				min_bitrate: DEFAULT_MIN_BITRATE,
				max_bitrate: config.max_br ?? DEFAULT_MAX_BITRATE,
				balancer: config.balancer ?? DEFAULT_BALANCER,
			},
			...this.encodeInputAudioFields(config, config.pipeline),
		};
	}

	private toReloadParams(
		config: RuntimeConfig,
		schemaVersion: string | undefined,
	): ReloadConfigParams {
		const params: ReloadConfigParams = {
			bitrate: {
				min_bitrate: DEFAULT_MIN_BITRATE,
				max_bitrate: config.max_br ?? DEFAULT_MAX_BITRATE,
				balancer: config.balancer ?? DEFAULT_BALANCER,
			},
			srt: { latency_ms: config.srt_latency ?? DEFAULT_SRT_LATENCY },
		};
		if (config.delay !== undefined) {
			params.audio = supportsSignedReloadDelay(schemaVersion)
				? { delay_ms_signed: config.delay }
				: { delay_ms: Math.max(0, config.delay) };
		}
		return params;
	}

	private requireClient(): CerastreamClient {
		if (!this.client) {
			throw new Error("cerastream: no active control connection");
		}
		return this.client;
	}
}

// Process-wide singleton; the engine registry (streaming-engine.ts) hands this
// out to every streaming call site.
export const cerastreamBackend = new CerastreamBackend();

/** The persistent notification name for an engine-protocol incompatibility. */
export const ENGINE_COMPAT_NOTIFICATION = "cerastream-engine-compat";

/** Injectable surface for {@link checkEngineCompatibilityOnStartup} (tests). */
export interface EngineCompatDeps {
	probe: () => Promise<EngineProbe>;
	notify: CerastreamBridge["notify"];
	logger: CerastreamLogger;
}

/**
 * Run a startup engine probe and surface a protocol incompatibility as a
 * persistent, non-dismissable notification (the UI already renders these), so a
 * new-engine/old-bindings skew is visible immediately rather than only when a
 * stream is first attempted. Unreachable/transient failures only log — the
 * engine may simply not be up yet at boot. Returns the probe for the caller.
 */
export async function checkEngineCompatibilityOnStartup(
	deps: Partial<EngineCompatDeps> = {},
): Promise<EngineProbe> {
	const probe = deps.probe ?? (() => cerastreamBackend.probeEngine());
	const notify = deps.notify ?? notificationBroadcast;
	const logger = deps.logger ?? defaultLogger;

	const result = await probe();
	switch (result.status) {
		case "protocol_incompatible":
			logger.error("cerastream: engine protocol incompatible at startup", {
				probe: result,
			});
			notify(
				ENGINE_COMPAT_NOTIFICATION,
				"error",
				"The streaming engine speaks an incompatible protocol version. A system update is required before streaming will work.",
				0,
				true,
				false,
			);
			break;
		case "unreachable":
			logger.warn("cerastream: engine unreachable at startup", {
				probe: result,
			});
			break;
		case "error":
			logger.warn("cerastream: engine probe failed at startup", {
				probe: result,
			});
			break;
		case "compatible":
			logger.info("cerastream: engine compatible", {
				engine: result.engineVersion,
				protocol: result.protocol,
			});
			break;
	}
	return result;
}
