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

/* Read the revision numbers */
import { release } from "node:os";

import { ENGINE_UNREACHABLE_REVISION } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { DEFAULT_SPAWN_TIMEOUT_MS } from "../../helpers/spawn-policy.ts";

import { srtlaSendExec } from "../streaming/streamloop.ts";

/**
 * Published for the cerastream row when the engine cannot be reached.
 *
 * cerastream is systemd-owned (ADR-0005): it can be stopped, crash, or be
 * upgraded underneath a running backend. A version we observed once is therefore
 * not something the device can still vouch for, so an unreachable engine reports
 * this rather than retaining the last-known value — a cached-forever version
 * would keep naming a build that may no longer be installed.
 *
 * The value itself lives in `@ceraui/rpc` because it crosses the wire: the
 * frontend must recognise the sentinel to avoid rendering prose as a version.
 * Re-exported here so this module stays the backend's import surface for it.
 */
export { ENGINE_UNREACHABLE_REVISION };

const revisions: Record<string, string> = {};

type EngineVersionProbe = () => Promise<string | undefined>;

/**
 * Default probe: the SAME short-lived connect → `hello` → close handshake
 * `checkEngineCompatibilityOnStartup` uses. `hello` already carries
 * `engine_version`, so this needs no new IPC method and holds no connection —
 * `probeEngine()` never throws and never respawns the systemd-owned engine.
 *
 * The import is lazy so this module's load path does not pull the whole
 * streaming graph (the same shape `capabilities.ts` uses for `setup.ts`).
 */
const defaultEngineVersionProbe: EngineVersionProbe = async () => {
	const { cerastreamBackend } = await import(
		"../streaming/cerastream-backend.ts"
	);
	const probe = await cerastreamBackend.probeEngine();
	return probe.status === "compatible" ? probe.engineVersion : undefined;
};

let engineVersionProbe: EngineVersionProbe = defaultEngineVersionProbe;

/** Test seam (mirrors the `set*Runner` convention). `null` restores the default. */
export function setEngineVersionProbe(probe: EngineVersionProbe | null): void {
	engineVersionProbe = probe ?? defaultEngineVersionProbe;
}

/**
 * Re-read the engine version and publish it on the revisions record. Called at
 * boot and again whenever the Versions surface is pulled, so the row tracks a
 * mid-session engine restart instead of latching the first value it ever saw.
 */
export async function refreshEngineRevision(): Promise<string> {
	let version: string | undefined;
	try {
		version = await engineVersionProbe();
	} catch (err) {
		logger.debug("revisions: cerastream version probe failed", { err });
	}
	revisions.cerastream = version ?? ENGINE_UNREACHABLE_REVISION;
	return revisions.cerastream;
}

function readRevision(cmd: string) {
	try {
		const result = Bun.spawnSync(cmd.split(" "), {
			stdout: "pipe",
			timeout: DEFAULT_SPAWN_TIMEOUT_MS,
		});
		if (result.exitCode !== 0) {
			return "unknown revision";
		}
		return result.stdout.toString().trim();
	} catch (_err) {
		return "unknown revision";
	}
}

export async function initRevisions() {
	try {
		revisions.ceralive = (await Bun.file("revision").text()).trim();
	} catch (_err) {
		revisions.ceralive = readRevision("git rev-parse --short HEAD");
	}

	revisions.srtla = readRevision(`${srtlaSendExec} -v`);
	revisions.bun = Bun.version;
	revisions.kernel = release();
	await refreshEngineRevision();

	// Only show a CERALIVE image version if it exists
	try {
		revisions["CERALIVE image"] = (
			await Bun.file("/etc/ceralive_img_version").text()
		).trim();
	} catch (_err) {
		// Silently ignore if CERALIVE image version file doesn't exist
	}
	logger.debug("Revisions", revisions);
}

export function getRevisions() {
	return revisions;
}
