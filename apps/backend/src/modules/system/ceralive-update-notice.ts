/*
 * The "A CeraLive update is available" notice (`ceralive_update`).
 *
 * It is withdrawn only on positive evidence: a conclusive check that finds no
 * first-party update pending, or the updater's own successful install after
 * which dpkg shows every offered package installed at or above the offered
 * version. A restart decides nothing by itself: startup re-announces a stored
 * offer, and an install's proof reaches a tab that logs in later only from the
 * process that recorded it and the one process after it (the install's own
 * restart). Anything unread, partial or unproven keeps the offer. A verdict is
 * written before it is broadcast. Contract:
 * apps/backend/docs/agents/a-persistent-notification-must-be-retractable.md.
 */
import type { UpdatePackage } from "@ceraui/rpc";
import { z } from "zod";

import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import { logger } from "../../helpers/logger.ts";
import type { SpawnWithTimeoutResult } from "../../helpers/spawn-policy.ts";
import { isNotificationDismissed } from "../ui/notification-dismissals.ts";
import {
	notificationBroadcast,
	notificationWithdraw,
	removalFrames,
	setAuthenticatedReplay,
} from "../ui/notifications.ts";
import { candidateOrigin, type PinnedAptPackage } from "./apt-all-packages.ts";
import { policySources } from "./apt-all-source-policy.ts";
import {
	APT_PACKAGE_NAME_RE,
	compareAptPackageNames,
} from "./apt-package-name.ts";
import { APT_SIMULATION_VERSION_RE } from "./apt-simulation-row.ts";
import { FIRST_PARTY_APT_HOST } from "./apt-source-origins.ts";
import { classifyPackageLayer } from "./package-layer.ts";
import {
	readStoredStateFileSync,
	STORED_STATE_LIMITS,
} from "./update-orchestrator/stored-state-file.ts";
import { parseAuthorityJson } from "./update-orchestrator/strict-authority-json.ts";
import { updateDismissalKey } from "./update-state.ts";

const NOTICE = "ceralive_update";
const RECORD_FILE = "ceralive_update_offer.json";
// Shared by writer and reader, so every record a check commits is readable at restart.
const RECORD_LIMIT = STORED_STATE_LIMITS.scalar;
// Keeps the largest exact-roster record within RECORD_LIMIT (pinned by the restart test).
export const OFFER_VERSION_LIMIT = 160;
const INSTALLED = /^(?:install|hold) ok installed$/;

/** The first-party packages Install would take; an empty list proves none remain. */
export type CeraliveOffer = readonly PinnedAptPackage[] | "unknown";

export type AptRun = (argv: string[]) => Promise<SpawnWithTimeoutResult>;

/** What one login's delivery did, for observers. */
export type ReplayOutcome = "sent" | "declined";

const version = z
	.string()
	.max(OFFER_VERSION_LIMIT)
	.regex(APT_SIMULATION_VERSION_RE);
const offerSchema = z
	.array(
		z
			.object({
				name: z
					.string()
					.regex(APT_PACKAGE_NAME_RE)
					.refine((name) => classifyPackageLayer(name) === "app"),
				version,
			})
			.strict(),
	)
	.min(1)
	.refine((rows) =>
		rows.every(
			(row, i) =>
				i === 0 ||
				compareAptPackageNames(rows[i - 1]?.name ?? "", row.name) < 0,
		),
	);
// The one durable state: the current offer, or `null` for none. `installed` is
// the offer a successful install was proven to have taken, still to be told to
// tabs that missed it; only the next process to load it delivers it.
const recordSchema = z
	.object({
		version: z.literal(7),
		offer: offerSchema.nullable(),
		installed: offerSchema.optional(),
	})
	.strict()
	.refine((record) => record.installed === undefined || record.offer === null);
type OfferRecord = z.infer<typeof recordSchema>;

type Store = {
	readonly path: string;
	readonly write: (path: string, text: string) => void;
	readonly observe: (outcome: ReplayOutcome) => void;
};

export type CeraliveUpdateNoticeOptions = {
	readonly path?: string;
	readonly write?: (path: string, text: string) => void;
	readonly observe?: (outcome: ReplayOutcome) => void;
};

// Inert until startup opts in, so a process that never initializes writes nothing.
let store: Store | undefined;
let latest: OfferRecord | undefined;
let persisted: string | undefined;

/** Capable: the check's verified first-party rows; one unverified row means unknown. */
export function firstPartyOffer(
	packages: readonly UpdatePackage[],
	sourcePolicy: string,
): CeraliveOffer {
	// Without CeraLive's source in the check, "nothing listed" proves nothing.
	if (!firstPartySourceListed(sourcePolicy)) return "unknown";
	const offer: PinnedAptPackage[] = [];
	for (const { name, version, origin, actionable } of packages) {
		if (classifyPackageLayer(name) !== "app") continue;
		if (!actionable || origin !== FIRST_PARTY_APT_HOST || version === undefined)
			return "unknown";
		offer.push({ name, version });
	}
	return offer;
}

function firstPartySourceListed(sourcePolicy: string): boolean {
	return [...policySources(sourcePolicy).values()].includes(
		FIRST_PARTY_APT_HOST,
	);
}

const PLAN_SUMMARY =
	/^(\d+) upgraded, (\d+) newly installed, (\d+) to remove and \d+ not upgraded\.$/gm;

/**
 * A simulated plan is complete only with APT's single summary line and exactly
 * the Inst and Remv rows it counts (APT prints the summary before the rows, so a
 * cut or partial answer loses rows the summary still counts).
 */
export function completePlan(simulation: string): boolean {
	const summaries = [...simulation.matchAll(PLAN_SUMMARY)];
	const summary = summaries[0];
	if (summaries.length !== 1 || summary === undefined) return false;
	const rows = (verb: string) =>
		simulation.split("\n").filter((line) => line.startsWith(`${verb} `)).length;
	return (
		rows("Inst") === Number(summary[1]) + Number(summary[2]) &&
		rows("Remv") === Number(summary[3])
	);
}

/**
 * Legacy: the check's actionable first-party names, each with its candidate
 * from CeraLive's own source. Read-only `apt-cache policy` only.
 */
export async function legacyCeraliveOffer(
	names: readonly string[],
	run: AptRun,
): Promise<CeraliveOffer> {
	const inventory = await run(["/usr/bin/apt-cache", "policy"]);
	if (inventory.exitCode !== 0 || !firstPartySourceListed(inventory.stdout))
		return "unknown";
	const sources = policySources(inventory.stdout);
	const offer: PinnedAptPackage[] = [];
	for (const name of names) {
		const policy = await run(["/usr/bin/apt-cache", "policy", name]);
		const candidate = /^\s*Candidate:\s*(\S+)/m.exec(policy.stdout)?.[1];
		if (
			policy.exitCode !== 0 ||
			candidate === undefined ||
			candidateOrigin(policy.stdout, candidate, sources) !==
				FIRST_PARTY_APT_HOST
		)
			return "unknown";
		offer.push({ name, version: candidate });
	}
	return offer;
}

/**
 * dpkg's own answer that every offered package is installed at or above its
 * offered version: one complete query (exit 0, nothing on stderr, exactly one
 * installed row per name), then `dpkg --compare-versions ... ge ...` exiting 0
 * for each. A failed, timed-out or killed command (the runner reports those as
 * a nonzero exit) proves nothing.
 */
async function installedAtLeast(
	offer: readonly PinnedAptPackage[],
	run: AptRun,
): Promise<boolean> {
	const query = await run([
		"/usr/bin/dpkg-query",
		"-W",
		"-f",
		"$" + "{Package}\t$" + "{Status}\t$" + "{Version}\n",
		...offer.map(({ name }) => name),
	]);
	if (query.exitCode !== 0 || query.stderr !== "") return false;
	const installed = new Map<string, string>();
	for (const line of query.stdout.split("\n").filter(Boolean)) {
		const [name = "", status = "", found = "", ...extra] = line.split("\t");
		if (
			extra.length > 0 ||
			installed.has(name) ||
			!INSTALLED.test(status) ||
			!version.safeParse(found).success
		)
			return false;
		installed.set(name, found);
	}
	for (const row of offer) {
		const found = installed.get(row.name);
		if (found === undefined) return false;
		const compared = await run([
			"/usr/bin/dpkg",
			"--compare-versions",
			found,
			"ge",
			row.version,
		]);
		if (compared.exitCode !== 0) return false;
	}
	return true;
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

function publish(offer: readonly PinnedAptPackage[]): void {
	const acknowledged = dismissed(offer);
	if (acknowledged === undefined) return;
	// A dismissed successor must not keep its predecessor on screen.
	if (acknowledged) {
		notificationWithdraw(NOTICE);
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
			releaseScoped: true,
		},
	);
}

function persist(record: OfferRecord): boolean {
	const text = JSON.stringify(record);
	// The writer applies the reader's own checks, so it never commits a record a restart refuses.
	if (
		!recordSchema.safeParse(record).success ||
		Buffer.byteLength(text) > RECORD_LIMIT
	) {
		logger.warn(
			"CeraLive update notice unchanged: verdict exceeds the record",
			{
				bytes: Buffer.byteLength(text),
			},
		);
		return false;
	}
	if (store !== undefined && text !== persisted) {
		try {
			store.write(store.path, text);
		} catch (error) {
			logger.warn("CeraLive update notice unchanged: verdict not persisted", {
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
		persisted = text;
		logger.info("CeraLive update notice verdict", {
			offer: record.offer === null ? "none" : dismissalKey(record.offer),
			...(record.installed
				? { installed: dismissalKey(record.installed) }
				: {}),
		});
	}
	latest = record;
	return true;
}

function readRecord(path: string) {
	try {
		const text = readStoredStateFileSync(path, RECORD_LIMIT);
		return text === null
			? undefined
			: recordSchema.parse(parseAuthorityJson(text));
	} catch (error) {
		logger.warn("CeraLive update offer record ignored", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/**
 * Applies a conclusive check's own verdict (a check that is not conclusive
 * about CeraLive passes "unknown" and changes nothing). The verdict is
 * committed before it is broadcast.
 */
export function reconcileCeraliveUpdateNotice(offer: CeraliveOffer): void {
	if (offer === "unknown") {
		logger.warn("CeraLive update notice unchanged: check not conclusive");
		return;
	}
	if (offer.length === 0) {
		// A recorded "none" stays as it is, with any install proof still to be told.
		if (latest?.offer !== null && !persist({ version: 7, offer: null })) return;
		// Sent on every conclusive check, so a connected tab that missed one still hears it.
		notificationWithdraw(NOTICE);
		return;
	}
	const sorted = [...offer].sort((a, b) =>
		compareAptPackageNames(a.name, b.name),
	);
	// A change that is not durable is not made, so no restart can act on an older verdict.
	if (!persist({ version: 7, offer: sorted })) return;
	publish(sorted);
}

/**
 * The updater's own install of the offer succeeded: the offer is withdrawn,
 * and recorded as installed, only when dpkg proves it. Never throws.
 */
export async function withdrawCeraliveOfferIfInstalled(
	run: AptRun,
): Promise<void> {
	const record = latest;
	if (store === undefined || !record?.offer) return;
	let proven = false;
	try {
		proven = await installedAtLeast(record.offer, run);
	} catch (error) {
		logger.warn("CeraLive update notice: dpkg unreadable after the install", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	if (!proven) {
		logger.warn("CeraLive update notice kept: the install is not proven");
		return;
	}
	// A check that recorded a newer verdict while dpkg was read wins.
	if (latest !== record) return;
	if (!persist({ version: 7, offer: null, installed: record.offer })) return;
	notificationWithdraw(NOTICE);
}

// What a tab that logs in is told: an install proof this process may deliver, or
// the user's own dismissal of the current offer.
function deliverable(record: OfferRecord | undefined): boolean {
	if (record === undefined) return false;
	if (record.installed !== undefined) return true;
	return record.offer !== null && dismissed(record.offer) === true;
}

/**
 * Loads the last verdict and re-announces a stored offer. A stored install
 * proof is taken by this process alone (the file then says only "none"), told
 * to tabs that authenticated early, and to every tab that logs in to it.
 */
export function initCeraliveUpdateNotice(
	options: CeraliveUpdateNoticeOptions = {},
): void {
	store = {
		path: options.path ?? RECORD_FILE,
		write: options.write ?? writeFileAtomicSync,
		observe: options.observe ?? (() => undefined),
	};
	const record = readRecord(store.path);
	latest = record;
	persisted = record === undefined ? undefined : JSON.stringify(record);
	if (record?.installed !== undefined)
		// Unless the file no longer carries it, a later restart could deliver it again.
		latest = persist({ version: 7, offer: null })
			? record
			: { version: 7, offer: null };
	setAuthenticatedReplay(async (send) => {
		const sent = deliverable(latest);
		if (sent) for (const frame of removalFrames(NOTICE)) send(frame);
		store?.observe(sent ? "sent" : "declined");
	});
	if (latest?.offer) publish(latest.offer);
	else if (latest?.installed) notificationWithdraw(NOTICE);
}
