/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Withdraws a scheduled "updates are available" notice once dpkg shows every
 * package its name lists installed at the exact named version. The name is `update:updates-available:`
 * plus `p1=v1,...` (main's announcement, unchanged), every frontend removes a
 * copy by that name alone, and every backend that issued the name used it for
 * the same claim: these packages can still move to these versions. So the
 * proof is about the name, not about who sent it, and it rests only on
 * complete lines dpkg prints: a cut, failed or noisy read can lose a
 * deciding line, never invent one, and so only keeps the notice. Legacy ids
 * carry `unknown` versions and are never provable. Contract:
 * docs/DEVICE-UPDATES.md, "The scheduled package notice".
 */

import { logger } from "../../../helpers/logger.ts";
import { readEvents } from "../../events/store.ts";
import {
	fenceNotification,
	notificationExists,
	notificationWithdraw,
	persistentNotificationNames,
} from "../../ui/notifications.ts";
import { APT_PACKAGE_NAME_RE } from "../apt-package-name.ts";
import { APT_SIMULATION_VERSION_RE } from "../apt-simulation-row.ts";
import {
	DPKG_QUERY_FORMAT,
	parseDpkgRows,
} from "../software-update-outcome.ts";
import { runAptCommand } from "../software-updates.ts";

const PREFIX = "update:updates-available:";
const ANNOUNCED_WINDOW = 32;
// #664's bounds: per command, and for the whole pass; past them nothing is proven.
const PROBE_TIMEOUT_MS = 5_000;
const PASS_DEADLINE_MS = 20_000;
const ARCH = /^[a-z0-9][a-z0-9-]*$/;

type Target = {
	readonly pkg: string;
	// null: a bare name, which apt prints for the native or `all` instance.
	readonly arch: string | null;
	readonly version: string;
};
// The stdout of a clean finish (exit 0, nothing on stderr), else null.
type Ask = (argv: string[]) => Promise<string | null>;

/** The packages and versions a scheduled notice id names; null unless every element is one, once. */
export function noticeTargets(id: string): readonly Target[] | null {
	const targets: Target[] = [];
	for (const item of id.split(",")) {
		const [, name = "", version = ""] = /^([^=]+)=([^=]+)$/.exec(item) ?? [];
		const [pkg = "", arch = null, extra] = name.split(":");
		if (
			!APT_PACKAGE_NAME_RE.test(name) ||
			!APT_SIMULATION_VERSION_RE.test(version) ||
			extra !== undefined ||
			(arch !== null && !ARCH.test(arch)) ||
			targets.some((target) => target.pkg === pkg && target.arch === arch)
		)
			return null;
		targets.push({ pkg, arch, version });
	}
	return targets.length > 0 ? targets : null;
}

function bounded(): Ask {
	const deadline = Date.now() + PASS_DEADLINE_MS;
	return async (argv) => {
		const left = deadline - Date.now();
		if (left <= 0) return null;
		// A refusal to run now (a pending restart, a disruptive action) is no answer.
		const answer = await runAptCommand(
			argv,
			Math.min(PROBE_TIMEOUT_MS, left),
		).catch(() => null);
		return answer?.exitCode === 0 && answer.stderr === ""
			? answer.stdout
			: null;
	};
}

function candidateIds(): Set<string> {
	const ids = new Set(
		persistentNotificationNames(PREFIX).map((name) =>
			name.slice(PREFIX.length),
		),
	);
	const announced = new Set<string>();
	const events = readEvents()
		.filter((event) => event.code === "update_updates_available")
		.sort((left, right) => right.seq - left.seq);
	for (const { params } of events) {
		if (announced.size >= ANNOUNCED_WINDOW) break;
		if (typeof params.id === "string") announced.add(params.id);
	}
	return new Set([...ids, ...announced]);
}

// All targets must match in one dpkg snapshot. Separate APT policy reads
// cannot prove that different candidates were ever current at the same time.
async function installed(
	targets: readonly Target[],
	native: string,
	ask: Ask,
): Promise<boolean> {
	const packages = [...new Set(targets.map(({ pkg }) => pkg))];
	const listed = await ask([
		"dpkg-query",
		"-W",
		DPKG_QUERY_FORMAT,
		"--",
		...packages,
	]);
	const rows = listed?.endsWith("\n") ? parseDpkgRows(listed, packages) : null;
	if (!rows) return false;
	for (const { pkg, arch, version } of targets) {
		const instances = rows.filter(
			(row) =>
				row.name === pkg &&
				(arch === null
					? row.arch === native || row.arch === "all"
					: row.arch === arch),
		);
		const row = instances.length === 1 ? instances[0] : undefined;
		if (row?.status !== "ii " || row.version !== version) return false;
	}
	return true;
}

/**
 * After a successful check on a capable image: withdraws every scheduled
 * notice whose packages dpkg shows installed. `current` is this check's rows
 * (`name=version`), the ones main's announcement was built from; a notice
 * sharing any of them is what main considers pending and is not read.
 */
export async function retireFulfilledPackageNotices(
	current: readonly string[],
	isCurrent: () => boolean,
): Promise<void> {
	if (!isCurrent()) return;
	const pending = new Set(current);
	const provable = [...candidateIds()].flatMap((id) => {
		const targets = noticeTargets(id);
		return targets && !id.split(",").some((item) => pending.has(item))
			? [{ id, targets }]
			: [];
	});
	if (provable.length === 0) return;
	const ask = bounded();
	const native = await ask(["dpkg", "--print-architecture"]);
	const arch = native?.endsWith("\n") ? native.slice(0, -1) : undefined;
	if (arch === undefined || !ARCH.test(arch)) return;
	for (const { id, targets } of provable) {
		if (!isCurrent()) return;
		const name = PREFIX + id;
		const unchanged = fenceNotification(name);
		const proven = await installed(targets, arch, ask);
		// Shown again or dismissed while dpkg was read: keep it.
		if (!unchanged() || !proven) continue;
		if (!isCurrent()) return;
		const live = notificationExists(name) !== undefined;
		notificationWithdraw(name);
		if (live)
			logger.info(
				"update-orchestrator: scheduled package notice withdrawn, dpkg shows its packages installed",
				{ id },
			);
	}
}
