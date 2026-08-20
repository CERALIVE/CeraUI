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

/*
  THE PRE-SPAWN CAPABILITY PROBE (ADR-003 §7).

  A new CeraUI running against an OLD `srtla_send` must behave EXACTLY as the old
  CeraUI did. That is the backward-compatibility guarantee of this whole change,
  and it cannot be met by trying `--bind-map` and reacting: an unknown flag makes
  the sender exit non-zero with a usage error, which at spawn time is a FAILED
  STREAM, not a graceful downgrade.

  So the question is asked BEFORE the spawn args are built. `--capabilities-json`
  is one-shot, side-effect free, and answers with a single JSON line on exit `0`.

  THE LOAD-BEARING HALF IS OURS, AND IT IS THE PESSIMISTIC ONE:

      non-zero exit  |  unparseable output  |  timeout  ⇒  NO SUPPORT

  We match on NOTHING — not the exit code, not the message text. The shipped
  3.2.0 binary answers `error: unexpected argument` with exit `2`, and a future
  build might answer differently; treating any non-success identically is what
  makes the fallback correct for binaries that do not exist yet.
*/

import { logger } from "../../helpers/logger.ts";
import {
	SpawnTimeoutError,
	spawnWithTimeout,
} from "../../helpers/spawn-policy.ts";

/** Bounded budget for the probe. It binds no socket and writes no file. */
export const CAPABILITY_PROBE_TIMEOUT_MS = 3_000;

/** Why the probe concluded the binary cannot be given `--bind-map`. */
export type CapabilityProbeFailure =
	| "nonzero-exit"
	| "invalid-json"
	| "timeout"
	| "spawn-failed"
	| "schema-unsupported";

export type CapabilityProbeResult =
	| { readonly bindMap: true; readonly bindMapSchemaVersion: number }
	| { readonly bindMap: false; readonly reason: CapabilityProbeFailure };

/** The sidecar schema version this writer produces. */
export const WRITER_BIND_MAP_SCHEMA_VERSION = 1;

interface CapabilityDocument {
	readonly capabilities?: {
		readonly bind_map?: unknown;
		readonly bind_map_schema_version?: unknown;
	};
}

/**
 * Decide support from a probe's raw outcome. Pure, so every failure mode is
 * testable without a binary on the host.
 */
export function classifyCapabilityDocument(
	exitCode: number,
	stdout: string,
): CapabilityProbeResult {
	if (exitCode !== 0) return { bindMap: false, reason: "nonzero-exit" };

	let parsed: CapabilityDocument;
	try {
		parsed = JSON.parse(stdout.trim()) as CapabilityDocument;
	} catch {
		return { bindMap: false, reason: "invalid-json" };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { bindMap: false, reason: "invalid-json" };
	}

	const capabilities = parsed.capabilities;
	if (typeof capabilities !== "object" || capabilities === null) {
		return { bindMap: false, reason: "invalid-json" };
	}
	if (capabilities.bind_map !== true) {
		return { bindMap: false, reason: "invalid-json" };
	}

	const schema = capabilities.bind_map_schema_version;
	// An absent schema version predates the field; the document positively claims
	// `bind_map: true`, and version 1 is the only shape that has ever existed, so
	// absence is read as 1 rather than as a refusal.
	const version = typeof schema === "number" ? schema : 1;
	if (version !== WRITER_BIND_MAP_SCHEMA_VERSION) {
		return { bindMap: false, reason: "schema-unsupported" };
	}

	return { bindMap: true, bindMapSchemaVersion: version };
}

export interface CapabilityProbeDeps {
	readonly runProbe: (
		execPath: string,
	) => Promise<{ exitCode: number; stdout: string }>;
}

const defaultDeps: CapabilityProbeDeps = {
	runProbe: (execPath) =>
		spawnWithTimeout([execPath, "--capabilities-json"], {
			timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS,
		}),
};

/**
 * Ask the installed sender whether it understands `--bind-map`.
 *
 * NEVER throws: every failure mode resolves to `{bindMap: false}` with a typed
 * reason, because a probe that throws on the start path would turn a graceful
 * legacy spawn into a failed stream — the exact outcome this exists to avoid.
 */
export async function probeSrtlaSenderCapabilities(
	execPath: string,
	deps: CapabilityProbeDeps = defaultDeps,
): Promise<CapabilityProbeResult> {
	try {
		const { exitCode, stdout } = await deps.runProbe(execPath);
		const result = classifyCapabilityDocument(exitCode, stdout);
		if (!result.bindMap) {
			logger.info("srtla_send capability probe: no bind-map support", {
				reason: result.reason,
			});
		}
		return result;
	} catch (error) {
		const reason: CapabilityProbeFailure =
			error instanceof SpawnTimeoutError ? "timeout" : "spawn-failed";
		logger.info("srtla_send capability probe failed", { reason });
		return { bindMap: false, reason };
	}
}
