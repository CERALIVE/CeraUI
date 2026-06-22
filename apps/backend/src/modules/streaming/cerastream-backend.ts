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

import { existsSync } from "node:fs";
import {
	CERASTREAM_BIN,
	type CerastreamClient,
	CerastreamConnectionError,
	CerastreamRpcError,
	CerastreamTimeoutError,
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
	switchAudioParamsSchema,
	switchAudioResultSchema,
	writeCerastreamConfig,
} from "@ceralive/cerastream";
import type { BufferingStatus } from "@ceraui/rpc/schemas";
import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import { logger as defaultLogger } from "../../helpers/logger.ts";
import { getConfig, saveConfig } from "../config.ts";
import { setup } from "../setup.ts";
import {
	notificationBroadcast,
	notificationExists,
} from "../ui/notifications.ts";
import { resolveCerastreamError } from "./cerastream-error-mapping.ts";
import { SRTLA_LISTEN_PORT } from "./constants.ts";
import { validateBitrate } from "./encoder.ts";
import type {
	BackendErrorListener,
	BitrateParams,
	EngineTelemetry,
	StreamingBackend,
	StreamRunOptions,
} from "./streaming-backend.ts";

const CERASTREAM_PIPELINE_PATH = "/tmp/cerastream-pipeline.txt";

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
}

function defaultBridge(): CerastreamBridge {
	return {
		notify: notificationBroadcast,
		notificationExists: (name) => Boolean(notificationExists(name)),
		broadcastStatus: () => {
			// Lazy import keeps the websocket/streaming graph out of this module's
			// import cycle; the nudge fires long after boot so a dynamic import is fine.
			void (async () => {
				try {
					const [{ broadcastMsg }, { getIsStreaming }] = await Promise.all([
						import("../ui/websocket-server.ts"),
						import("./streaming.ts"),
					]);
					broadcastMsg("status", { is_streaming: getIsStreaming() });
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
	};
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
	// Serializes async IPC ops so they never interleave; `settle()` awaits the tail.
	private queue: Promise<void> = Promise.resolve();

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

	start(config: RuntimeConfig, opts: StreamRunOptions): void {
		this.active = true;
		const params = this.buildStartParams(config, opts);
		this.enqueue(async () => {
			const client = await this.deps.connect(this.deps.connectOptions);
			this.client = client;
			this.subscription = await client.subscribeEvents({}, (event) =>
				this.handleEvent(event),
			);
			await client.start(params);
		}, "start");
	}

	stop(onStopped: () => void): boolean {
		if (!this.active) return false;
		this.active = false;
		const client = this.client;
		const subscription = this.subscription;
		this.enqueue(async () => {
			subscription?.close();
			try {
				await client?.stop();
			} finally {
				try {
					await client?.close();
				} catch {
					// already closing
				}
				this.client = undefined;
				this.subscription = undefined;
				onStopped();
			}
		}, "stop");
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
				this.enqueue(
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
		const params = this.toReloadParams(this.deps.getConfig());
		this.enqueue(
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
		return this.requireClient().switchInput(params);
	}

	async listDevices(params?: ListDevicesParams): Promise<ListDevicesResult> {
		return this.requireClient().listDevices(params);
	}

	// `switch-audio` is an additive Phase-1.5 method kept OUT of the binding's
	// frozen V1 `requestSchemas`, so the typed client exposes no `switchAudio()`.
	// Dispatch it through the client's raw JSON-RPC primitive, validating both
	// ends with the bindings' exported schemas so the call stays contract-safe.
	async switchAudio(params: SwitchAudioParams): Promise<SwitchAudioResult> {
		const parsed = switchAudioParamsSchema.parse(params);
		const client = this.requireClient() as unknown as {
			rawRequest(method: string, params?: unknown): Promise<unknown>;
		};
		const raw = await client.rawRequest("switch-audio", parsed);
		return switchAudioResultSchema.parse(raw);
	}

	async reloadAudioDelay(delayMs: number): Promise<ReloadConfigResult> {
		return this.requireClient().reloadConfig({ audio: { delay_ms: delayMs } });
	}

	/** Test seam: resolve once every queued IPC op has settled. */
	settle(): Promise<void> {
		return this.queue;
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
				const buffering = extractBufferingStatus(event);
				this.telemetry = {
					...this.telemetry,
					state: event.state,
					streaming: event.streaming,
					...(event.active_input ? { active_input: event.active_input } : {}),
					...(buffering ? { buffering } : {}),
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
			case "preview":
				break;
		}
	}

	private handleErrorEvent(event: RuntimeErrorEvent): void {
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
				false,
			);
		}

		const raw = `cerastream ${event.source} error [${event.code}]${
			event.reason ? `: ${event.reason}` : ""
		}`;
		for (const listener of this.errorListeners) listener(raw);
	}

	private enqueue(op: () => Promise<void>, label: string): void {
		this.queue = this.queue
			.then(op)
			.catch((err) => this.handleOpFailure(label, err));
	}

	private handleOpFailure(label: string, err: unknown): void {
		this.deps.logger.error(`cerastream: ${label} failed`, { err });
		if (label === "start") {
			this.active = false;
			this.client = undefined;
			this.subscription = undefined;
			this.deps.bridge.notify(
				"cerastream",
				"error",
				"The streaming engine failed to start. Retrying...",
				5,
				true,
				false,
			);
		}
	}

	private buildStartParams(
		config: RuntimeConfig,
		opts: StreamRunOptions,
	): StartParams {
		const srt: {
			host: string;
			port: number;
			latency_ms: number;
			reduced_packet_size: boolean;
			streamid?: string;
		} = {
			host: opts.host,
			port: opts.port,
			latency_ms: config.srt_latency ?? DEFAULT_SRT_LATENCY,
			reduced_packet_size: opts.reducedPacketSize,
		};
		if (opts.streamid) srt.streamid = opts.streamid;

		return startParamsSchema.parse({
			pipeline: config.pipeline ?? opts.pipeline,
			srt,
			bitrate: {
				min_bitrate: DEFAULT_MIN_BITRATE,
				max_bitrate: config.max_br ?? DEFAULT_MAX_BITRATE,
				balancer: config.balancer ?? DEFAULT_BALANCER,
			},
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
		};
	}

	private toReloadParams(config: RuntimeConfig): ReloadConfigParams {
		return {
			bitrate: {
				min_bitrate: DEFAULT_MIN_BITRATE,
				max_bitrate: config.max_br ?? DEFAULT_MAX_BITRATE,
				balancer: config.balancer ?? DEFAULT_BALANCER,
			},
			srt: { latency_ms: config.srt_latency ?? DEFAULT_SRT_LATENCY },
		};
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
