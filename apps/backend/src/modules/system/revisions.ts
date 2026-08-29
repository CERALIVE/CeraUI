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
import { isRealDevice } from "./device-detection.ts";

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

const UNKNOWN_REVISION = "unknown revision";

function readRevision(cmd: string) {
	try {
		const result = Bun.spawnSync(cmd.split(" "), {
			stdout: "pipe",
			timeout: DEFAULT_SPAWN_TIMEOUT_MS,
		});
		if (result.exitCode !== 0) {
			return UNKNOWN_REVISION;
		}
		return result.stdout.toString().trim();
	} catch (_err) {
		return UNKNOWN_REVISION;
	}
}

/**
 * Argv-only sibling of `readRevision` for probes whose answer may legitimately
 * be ABSENT. `readRevision` answers the literal `"unknown revision"`, which is a
 * fine value to render in a version slot but useless to a resolution ladder —
 * the ladder has to tell "this rung had no answer" from "this rung answered".
 */
function probe(argv: string[]): string | undefined {
	try {
		const result = Bun.spawnSync(argv, {
			stdout: "pipe",
			stderr: "pipe",
			timeout: DEFAULT_SPAWN_TIMEOUT_MS,
		});
		if (result.exitCode !== 0) return undefined;
		const out = result.stdout.toString().trim();
		return out.length > 0 ? out : undefined;
	} catch (_err) {
		return undefined;
	}
}

/**
 * Both stamps are read RELATIVE to the working directory, because that is what
 * the original `revision` read did and `ceralive.service` sets
 * `WorkingDirectory=/opt/ceralive`. A dev checkout has neither file, which is
 * exactly how the git rung stays reachable.
 */
const VERSION_STAMP_FILE = "version";
const BUILD_STAMP_FILE = "revision";

/** The Debian package `ceralive-device` is CeraUI's own (`PACKAGE_NAME` in `scripts/build/build-debian-package.sh`). */
const CERAUI_PACKAGE_NAME = "ceralive-device";

async function readStamp(path: string): Promise<string | undefined> {
	try {
		const text = (await Bun.file(path).text()).trim();
		return text.length > 0 ? text : undefined;
	} catch (_err) {
		return undefined;
	}
}

/**
 * The four facts the `CeraUI` row can be built from, injected so the whole
 * ladder is drivable without a packaged tree, a `dpkg` database, or a git
 * checkout (the `*Deps` convention `SshStatusDeps` / `ReconcilerDeps` follow).
 */
export interface CeraUiRevisionSources {
	/** `/opt/ceralive/version` — the CalVer the `.deb` build stamped. */
	readVersionStamp: () => Promise<string | undefined>;
	/** `/opt/ceralive/revision` — the commit the `.deb` build stamped. */
	readBuildStamp: () => Promise<string | undefined>;
	/** The version `dpkg` records for the installed package, on a real device only. */
	readInstalledPackageVersion: () => Promise<string | undefined>;
	/** The working tree's own commit — the dev/git-checkout last resort. */
	readWorkingTreeCommit: () => string | undefined;
}

export const defaultCeraUiRevisionSources: CeraUiRevisionSources = {
	readVersionStamp: () => readStamp(VERSION_STAMP_FILE),
	readBuildStamp: () => readStamp(BUILD_STAMP_FILE),
	readInstalledPackageVersion: async () => {
		// Gated on a REAL device on purpose: a developer who once installed the
		// `.deb` on their workstation would otherwise have their git checkout
		// report that unrelated package's version as the running build.
		if (!(await isRealDevice())) return undefined;
		// biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query's own field syntax, not a JS placeholder
		const versionField = "-f=${Version}";
		return probe(["dpkg-query", "-W", versionField, CERAUI_PACKAGE_NAME]);
	},
	readWorkingTreeCommit: () => probe(["git", "rev-parse", "--short", "HEAD"]),
};

/**
 * A version is the PRIMARY value; a commit is build metadata demoted behind it.
 *
 * The `<version> (<build>)` shape is deliberate rather than a new wire field: it
 * is the same shape `srtla_send -v` already emits, so the frontend's existing
 * `splitVersionValue` promotes the version and demotes the commit to the row's
 * secondary line with no schema change and no per-row special case.
 *
 * A version with NO commit renders as a bare version; a commit with NO version
 * renders as the bare commit, which is byte-identical to what a dev checkout has
 * always shown. A version that ALREADY embeds the commit (a `dpkg` version, whose
 * iteration is `<date>.<commit>`) is left alone rather than repeating it.
 */
export function composeCeraUiRevision(
	version: string | undefined,
	build: string | undefined,
): string {
	if (version === undefined) return build ?? UNKNOWN_REVISION;
	if (build === undefined || version.includes(build)) return version;
	return `${version} (${build})`;
}

/**
 * Resolve the `CeraUI` row: the packaged CalVer version first, the commit only
 * as its build metadata — or, in a dev checkout that genuinely has no packaged
 * version, as the whole value.
 *
 * Version rungs, strongest first:
 *   1. the build-baked `version` stamp (a packaged device);
 *   2. `dpkg-query` on the installed package (a real device whose stamp is gone);
 *   3. none — the row falls back to the commit alone.
 */
export async function resolveCeraUiRevision(
	overrides: Partial<CeraUiRevisionSources> = {},
): Promise<string> {
	const sources = { ...defaultCeraUiRevisionSources, ...overrides };
	const version =
		(await sources.readVersionStamp()) ??
		(await sources.readInstalledPackageVersion());
	const build =
		(await sources.readBuildStamp()) ?? sources.readWorkingTreeCommit();
	return composeCeraUiRevision(version, build);
}

export async function initRevisions(
	revisionSources: Partial<CeraUiRevisionSources> = {},
) {
	revisions.ceralive = await resolveCeraUiRevision(revisionSources);

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
