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

// Push the persisted preview-encoder REQUEST (`config.previewEncode`) down to
// the engine, over a short-lived connection of its own.
//
// Why CeraUI has to re-assert something it already told the engine once: the
// engine reports only what it REALIZED (`status.preview_encoder_realized`),
// never what was requested, so CeraUI's config is the sole record of operator
// intent — and a systemd restart of the engine while the device sits idle drops
// whatever was last pushed with no event CeraUI could react to. Re-asserting on
// every start is therefore cheaper AND more correct than tracking a dirty flag:
// it needs no engine-restart signal to stay right.
//
// Why a connection of its own: `CerastreamBackend.reloadConfig()` and
// `changeConfig()` both drive the SESSION control client, which by definition
// does not exist before the stream that this call has to precede. The
// connect → one call → close shape is the one `capabilities.ts` already uses for
// its idle-safe probes; `close()` only drops our socket, it never spawns or
// stops the systemd-owned engine.
//
// It rides `reload-config`, NEVER `change-config`: `change-config`
// transactionally replaces a LIVE stream, and the preview encoder is fixed when
// the engine builds the main graph, so using it would restart a stream to change
// a preview setting. The mode applies to the NEXT stream session.

import {
	type CerastreamClient,
	type ConnectOptions,
	connect,
} from "@ceralive/cerastream";
import type { PreviewEncodeMode } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { getConfig } from "../config.ts";

/**
 * `unreachable` — the engine could not be reached or did not answer.
 * `rejected` — the engine answered, and refused the mode.
 */
export type PreviewEncodeReplayFailure = "unreachable" | "rejected";

export type PreviewEncodeReplayResult =
	| { readonly ok: true; readonly replayed: PreviewEncodeMode | undefined }
	| {
			readonly ok: false;
			readonly failure: PreviewEncodeReplayFailure;
			readonly error: string;
	  };

/** Transport seam: one short-lived `reload-config` carrying only the mode. */
export type PreviewEncodeReplayTransport = (
	mode: PreviewEncodeMode,
) => Promise<void>;

let transportOverride: PreviewEncodeReplayTransport | null = null;

/** Test seam: replace the engine transport; `null` restores the real one. */
export function setPreviewEncodeReplayTransport(
	transport: PreviewEncodeReplayTransport | null,
): void {
	transportOverride = transport;
}

/**
 * An engine that answered and said no. Distinguished from a transport failure
 * because only this one means the request itself is the problem — a re-dial
 * across an engine restart fixes an unreachable socket, and never fixes this.
 */
export class PreviewEncodeRejectedError extends Error {}

async function defaultTransport(mode: PreviewEncodeMode): Promise<void> {
	// Lazy import for the reason the rest of this graph documents: the socket
	// override is only needed for the real on-device call.
	const { setup } = await import("../setup.ts");
	const connectOptions: ConnectOptions = setup.cerastream_socket
		? { socketPath: setup.cerastream_socket }
		: {};

	let client: CerastreamClient | undefined;
	try {
		client = await connect(connectOptions);
		try {
			await client.reloadConfig({ preview_encode: mode });
		} catch (err) {
			throw new PreviewEncodeRejectedError(
				err instanceof Error ? err.message : String(err),
			);
		}
	} finally {
		try {
			await client?.close();
		} catch {
			// Best-effort disconnect of a probe connection; never respawns the engine.
		}
	}
}

/**
 * Assert the persisted preview-encoder mode against the engine.
 *
 * Resolves `ok` with `replayed: undefined` — opening no connection at all — when
 * the operator has never stated a preference, so a device that never touched the
 * toggle behaves exactly as it did before this path existed.
 */
export async function replayPreviewEncodeMode(): Promise<PreviewEncodeReplayResult> {
	const mode = getConfig().previewEncode;
	if (mode === undefined) return { ok: true, replayed: undefined };

	const transport = transportOverride ?? defaultTransport;
	try {
		await transport(mode);
		logger.debug("preview-encode: mode asserted on the engine", { mode });
		return { ok: true, replayed: mode };
	} catch (err) {
		const failure: PreviewEncodeReplayFailure =
			err instanceof PreviewEncodeRejectedError ? "rejected" : "unreachable";
		const error = err instanceof Error ? err.message : String(err);
		logger.warn("preview-encode: the engine did not take the requested mode", {
			module: "streaming",
			mode,
			failure,
			error,
		});
		return { ok: false, failure, error };
	}
}
