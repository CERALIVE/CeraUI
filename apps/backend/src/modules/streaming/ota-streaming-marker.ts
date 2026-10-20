/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * The OTA-activation streaming sentinel (Todo 37) — `/run/ceralive/streaming`.
 *
 * This is the EXACT SAME flag path the image-side
 * `mkosi/runtime/ceralive-rauc-activate.sh` already checks (Todo 28,
 * image-building-pipeline): `STREAMING="${CERALIVE_STREAMING_MARKER:-/run/ceralive/streaming}"`.
 * Both that script's `--arm`/`--now`/shutdown-hook activation paths and
 * `--stop` all check `[[ -e "$STREAMING" ]]` and defer/refuse RAUC slot
 * activation while it exists. The name and default path must never drift
 * from that script's default — the env override below exists only for
 * symmetry with the shell script's own `CERALIVE_STREAMING_MARKER` override
 * (test/dev use), not because CeraUI ever needs a different production path.
 *
 * Existence-only sentinel: the file's CONTENT is never read by either side.
 */

import fs from "node:fs";

import { logger } from "../../helpers/logger.ts";

export function otaStreamingMarkerPath(): string {
	return process.env.CERALIVE_STREAMING_MARKER ?? "/run/ceralive/streaming";
}

/** Only ENOENT proves an empty boot baseline; unreadable evidence stays protected. */
export function initialOtaStreamLiveness(): "idle" | "unknown" {
	try {
		fs.lstatSync(otaStreamingMarkerPath());
		return "unknown";
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ENOENT"
			? "idle"
			: "unknown";
	}
}

/** A failed write keeps protection unconfirmed and must be retried by the owner. */
export function setOtaStreamingMarker(): boolean {
	try {
		fs.writeFileSync(otaStreamingMarkerPath(), "");
		return true;
	} catch (error) {
		logger.warn("ota-streaming-marker: failed to set", { error });
		return false;
	}
}

/** Cleared after confirmed idle/cleanup or a failed launch that never went live.
 * Stop intent disarms restoration separately; parked/failed/unknown media stops
 * retain this OTA guard. Removing an already-absent file is a no-op. */
export function clearOtaStreamingMarker(): boolean {
	try {
		fs.rmSync(otaStreamingMarkerPath(), { force: true });
		return true;
	} catch (error) {
		logger.warn("ota-streaming-marker: failed to clear", { error });
		return false;
	}
}
