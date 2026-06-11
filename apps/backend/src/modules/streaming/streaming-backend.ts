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
// Today the only implementation is `CeracoderBackend` (ceracoder-backend.ts),
// which wraps the CURRENT C `ceracoder` binary + its `@ceralive/ceracoder`
// bindings. The method set below is derived strictly from the existing ceracoder
// call sites — it is NOT modelled on any future engine's IPC. A second
// implementation (the planned `cerastream` engine) can later satisfy the same
// contract without the streaming RPC procedures changing.
//
// SCOPE — what is and isn't behind this seam:
//   * IN:  everything ceracoder-specific — exec path, config file write, the
//          SIGHUP hot-reload, run-arg construction, the engine process spawn and
//          its stderr error classification, the streaming-time bitrate setter.
//   * OUT: `bcrpt` (the BCRP relay-probe binary). It is an INDEPENDENT process
//          with its own spawn/retry lifecycle in `bcrpt.ts` and is unrelated to
//          the encoder, so `bcrptExec` deliberately stays outside this interface.
//   * OUT: srtla link bonding + per-link telemetry. srtla_send is a separate
//          supervised process; its telemetry is owned by `link-telemetry.ts`.
//          ceracoder exposes no engine-side telemetry of its own today, so the
//          optional `getTelemetry` hook is left unimplemented by CeracoderBackend.

import type { RuntimeConfig } from "../../helpers/config-schemas.ts";

/** Per-field bitrate input — mirrors the RPC bitrate setter payload. */
export type BitrateParams = { max_br?: number };

/**
 * Inputs for a single engine launch: the generated pipeline file plus the SRT
 * endpoint and transport flags the engine needs to build its run config.
 */
export interface StreamRunOptions {
	pipelineFile: string;
	host: string;
	port: number;
	streamid: string;
	reducedPacketSize: boolean;
	fullOverride: boolean;
}

/**
 * Listener for a classified engine error. Receives the raw stderr chunk so a
 * consumer (e.g. a test, or a future health probe) can observe the same signal
 * the engine uses for its built-in user-facing notifications.
 */
export type BackendErrorListener = (rawStderr: string) => void;

/**
 * Reserved engine-side telemetry snapshot. The current ceracoder engine has no
 * telemetry channel of its own (srtla owns per-link telemetry separately), so
 * this stays an open marker type rather than a ceracoder-shaped payload.
 */
export type EngineTelemetry = Record<string, unknown>;

/**
 * The control surface CeraUI uses to drive the encoder engine. Every member maps
 * to a real, current ceracoder operation; see SCOPE in the module header.
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

	/** Launch the engine process for a configured stream. */
	start(config: RuntimeConfig, opts: StreamRunOptions): void;
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
	/** Signal the running engine to re-read its config file (SIGHUP). */
	reloadConfig(): void;

	/** Register an extra listener for classified engine error events. */
	onError(listener: BackendErrorListener): void;

	/** Optional engine-side telemetry hook (unused by ceracoder today). */
	getTelemetry?(): EngineTelemetry | null;
}
