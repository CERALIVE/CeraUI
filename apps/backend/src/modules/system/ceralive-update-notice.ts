/*
 * The "A CeraLive update is available" notice (`ceralive_update`).
 *
 * Only a conclusive check (a refresh that fetched every index, then a discovery
 * with coherent first-party evidence) may change it. Its last verdict is
 * persisted before anything is broadcast, so a withdrawal reaches a tab that
 * was offline across any number of backend restarts. Contract:
 * apps/backend/docs/agents/a-persistent-notification-must-be-retractable.md.
 */
import fs from "node:fs";
import type { UpdatePackage } from "@ceraui/rpc";
import { z } from "zod";

import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import { logger } from "../../helpers/logger.ts";
import { isNotificationDismissed } from "../ui/notification-dismissals.ts";
import {
	notificationBroadcast,
	notificationExists,
	notificationWithdraw,
} from "../ui/notifications.ts";
import type { PinnedAptPackage } from "./apt-all-packages.ts";
import { compareAptPackageNames } from "./apt-package-name.ts";
import { APT_SIMULATION_VERSION_RE } from "./apt-simulation-row.ts";
import { FIRST_PARTY_APT_HOST } from "./apt-source-origins.ts";
import { classifyPackageLayer } from "./package-layer.ts";
import { updateDismissalKey } from "./update-state.ts";

const NOTICE = "ceralive_update";
const RECORD_FILE = "ceralive_update_offer.json";

/** The first-party packages Install would take; an empty list proves none remain. */
export type CeraliveOffer = readonly PinnedAptPackage[] | "unknown";

const recordSchema = z.object({
	version: z.literal(1),
	offer: z.array(z.object({ name: z.string(), version: z.string() })),
});

// Inert until startup opts in, so a process that never initializes writes nothing.
let recordPath: string | undefined;
let withdrawn = false;

/** The candidate a legacy plan's package would install, or undefined if policy contradicts the plan. */
export function legacyCandidate(policy: string): string | undefined {
	const installed = /^\s*Installed:\s*(\S+)/m.exec(policy)?.[1];
	const candidate = /^\s*Candidate:\s*(\S+)/m.exec(policy)?.[1];
	return candidate !== undefined &&
		candidate !== installed &&
		APT_SIMULATION_VERSION_RE.test(candidate)
		? candidate
		: undefined;
}

export function capableCeraliveOffer(
	packages: readonly UpdatePackage[],
): CeraliveOffer {
	const roster = packages.filter(
		({ name }) => classifyPackageLayer(name) === "app",
	);
	const offer = roster.flatMap(({ name, version, origin, actionable }) =>
		actionable && origin === FIRST_PARTY_APT_HOST && version !== undefined
			? [{ name, version }]
			: [],
	);
	// A roster row without verified CeraLive evidence is not proof that none remain.
	return offer.length > 0 || roster.length === 0 ? offer : "unknown";
}

function dismissalKey(offer: readonly PinnedAptPackage[]): string {
	return updateDismissalKey({
		version: offer.map(({ name, version }) => `${name}=${version}`).join(","),
		packages: offer.map(({ name }) => name),
	});
}

function dismissed(offer: readonly PinnedAptPackage[]): boolean | undefined {
	try {
		return isNotificationDismissed(dismissalKey(offer));
	} catch (error) {
		logger.warn("CeraLive update notice unchanged: dismissals unreadable", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function withdraw(): void {
	if (withdrawn && notificationExists(NOTICE) === undefined) return;
	notificationWithdraw(NOTICE);
	withdrawn = true;
}

function publish(offer: readonly PinnedAptPackage[]): void {
	const acknowledged = dismissed(offer);
	if (acknowledged === undefined) return;
	// A dismissed successor must not keep its predecessor on screen.
	if (acknowledged) {
		withdraw();
		return;
	}
	notificationBroadcast(
		NOTICE,
		"warning",
		"A CeraLive update is available. Open Settings → Software Updates to install it.",
		0,
		true,
		true,
		true,
		"notifications.ceraliveUpdateAvailable",
		undefined,
		{
			action: {
				schema: 1,
				kind: "navigate",
				target: "updates-dialog",
				labelKey: "notifications.openUpdates",
			},
			dismissalKey: dismissalKey(offer),
			replayRemoval: true,
		},
	);
	withdrawn = false;
}

function persist(offer: readonly PinnedAptPackage[]): void {
	if (recordPath === undefined) return;
	try {
		writeFileAtomicSync(recordPath, JSON.stringify({ version: 1, offer }));
	} catch (error) {
		logger.warn("CeraLive update offer record not written", {
			error: error instanceof Error ? error.message : String(error),
		});
		// An older "none pending" left behind would withdraw this offer after a restart.
		try {
			fs.rmSync(recordPath, { force: true });
		} catch (removeError) {
			logger.error("Stale CeraLive update offer record not removed", {
				error:
					removeError instanceof Error
						? removeError.message
						: String(removeError),
			});
		}
	}
}

function readRecord(path: string): PinnedAptPackage[] | undefined {
	let text: string;
	try {
		text = fs.readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			logger.warn("CeraLive update offer record unreadable", {
				error: error instanceof Error ? error.message : String(error),
			});
		return undefined;
	}
	try {
		return recordSchema.parse(JSON.parse(text)).offer;
	} catch (error) {
		logger.warn("CeraLive update offer record ignored: invalid", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/** Applies a conclusive check's verdict; `unknown` leaves the notice as it is. */
export function reconcileCeraliveUpdateNotice(verdict: CeraliveOffer): void {
	if (verdict === "unknown") return;
	const offer = [...verdict].sort((a, b) =>
		compareAptPackageNames(a.name, b.name),
	);
	persist(offer);
	if (offer.length === 0) withdraw();
	else publish(offer);
}

/** Startup restores withdrawals only; an offer is shown again by a new check. */
export function initCeraliveUpdateNotice(path = RECORD_FILE): void {
	recordPath = path;
	const offer = readRecord(path);
	if (offer === undefined) return;
	if (offer.length === 0 || dismissed(offer) === true) withdraw();
}

export function resetCeraliveUpdateNoticeForTest(): void {
	recordPath = undefined;
	withdrawn = false;
}
