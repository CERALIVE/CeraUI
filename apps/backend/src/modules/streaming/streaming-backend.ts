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

// StreamingBackend: the seam around the encoder engine that CeraUI drives.
//
// The only implementation is `CerastreamBackend` (cerastream-backend.ts), which
// drives the Rust `cerastream` engine over structured JSON-RPC IPC. The seam
// predates it (it was derived from the retired legacy engine's call sites),
// and it stays so every streaming call site keeps talking to an interface — a
// future engine can satisfy the same contract without the streaming RPC
// procedures changing.
//
// SCOPE — what is and isn't behind this seam:
//   * IN:  everything engine-specific — exec path, config persistence, the
//          config hot-reload, run-arg construction, the engine session
//          start/stop, error classification, the streaming-time bitrate setter.
//   * OUT: srtla link bonding + per-link telemetry. srtla_send is a separate
//          supervised process; its telemetry is owned by `link-telemetry.ts`.

import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import type { LaunchTransaction } from "./launch-transaction.ts";

/** Per-field bitrate input — mirrors the RPC bitrate setter payload. */
export type BitrateParams = { max_br?: number | undefined };

/**
 * Inputs for a single engine launch: the selected pipeline (video source) id
 * plus the SRT endpoint and transport flags the engine needs to build its run
 * config.
 */
export interface StreamRunOptions {
	pipeline: string;
	host: string;
	port: number;
	streamid: string;
}

/**
 * Listener for a classified engine error. Receives the raw error description so
 * a consumer (e.g. a test, or a future health probe) can observe the same signal
 * the engine uses for its built-in user-facing notifications.
 */
export type BackendErrorListener = (rawStderr: string) => void;

export type EngineRuntimeState = "streaming" | "idle" | "unknown";

/**
 * Engine-side telemetry snapshot (srtla owns per-link telemetry separately).
 * Kept as an open marker type so the seam stays engine-agnostic.
 */
export type EngineTelemetry = Record<string, unknown>;

/**
 * The control surface CeraUI uses to drive the encoder engine; see SCOPE in the
 * module header.
 */
export interface StreamingBackend {
	/** Resolved engine executable path. */
	readonly execPath: string;
	/** Temp pipeline file the engine reads its pipeline graph from. */
	readonly tempPipelinePath: string;
	/** Engine config file path on disk. */
	readonly configPath: string;

	/** Whether the engine config file currently exists. */
	configExists(): boolean;
	/** Persist the runtime config to the engine config file; returns the path. */
	writeConfig(config: RuntimeConfig): string;
	/** Build the engine argv and persist the run config for a launch. */
	buildRunArgs(config: RuntimeConfig, opts: StreamRunOptions): Array<string>;

	/** Launch the engine process and resolve after the engine confirms PLAYING. */
	start(
		config: RuntimeConfig,
		opts: StreamRunOptions,
		transaction?: LaunchTransaction,
	): Promise<void>;
	/**
	 * Stop the engine process. `onStopped` fires once the engine has terminated
	 * (synchronously if it was already dead). Returns whether an engine process
	 * was found to stop.
	 */
	stop(onStopped: () => void): boolean;
	/**
	 * Hot-adjust the max bitrate while streaming: persist it and signal a reload.
	 * Returns the applied value, or `undefined` when the input fails validation.
	 */
	setBitrate(params: BitrateParams): number | undefined;
	/** Signal the running engine to re-read its config. */
	reloadConfig(): void;

	/** Register an extra listener for classified engine error events. */
	onError(listener: BackendErrorListener): void;

	/** Optional engine-side telemetry hook. */
	getTelemetry?(): EngineTelemetry | null;
	/** Adopt an already-running engine session after a backend reconnect. */
	reconcileRuntimeState?(): Promise<EngineRuntimeState>;
}
