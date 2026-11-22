/*
 * Withdrawal of the orchestrator's package notice, `update:updates-available:<id>`
 * ("Updates are available. Review them in Software Updates."), on capable images.
 *
 * Announcing stays main's: runtime computes main's id and notifyUpdate dedupes,
 * dismisses and shows it unchanged. A receipt records the exact instances (name,
 * architecture, candidate) a showing of an id stood for, and holds only in its
 * lineage: this boot and this exact backend executable. A rollback, a downgrade
 * or a reinstall replaces the executable and another OS slot needs a reboot; any
 * of them may have shown the same id for another offer, so a receipt from before
 * is discarded. Inside a lineage, announcing a recorded id for any other exact set
 * poisons its receipt before the show. Legacy checks carry no capable evidence and
 * never read, write or remove receipts.
 *
 * After main's cycle, a complete capable check may remove an earlier notice only
 * when the check lists none of its receipt's instances and one dpkg snapshot shows
 * every one installed, configured and not held at or above its candidate. The
 * removal reaches only the sessions authenticated before the check began.
 * Startup, login and an install's exit never remove anything here.
 */
import { readFileSync, rmSync, statSync } from "node:fs";
import type { UpdatePackage } from "@ceraui/rpc";
import { z } from "zod";

import { writeFileAtomicSync } from "../../../helpers/config-loader.ts";
import { logger } from "../../../helpers/logger.ts";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import {
	liveNotificationAudience,
	notificationExists,
	notificationWithdraw,
} from "../../ui/notifications.ts";
import { APT_PACKAGE_NAME_RE } from "../apt-package-name.ts";
import { APT_SIMULATION_VERSION_RE } from "../apt-simulation-row.ts";
import type { OfferedPackage } from "../ceralive-update-notice.ts";
import { targetSetsAttained } from "../software-update-outcome.ts";
import type { ScheduledPackageEvidence } from "../software-updates.ts";
import {
	readStoredStateFileSync,
	STORED_STATE_LIMITS,
} from "./stored-state-file.ts";
import { parseAuthorityJson } from "./strict-authority-json.ts";

const RECORD_FILE = "scheduled_package_notices.json";
const RECORD_LIMIT = STORED_STATE_LIMITS.agent;
// Oldest receipts go first past this; a dropped receipt only leaves its notice as main would.
const RECEIPT_LIMIT = 64;
const BOOT_ID = "/proc/sys/kernel/random/boot_id";
// The running executable itself, even after its file was replaced.
const BACKEND = "/proc/self/exe";

const recordSchema = z
	.object({
		version: z.literal(2),
		lineage: z.string().min(1).max(512),
		// Each announced id and the exact instances it stands for; null when that is unknown.
		notices: z
			.array(
				z
					.object({
						id: z.string().min(1).max(8192),
						targets: z
							.array(
								z
									.object({
										name: z.string().regex(APT_PACKAGE_NAME_RE),
										arch: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
										version: z.string().regex(APT_SIMULATION_VERSION_RE),
									})
									.strict(),
							)
							.min(1)
							.nullable(),
					})
					.strict(),
			)
			.max(RECEIPT_LIMIT),
	})
	.strict();
type Receipts = z.infer<typeof recordSchema>["notices"];

type Store = {
	readonly path: string;
	readonly run: typeof spawnWithTimeout;
	readonly read: (path: string) => string | null;
	readonly write: (path: string, text: string) => void;
	readonly lineage: string | null;
};

export type ScheduledPackageNoticeOptions = {
	readonly path?: string;
	readonly run?: typeof spawnWithTimeout;
	// Where this boot's id and this backend's executable are read (tests stand in for both).
	readonly boot?: string;
	readonly backend?: string;
	readonly read?: (path: string) => string | null;
	readonly write?: (path: string, text: string) => void;
};

// Inert until startup opts in, so a process that never initializes writes and runs nothing.
let store: Store | undefined;
// Whether this process read and rewrote the receipts; unknown until its first capable check.
let trusted: boolean | undefined;
let receipts: Receipts = [];
// Showings this process made with a receipt: notice name -> its release revision.
const issued = new Map<string, number>();

const noticeName = (id: string) => `update:updates-available:${id}`;
const bare = (name: string) => name.split(":")[0] ?? name;
const sameInstance = (a: OfferedPackage, b: OfferedPackage) =>
	a.name === b.name && a.arch === b.arch && a.version === b.version;
const sameSet = (a: readonly OfferedPackage[], b: readonly OfferedPackage[]) =>
	a.length === b.length &&
	a.every((target) => b.some((other) => sameInstance(target, other)));
const errorText = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

function lineageOf(boot: string, backend: string): string | null {
	try {
		const id = readFileSync(boot, "utf8").trim();
		const { dev, ino, ctimeNs } = statSync(backend, { bigint: true });
		if (id !== "") return `${id}:${dev}:${ino}:${ctimeNs}`;
	} catch (error) {
		logger.warn("Scheduled package notices are never withdrawn: no lineage", {
			error: errorText(error),
		});
	}
	return null;
}

/** Configures this process's receipts; reads, writes, announces and removes nothing. */
export function initScheduledPackageNotice(
	options: ScheduledPackageNoticeOptions = {},
): void {
	store = {
		path: options.path ?? RECORD_FILE,
		run: options.run ?? spawnWithTimeout,
		read:
			options.read ?? ((path) => readStoredStateFileSync(path, RECORD_LIMIT)),
		write: options.write ?? writeFileAtomicSync,
		lineage: lineageOf(options.boot ?? BOOT_ID, options.backend ?? BACKEND),
	};
	trusted = undefined;
	receipts = [];
	issued.clear();
}

// A write that failed leaves no receipt behind: one that could not change (or be
// poisoned) must not outlive this process either.
function commit(next: Receipts): boolean {
	if (store?.lineage == null) return false;
	const record = {
		version: 2,
		lineage: store.lineage,
		notices: next.slice(-RECEIPT_LIMIT),
	};
	let text = JSON.stringify(record);
	while (Buffer.byteLength(text) > RECORD_LIMIT && record.notices.length > 0) {
		record.notices.shift();
		text = JSON.stringify(record);
	}
	try {
		store.write(store.path, text);
	} catch (error) {
		trusted = false;
		receipts = [];
		issued.clear();
		try {
			rmSync(store.path, { force: true });
		} catch (removal) {
			logger.warn("Scheduled package notice receipts could not be removed", {
				error: errorText(removal),
			});
		}
		logger.warn("Scheduled package notice receipts dropped: not persisted", {
			error: errorText(error),
		});
		return false;
	}
	receipts = record.notices;
	return true;
}

// Read on the first capable check and trusted only once this process rewrote them:
// storage that refuses writes could not record a later poisoning.
function loaded(): boolean {
	if (store?.lineage == null) return false;
	if (trusted !== undefined) return trusted;
	let kept: Receipts = [];
	try {
		const text = store.read(store.path);
		const record =
			text === null ? null : recordSchema.parse(parseAuthorityJson(text));
		if (record?.lineage === store.lineage) kept = record.notices;
	} catch (error) {
		logger.warn("Scheduled package notice record ignored", {
			error: errorText(error),
		});
	}
	trusted = commit(kept);
	return trusted;
}

// This check's exact offer, bound to the id: every row carries the version the id
// names, and each actionable row is exactly one planned instance at that version.
function exactOffer(
	rows: readonly UpdatePackage[] | undefined,
	evidence: ScheduledPackageEvidence,
): readonly OfferedPackage[] | null {
	const offer = evidence.offer;
	if (offer === null || !rows?.every(({ version }) => version !== undefined))
		return null;
	const actionable = rows.filter(({ actionable }) => actionable);
	return offer.length === actionable.length &&
		actionable.every((row) =>
			offer.some(
				(target) => target.name === row.name && target.version === row.version,
			),
		)
		? offer
		: null;
}

/**
 * Before main's announcement of `id`: a receipt for it that names any other exact
 * set than this check's (or this check has none) no longer says what a copy stands
 * for, so it is poisoned before the show. Changes no notice.
 */
export function preparePackageAnnouncement(
	id: string,
	rows: readonly UpdatePackage[] | undefined,
	evidence: ScheduledPackageEvidence | undefined,
): void {
	if (evidence === undefined || !loaded()) return;
	const prior = receipts.find((notice) => notice.id === id)?.targets;
	const offer = exactOffer(rows, evidence);
	if (prior && !(offer !== null && sameSet(prior, offer)))
		commit([
			...receipts.filter((notice) => notice.id !== id),
			{ id, targets: null },
		]);
}

/**
 * After main's announcement: a showing of an id without a receipt records this
 * check's exact offer, or null when it has none. Changes no notice.
 */
export function recordPackageAnnouncement(
	id: string,
	shown: boolean,
	rows: readonly UpdatePackage[] | undefined,
	evidence: ScheduledPackageEvidence | undefined,
): void {
	if (evidence === undefined || !shown || !loaded()) return;
	const name = noticeName(id);
	const offer = exactOffer(rows, evidence);
	if (
		!receipts.some((notice) => notice.id === id) &&
		!commit([...receipts, { id, targets: offer && [...offer] }])
	)
		return;
	const live = notificationExists(name);
	if (live && receipts.find((notice) => notice.id === id)?.targets)
		issued.set(name, live.releaseRevision);
	else issued.delete(name);
}

/**
 * Removes each recorded notice this complete capable check proves installed: the
 * check lists none of its instances, one dpkg snapshot shows every one
 * configured, not held, at or above its candidate, and its live copy (if any) is
 * the showing this process recorded. Only sessions in `audience` are told. When
 * a session authenticated during the check, the receipt is kept so a later
 * check proves it again for that session.
 */
export async function withdrawProvenPackageNotices(
	audience: ReadonlySet<AbortSignal>,
	evidence: ScheduledPackageEvidence | undefined,
	announced: string | undefined,
): Promise<void> {
	if (store === undefined || !evidence?.listed || !loaded()) return;
	const listed = new Set([...evidence.listed].map(bare));
	const candidates = receipts.flatMap(({ id, targets }) => {
		const name = noticeName(id);
		const issuance = notificationExists(name)?.releaseRevision;
		return targets !== null &&
			id !== announced &&
			!targets.some((target) => listed.has(bare(target.name))) &&
			(issuance === undefined || issued.get(name) === issuance)
			? [{ id, name, targets, issuance }]
			: [];
	});
	if (candidates.length === 0) return;
	const verdicts = await targetSetsAttained(
		candidates.map(({ targets }) => targets),
		{ run: store.run, now: Date.now },
	);
	const proven = candidates.filter(
		({ name, issuance }, index) =>
			verdicts[index] === true &&
			notificationExists(name)?.releaseRevision === issuance,
	);
	if (proven.length === 0) return;
	const { recipients, hasLateSessions } = liveNotificationAudience(audience);
	for (const { name } of proven) {
		notificationWithdraw(name, recipients);
		issued.delete(name);
	}
	logger.info(
		"Scheduled package notices withdrawn: dpkg shows them installed",
		{
			notices: proven.map(({ name }) => name),
		},
	);
	if (!hasLateSessions)
		commit(
			receipts.filter(({ id }) => !proven.some((notice) => notice.id === id)),
		);
}
