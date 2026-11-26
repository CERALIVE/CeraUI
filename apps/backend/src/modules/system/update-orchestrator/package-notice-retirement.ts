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
 * package in its offer installed at the exact offered version. The name is
 * `update:updates-available:` plus `p1=v1,...` or the SHA-256 of a large list.
 * Every frontend removes a copy by that name alone. The proof is about the
 * offer bound to the name, not about who sent it, and it rests only on
 * complete lines dpkg prints: a cut, failed or noisy read can lose a
 * deciding line, never invent one, and so only keeps the notice. Legacy ids
 * carry `unknown` versions and are never provable. Contract:
 * docs/DEVICE-UPDATES.md, "The scheduled package notice".
 */

import { resolve } from "node:path";
import { EVENT_TEXT_LIMIT } from "@ceraui/rpc/events";
import { logger } from "../../../helpers/logger.ts";
import {
	eventsClearGeneration,
	readEvents,
	resolveEventsDir,
} from "../../events/store.ts";
import {
	fenceNotification,
	notificationExists,
	notificationWithdraw,
	persistentNotificationNames,
} from "../../ui/notifications.ts";
import {
	DPKG_QUERY_FORMAT,
	parseDpkgRows,
} from "../software-update-outcome.ts";
import { runAptCommand } from "../software-updates.ts";
import {
	ANNOUNCED_WINDOW,
	COMPACT_ID,
	canRetainCompactOffer,
	compactId,
	type NoticeTarget,
	noticeTargets,
	PACKAGE_ARCH,
	readCompactOffers,
	rememberCompactOffer,
} from "./package-notice-proofs.ts";

const PREFIX = "update:updates-available:";
// A live slot can still be proven if its record could not be saved.
const recentCompactOffers = new Map<string, string>();
// #664's bounds: per command, and for the whole pass; past them nothing is proven.
const PROBE_TIMEOUT_MS = 5_000;
const PASS_DEADLINE_MS = 20_000;

// The stdout of a clean finish (exit 0, nothing on stderr), else null.
type Ask = (argv: string[]) => Promise<string | null>;

export function scheduledPackageNoticeIdentity(offer: string): string {
	if (offer.length <= EVENT_TEXT_LIMIT) return offer;
	const id = compactId(offer);
	if (!canRetainCompactOffer(offer)) return id;
	recentCompactOffers.delete(id);
	recentCompactOffers.set(id, offer);
	for (const oldest of recentCompactOffers.keys()) {
		if (recentCompactOffers.size <= ANNOUNCED_WINDOW) break;
		recentCompactOffers.delete(oldest);
	}
	try {
		rememberCompactOffer(id, offer, announcedIds);
	} catch {
		logger.warn(
			"update-orchestrator: scheduled package notice proof not saved",
		);
	}
	return id;
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

function announcedIds(baseDir = resolveEventsDir()): Set<string> {
	const announced = new Set<string>();
	const events = readEvents({ baseDir })
		.filter((event) => event.code === "update_updates_available")
		.sort((left, right) => right.seq - left.seq);
	for (const { params } of events) {
		if (announced.size >= ANNOUNCED_WINDOW) break;
		if (typeof params.id === "string") announced.add(params.id);
	}
	return announced;
}

function savedOffers(): ReadonlyMap<string, string> {
	try {
		return readCompactOffers();
	} catch {
		logger.warn(
			"update-orchestrator: scheduled package notice proof unavailable",
		);
		return new Map();
	}
}

function candidateOffers(baseDir: string) {
	const live = new Set(
		persistentNotificationNames(PREFIX).map((name) =>
			name.slice(PREFIX.length),
		),
	);
	const announced = announcedIds(baseDir);
	const candidates: {
		readonly id: string;
		readonly offer: string;
		readonly reliesOnHistory: boolean;
	}[] = [];
	let saved: ReadonlyMap<string, string> | undefined;
	for (const id of new Set([...live, ...announced])) {
		let offer = id;
		let reliesOnHistory = !live.has(id);
		if (COMPACT_ID.test(id)) {
			const active = reliesOnHistory ? undefined : recentCompactOffers.get(id);
			if (active !== undefined) {
				offer = active;
			} else {
				// The private store resolves historical IDs; it cannot extend the window.
				if (!announced.has(id)) continue;
				saved ??= savedOffers();
				const exact = saved.get(id);
				if (exact === undefined) continue;
				offer = exact;
				reliesOnHistory = true;
			}
		}
		candidates.push({ id, offer, reliesOnHistory });
	}
	return candidates;
}

// All targets must match in one dpkg-query read, not an atomic snapshot.
// An outside dpkg/apt change during or after the read can invalidate a match
// without changing the version (for example, by putting a package on hold).
// Only a later successful check finding actionable updates announces them.
async function installed(
	targets: readonly NoticeTarget[],
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
	const used = new Set<string>();
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
		const instance = `${row.name}:${row.arch}`;
		if (used.has(instance)) return false;
		used.add(instance);
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
	const baseDir = resolve(resolveEventsDir());
	const clearGeneration = eventsClearGeneration(baseDir);
	const provable = candidateOffers(baseDir).flatMap(
		({ id, offer, reliesOnHistory }) => {
			const targets = noticeTargets(offer);
			return targets && !offer.split(",").some((item) => pending.has(item))
				? [{ id, targets, reliesOnHistory }]
				: [];
		},
	);
	if (provable.length === 0) return;
	const ask = bounded();
	const native = await ask(["dpkg", "--print-architecture"]);
	const arch = native?.endsWith("\n") ? native.slice(0, -1) : undefined;
	if (arch === undefined || !PACKAGE_ARCH.test(arch)) return;
	for (const { id, targets, reliesOnHistory } of provable) {
		if (!isCurrent()) return;
		const name = PREFIX + id;
		const unchanged = fenceNotification(name);
		const proven = await installed(targets, arch, ask);
		// Shown again or dismissed while dpkg was read: keep it.
		if (!unchanged() || !proven) continue;
		if (!isCurrent()) return;
		const live = notificationExists(name) !== undefined;
		if (reliesOnHistory && eventsClearGeneration(baseDir) !== clearGeneration)
			continue;
		notificationWithdraw(name);
		if (live)
			logger.info(
				"update-orchestrator: scheduled package notice withdrawn, dpkg shows its packages installed",
				{ id },
			);
	}
}
