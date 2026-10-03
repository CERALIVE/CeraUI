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

/** Set on an admitted stream start (Todo 37 MUST DO). Best-effort: a failure
 * to write the marker must never block or fail the stream start it guards —
 * it only means OTA activation might not defer for this session, which the
 * image-side `--stop`/`--now` paths will simply attempt and, in the worst
 * case, fail their own `[[ ! -e "$STREAMING" ]]` check one step later. */
export function setOtaStreamingMarker(): void {
	try {
		fs.writeFileSync(otaStreamingMarkerPath(), "");
	} catch (error) {
		logger.warn("ota-streaming-marker: failed to set", { error });
	}
}

/** Cleared on stream end (Todo 37 MUST DO) — on a failed launch that never
 * went live, and on every `stop()` call regardless of prior lifecycle state
 * (idempotent: removing an already-absent file is a no-op). */
export function clearOtaStreamingMarker(): void {
	try {
		fs.rmSync(otaStreamingMarkerPath(), { force: true });
	} catch (error) {
		logger.warn("ota-streaming-marker: failed to clear", { error });
	}
}
