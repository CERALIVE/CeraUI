/*
 * The "A CeraLive update is available" notice (`ceralive_update`).
 *
 * It is withdrawn only on positive evidence: a conclusive check that finds no
 * first-party update pending, or dpkg showing every offered package instance
 * installed at or above its offered version (the readback `system.updateOutcome`
 * uses). dpkg is read in the update's own result step, while the update still
 * holds the updater (withdrawn in that process only, so its restart reads dpkg
 * again), and at startup for a stored offer (recorded as none, so no later
 * process acts on it). A restart or a login decides nothing by itself, and
 * nothing unread, partial or ambiguous withdraws. Contract:
 * apps/backend/docs/agents/a-persistent-notification-must-be-retractable.md.
 */
import type { UpdatePackage } from "@ceraui/rpc";
import type { UpdateTarget } from "@ceraui/rpc/schemas";
import { z } from "zod";

import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import { logger } from "../../helpers/logger.ts";
import {
	type SpawnWithTimeoutResult,
	spawnWithTimeout,
} from "../../helpers/spawn-policy.ts";
import { isNotificationDismissed } from "../ui/notification-dismissals.ts";
import {
	notificationBroadcast,
	notificationWithdraw,
	removalFrames,
	setAuthenticatedReplay,
} from "../ui/notifications.ts";
import { admittedTargets, candidateOrigin } from "./apt-all-packages.ts";
import { policySources } from "./apt-all-source-policy.ts";
import {
	APT_PACKAGE_NAME_RE,
	compareAptPackageNames,
} from "./apt-package-name.ts";
import { APT_SIMULATION_VERSION_RE } from "./apt-simulation-row.ts";
import { FIRST_PARTY_APT_HOST } from "./apt-source-origins.ts";
import { classifyPackageLayer } from "./package-layer.ts";
import { targetsAttained } from "./software-update-outcome.ts";
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
export const ARCH_LIMIT = 16;

/** One package instance Install takes: its name, the candidate's architecture and version. */
export type OfferedPackage = Readonly<Required<Omit<UpdateTarget, "from">>>;

/** The first-party packages Install would take; an empty list proves none remain. */
export type CeraliveOffer = readonly OfferedPackage[] | "unknown";

export type AptRun = (argv: string[]) => Promise<SpawnWithTimeoutResult>;

/** What one login's delivery did, for observers. */
export type ReplayOutcome = "sent" | "declined";

const offerSchema = z
	.array(
		z
			.object({
				name: z
					.string()
					.regex(APT_PACKAGE_NAME_RE)
					.refine((name) => classifyPackageLayer(name) === "app"),
				arch: z
					.string()
					.max(ARCH_LIMIT)
					.regex(/^[a-z0-9][a-z0-9-]*$/),
				version: z
					.string()
					.max(OFFER_VERSION_LIMIT)
					.regex(APT_SIMULATION_VERSION_RE),
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
// The one durable state: the current offer, or `null` for none.
const recordSchema = z
	.object({ version: z.literal(8), offer: offerSchema.nullable() })
	.strict();
type OfferRecord = z.infer<typeof recordSchema>;

type Store = {
	readonly path: string;
	readonly write: (path: string, text: string) => void;
	readonly observe: (outcome: ReplayOutcome) => void;
	readonly run: typeof spawnWithTimeout;
};

export type CeraliveUpdateNoticeOptions = {
	readonly path?: string;
	readonly write?: (path: string, text: string) => void;
	readonly observe?: (outcome: ReplayOutcome) => void;
	readonly run?: typeof spawnWithTimeout;
};

// Inert until startup opts in, so a process that never initializes writes nothing.
let store: Store | undefined;
let latest: OfferRecord | undefined;
let persisted: string | undefined;
// This process itself established that no offer remains: a conclusive check, or dpkg.
let withdrawn = false;

/**
 * Capable: the check's verified first-party rows, each the exact instance its own
 * complete simulation plans; one unverified row means unknown.
 */
export function firstPartyOffer(
	packages: readonly UpdatePackage[],
	sourcePolicy: string,
	simulation: string,
): CeraliveOffer {
	// Without CeraLive's source in the check, "nothing listed" proves nothing.
	if (!firstPartySourceListed(sourcePolicy) || !completePlan(simulation))
		return "unknown";
	const instances = admittedTargets(simulation);
	if (instances === null) return "unknown";
	const offer: OfferedPackage[] = [];
	for (const { name, version, origin, actionable } of packages) {
		if (classifyPackageLayer(name) !== "app") continue;
		const instance = instances.find(
			(row) => row.name === name && row.version === version,
		);
		if (!actionable || origin !== FIRST_PARTY_APT_HOST || !instance)
			return "unknown";
		offer.push({ name, arch: instance.arch, version: instance.version });
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
function completePlan(simulation: string): boolean {
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
 * Legacy: the check's actionable first-party names, each with its candidate from
 * CeraLive's own source and that candidate's architecture. Read-only `apt-cache`.
 */
export async function legacyCeraliveOffer(
	names: readonly string[],
	run: AptRun,
): Promise<CeraliveOffer> {
	const inventory = await run(["/usr/bin/apt-cache", "policy"]);
	if (inventory.exitCode !== 0 || !firstPartySourceListed(inventory.stdout))
		return "unknown";
	const sources = policySources(inventory.stdout);
	const offer: OfferedPackage[] = [];
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
		const record = await run([
			"/usr/bin/apt-cache",
			"show",
			"--no-all-versions",
			name,
		]);
		const arch =
			record.exitCode === 0
				? candidateArch(record.stdout, name, candidate)
				: undefined;
		if (arch === undefined) return "unknown";
		offer.push({ name, arch, version: candidate });
	}
	return offer;
}

// The architecture of the candidate's one package record; anything else is no answer.
function candidateArch(
	record: string,
	name: string,
	candidate: string,
): string | undefined {
	const field = (key: string) =>
		[...record.matchAll(new RegExp(`^${key}: (\\S+)$`, "gm"))].map(
			(match) => match[1],
		);
	const [packages, versions, arches] = [
		field("Package"),
		field("Version"),
		field("Architecture"),
	];
	return packages.length === 1 &&
		packages[0] === name &&
		versions.length === 1 &&
		versions[0] === candidate &&
		arches.length === 1
		? arches[0]
		: undefined;
}

function dismissalKey(offer: readonly OfferedPackage[]): string {
	return updateDismissalKey({
		version: offer.map(({ name, version }) => `${name}=${version}`).join(","),
		packages: offer.map(({ name }) => name),
	});
}

function dismissed(offer: readonly OfferedPackage[]): boolean | undefined {
	try {
		return isNotificationDismissed(dismissalKey(offer));
	} catch (error) {
		logger.warn("CeraLive update notice unchanged: dismissals unreadable", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function publish(offer: readonly OfferedPackage[]): void {
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

function persist(offer: OfferedPackage[] | null): boolean {
	const record: OfferRecord = { version: 8, offer };
	const text = JSON.stringify(record);
	// The writer applies the reader's own checks, so it never commits a record a restart refuses.
	if (
		!recordSchema.safeParse(record).success ||
		Buffer.byteLength(text) > RECORD_LIMIT
	) {
		logger.warn(
			"CeraLive update notice unchanged: verdict exceeds the record",
			{ bytes: Buffer.byteLength(text) },
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
			offer: offer === null ? "none" : dismissalKey(offer),
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
		// Sent on every conclusive check, so a connected tab that missed one still hears it.
		if (persist(null)) withdraw("a conclusive check found none pending");
		return;
	}
	const sorted = [...offer].sort((a, b) =>
		compareAptPackageNames(a.name, b.name),
	);
	// A change that is not durable is not made, so no restart can act on an older verdict.
	if (!persist(sorted)) return;
	withdrawn = false;
	publish(sorted);
}

/** The offer an update taken now is proven against, or null when none stands. */
export function standingCeraliveOffer(): readonly OfferedPackage[] | null {
	return withdrawn ? null : (latest?.offer ?? null);
}

function withdraw(evidence: string): void {
	withdrawn = true;
	logger.info("CeraLive update notice withdrawn", { evidence });
	notificationWithdraw(NOTICE);
}

// dpkg shows every instance of `offer` configured at or above its offered
// version, and `offer` is still the current one. Never throws.
async function provenInstalled(
	offer: readonly OfferedPackage[],
): Promise<boolean> {
	let proven = false;
	try {
		proven =
			store !== undefined &&
			(await targetsAttained(offer, { run: store.run, now: Date.now }));
	} catch (error) {
		logger.warn("CeraLive update notice: dpkg unreadable", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	if (!proven)
		logger.info("CeraLive update notice kept: dpkg does not show the offer", {
			offer: dismissalKey(offer),
		});
	// A check that recorded a newer verdict while dpkg was read wins.
	return proven && latest?.offer === offer;
}

/**
 * The update's own successful result: dpkg showing the offer it was taken
 * against installed withdraws it in this process. The record keeps it, so the
 * next process (the update's own restart) reads dpkg again. Never throws.
 */
export async function withdrawCeraliveOfferIfInstalled(
	offer: readonly OfferedPackage[] | null,
): Promise<void> {
	if (offer !== null && (await provenInstalled(offer)))
		withdraw("dpkg shows the install's offer");
}

// A tab that logs in is told when this process established that no offer
// remains, or when the current offer is the user's dismissed release.
function deliverable(): boolean {
	if (withdrawn) return true;
	return latest?.offer != null && dismissed(latest.offer) === true;
}

/**
 * Loads the last verdict. A stored offer dpkg shows installed is recorded as
 * none and withdrawn; otherwise it is re-announced. A stored "none" proves
 * nothing. Resolves once that read is done (startup need not wait for it).
 */
export async function initCeraliveUpdateNotice(
	options: CeraliveUpdateNoticeOptions = {},
): Promise<void> {
	store = {
		path: options.path ?? RECORD_FILE,
		write: options.write ?? writeFileAtomicSync,
		observe: options.observe ?? (() => undefined),
		run: options.run ?? spawnWithTimeout,
	};
	latest = readRecord(store.path);
	persisted = latest === undefined ? undefined : JSON.stringify(latest);
	withdrawn = false;
	setAuthenticatedReplay((send) => {
		const sent = deliverable();
		if (sent) for (const frame of removalFrames(NOTICE)) send(frame);
		store?.observe(sent ? "sent" : "declined");
	});
	const offer = latest?.offer;
	if (!offer) return;
	if (await provenInstalled(offer)) {
		// Recorded first, so no later process acts on this offer again.
		if (persist(null)) withdraw("dpkg shows the stored offer");
		return;
	}
	// Unless a check replaced it, or the update withdrew it, meanwhile.
	if (latest?.offer === offer && !withdrawn) publish(offer);
}
