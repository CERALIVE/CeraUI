/*
 * The "A CeraLive update is available" notice (`ceralive_update`).
 *
 * Only a conclusive check may change it, and only after its verdict is
 * durable: every first-party candidate must be verified, and the verdict is
 * written before anything is broadcast. The durable withdrawn state is replayed
 * to every authenticating tab until a newer issuance of the offer is shown. An empty verdict also needs CeraLive's verified source in the
 * refreshed inventory. Contract:
 * apps/backend/docs/agents/a-persistent-notification-must-be-retractable.md.
 */
import type { UpdatePackage } from "@ceraui/rpc";
import type { NotificationIssuance } from "@ceraui/rpc/schemas";
import { z } from "zod";

import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import { logger } from "../../helpers/logger.ts";
import type { SpawnWithTimeoutResult } from "../../helpers/spawn-policy.ts";
import { isNotificationDismissed } from "../ui/notification-dismissals.ts";
import {
	notificationBroadcast,
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
// Shared by writer and reader, so every record a check commits is readable at restart.
const RECORD_LIMIT = STORED_STATE_LIMITS.scalar;
// Keeps the largest exact-roster record within RECORD_LIMIT (pinned by the restart test).
export const OFFER_VERSION_LIMIT = 160;

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
				version: z
					.string()
					.max(OFFER_VERSION_LIMIT)
					.regex(APT_SIMULATION_VERSION_RE),
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
// The one durable state: the current issuance's packages, or `null` once a
// conclusive check proved none. `generation` counts the issuances of `lineage`
// (a fresh UUID whenever no valid record exists), so an issuance is never reused.
const recordSchema = z
	.object({
		version: z.literal(3),
		lineage: z.string().uuid(),
		generation: z.number().int().min(0),
		offer: offerSchema.min(1).nullable(),
	})
	.strict()
	.refine((record) => record.offer === null || record.generation >= 1);
type OfferRecord = z.infer<typeof recordSchema>;

type Store = {
	readonly path: string;
	readonly write: (path: string, text: string) => void;
};

export type CeraliveUpdateNoticeOptions = {
	readonly path?: string;
	readonly write?: (path: string, text: string) => void;
};

// Inert until startup opts in, so a process that never initializes writes nothing.
let store: Store | undefined;
let state: OfferRecord | undefined;
let persisted: string | undefined;
// Whether this process's own conclusive check produced `state` (else it was restored).
let proven = false;

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

function issuance(record: OfferRecord): NotificationIssuance {
	return { lineage: record.lineage, generation: record.generation };
}

// A verdict this process proved removes every copy, in order on each socket.
// One restored from disk is scoped to this lineage's issuances up to its
// generation; frontends that predate the scope remove by name, which clears
// the pre-upgrade copy they hold (the documented trade-off).
function withdraw(record: OfferRecord): void {
	notificationWithdraw(NOTICE, proven ? undefined : issuance(record));
}

function publish(
	record: OfferRecord,
	offer: readonly PinnedAptPackage[],
): void {
	const acknowledged = dismissed(offer);
	if (acknowledged === undefined) return;
	// A dismissed successor must not keep its predecessor on screen.
	if (acknowledged) {
		withdraw(record);
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
			issuance: issuance(record),
		},
	);
}

// None keeps the generation; the same packages keep the issuance; anything else,
// including the same packages offered again after a withdrawal, is a new issuance.
function nextRecord(offer: readonly PinnedAptPackage[]): OfferRecord {
	const current: OfferRecord = state ?? {
		version: 3,
		lineage: crypto.randomUUID(),
		generation: 0,
		offer: null,
	};
	if (offer.length === 0) return { ...current, offer: null };
	if (
		current.offer !== null &&
		dismissalKey(current.offer) === dismissalKey(offer)
	)
		return current;
	return { ...current, generation: current.generation + 1, offer: [...offer] };
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
	if (store === undefined) {
		state = record;
		return true;
	}
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
	state = record;
	logger.info("CeraLive update notice verdict", {
		offer: record.offer === null ? "none" : dismissalKey(record.offer),
		generation: record.generation,
	});
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

/** Applies a conclusive check's verdict; `unknown` leaves the notice as it is. */
export function reconcileCeraliveUpdateNotice(verdict: CeraliveOffer): void {
	if (verdict === "unknown") return;
	const offer = [...verdict].sort((a, b) =>
		compareAptPackageNames(a.name, b.name),
	);
	const record = nextRecord(offer);
	// A change that is not durable is not made, so no restart can act on an older verdict.
	if (!persist(record)) return;
	proven = true;
	// Sent on every conclusive check, so a tab that missed one still hears it.
	if (record.offer === null) withdraw(record);
	else publish(record, record.offer);
}

/**
 * Startup restores the durable withdrawn state: while the record says none (or
 * its offer was dismissed) every authenticating tab is told, until a check
 * shows a newer issuance. Startup never republishes an offer from the record.
 */
export function initCeraliveUpdateNotice(
	options: CeraliveUpdateNoticeOptions = {},
): void {
	store = {
		path: options.path ?? RECORD_FILE,
		write: options.write ?? writeFileAtomicSync,
	};
	state = undefined;
	persisted = undefined;
	proven = false;
	const record = readRecord(store.path);
	if (record === undefined) return;
	state = record;
	persisted = JSON.stringify(record);
	if (record.offer === null || dismissed(record.offer) === true)
		withdraw(record);
}
