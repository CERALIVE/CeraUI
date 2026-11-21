/*
 * The "A CeraLive update is available" notice (`ceralive_update`).
 *
 * Only a conclusive check may change it, and only after its verdict is
 * durable: every first-party candidate must be verified, and the verdict is
 * written before anything is broadcast. A withdrawal restored from disk only
 * retracts the exact releases it proved obsolete. An empty verdict also needs CeraLive's verified source in the
 * refreshed inventory. Contract:
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
	notificationExists,
	notificationRetract,
	notificationWithdraw,
} from "../ui/notifications.ts";
import {
	AptAllRefusalError,
	discoverAptAllPackages,
	type PinnedAptPackage,
} from "./apt-all-packages.ts";
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
// Superseded releases kept for scoped retraction; older ones just wait for a fresh check.
const WITHDRAWN_LIMIT = 8;

/** The first-party packages Install would take; an empty list proves none remain. */
export type CeraliveOffer = readonly PinnedAptPackage[] | "unknown";

type AptRun = (argv: string[]) => Promise<SpawnWithTimeoutResult>;

const offerSchema = z
	.array(
		z
			.object({
				name: z
					.string()
					.regex(APT_PACKAGE_NAME_RE)
					.refine((name) => classifyPackageLayer(name) === "app"),
				version: z.string().regex(APT_SIMULATION_VERSION_RE),
			})
			.strict(),
	)
	.refine((rows) =>
		rows.every(
			(row, i) =>
				i === 0 ||
				compareAptPackageNames(rows[i - 1]?.name ?? "", row.name) < 0,
		),
	);
// `withdrawn`: releases this writer proved obsolete since it last offered them, oldest first.
const recordSchema = z
	.object({
		version: z.literal(2),
		offer: offerSchema,
		withdrawn: z.array(offerSchema.min(1)).max(WITHDRAWN_LIMIT),
	})
	.strict();
type OfferRecord = z.infer<typeof recordSchema>;

type Store = {
	readonly path: string;
	readonly write: (path: string, text: string) => void;
};

export type CeraliveUpdateNoticeOptions = {
	readonly path?: string;
	readonly write?: (path: string, text: string) => void;
};

const EMPTY_RECORD: OfferRecord = { version: 2, offer: [], withdrawn: [] };

// Inert until startup opts in, so a process that never initializes writes nothing.
let store: Store | undefined;
let latest: OfferRecord = EMPTY_RECORD;
let persisted: string | undefined;
let withdrawn = false;

export function firstPartyOffer(
	packages: readonly UpdatePackage[],
	sourcePolicy: string,
): CeraliveOffer {
	// Without CeraLive's verified source in the refresh, "nothing listed" proves nothing.
	if (!firstPartySourceListed(sourcePolicy)) return "unknown";
	const offer: PinnedAptPackage[] = [];
	for (const { name, version, origin, actionable } of packages) {
		if (classifyPackageLayer(name) !== "app") continue;
		// One unverified first-party candidate means the picture is incomplete.
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

/** Legacy: verify the exact install plan's first-party rows the way capable discovery does. */
export async function legacyCeraliveOffer(
	names: readonly string[],
	plan: readonly string[],
	run: AptRun,
): Promise<CeraliveOffer> {
	const inventory = await run(["/usr/bin/apt-cache", "policy"]);
	if (inventory.exitCode !== 0 || !firstPartySourceListed(inventory.stdout))
		return "unknown";
	if (names.length === 0) return [];
	const simulation = await run([
		"/usr/bin/apt-get",
		"-s",
		"-o",
		"Debug::NoLocking=1",
		...plan,
	]);
	if (simulation.exitCode !== 0) return "unknown";
	try {
		const { packages } = await discoverAptAllPackages(
			simulation.stdout,
			"",
			async (name) => {
				const policy = await run(["/usr/bin/apt-cache", "policy", name]);
				if (policy.exitCode !== 0)
					throw new AptAllRefusalError("discovery_failed", "package-policy");
				return policy.stdout;
			},
			inventory.stdout,
		);
		const offer = firstPartyOffer(packages, inventory.stdout);
		// The plan must take every first-party package discovery listed.
		return offer !== "unknown" &&
			names.every((name) => offer.some((row) => row.name === name))
			? offer
			: "unknown";
	} catch (error) {
		if (error instanceof AptAllRefusalError) return "unknown";
		throw error;
	}
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
			releaseScoped: true,
		},
	);
	withdrawn = false;
}

// The previous offer joins `withdrawn` once superseded; offering a release again un-withdraws it.
function nextRecord(offer: readonly PinnedAptPackage[]): OfferRecord {
	const key = offer.length > 0 ? dismissalKey(offer) : undefined;
	const previous = latest.offer.length > 0 ? latest.offer : undefined;
	const superseded =
		previous !== undefined && dismissalKey(previous) !== key ? [previous] : [];
	// Keyed by release, newest last; re-adding a release moves it to the end.
	const rows = new Map<string, PinnedAptPackage[]>();
	for (const entry of [...latest.withdrawn, ...superseded]) {
		rows.delete(dismissalKey(entry));
		rows.set(dismissalKey(entry), [...entry]);
	}
	if (key !== undefined) rows.delete(key);
	return {
		version: 2,
		offer: [...offer],
		withdrawn: [...rows.values()].slice(-WITHDRAWN_LIMIT),
	};
}

function persist(offer: readonly PinnedAptPackage[]): boolean {
	const record = nextRecord(offer);
	if (store === undefined) {
		latest = record;
		return true;
	}
	const text = JSON.stringify(record);
	if (text === persisted) return true;
	try {
		store.write(store.path, text);
	} catch (error) {
		logger.warn("CeraLive update notice unchanged: verdict not persisted", {
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
	persisted = text;
	latest = record;
	logger.info("CeraLive update notice verdict", {
		offer: offer.length > 0 ? dismissalKey(offer) : "none",
	});
	return true;
}

function readRecord(path: string) {
	try {
		const text = readStoredStateFileSync(path, STORED_STATE_LIMITS.scalar);
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

/** Applies a conclusive check's verdict; `unknown` leaves the notice as it is. */
export function reconcileCeraliveUpdateNotice(verdict: CeraliveOffer): void {
	if (verdict === "unknown") return;
	const offer = [...verdict].sort((a, b) =>
		compareAptPackageNames(a.name, b.name),
	);
	// A change that is not durable is not made, so no restart can act on an older verdict.
	if (!persist(offer)) return;
	if (offer.length === 0) withdraw();
	else publish(offer);
}

/**
 * Startup retracts only the exact releases the latest durable verdict proved
 * obsolete. It never removes by name: an older backend shows offers without
 * writing the record, and its copies carry no release, so no restart, rollback
 * or replay order can let an old verdict erase a newer offer.
 */
export function initCeraliveUpdateNotice(
	options: CeraliveUpdateNoticeOptions = {},
): void {
	store = {
		path: options.path ?? RECORD_FILE,
		write: options.write ?? writeFileAtomicSync,
	};
	latest = EMPTY_RECORD;
	persisted = undefined;
	withdrawn = false;
	const record = readRecord(store.path);
	if (record === undefined) return;
	latest = record;
	persisted = JSON.stringify(record);
	const releases = record.withdrawn.map(dismissalKey);
	if (record.offer.length > 0 && dismissed(record.offer) === true)
		releases.push(dismissalKey(record.offer));
	if (releases.length > 0) notificationRetract(NOTICE, releases);
}
