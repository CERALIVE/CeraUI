/*
 * Withdrawal of the orchestrator's package notice, `update:updates-available:<id>`
 * ("Updates are available. Review them in Software Updates."), on capable images.
 *
 * Announcing stays main's: runtime computes main's id and notifyUpdate dedupes,
 * dismisses and shows it unchanged. A capable id is main's `name=version` display
 * id, so every copy of it, from any backend before or after a restart, stands for
 * the same versions. Legacy ids name packages without versions, so no backend can
 * tell which release a copy shows; legacy keeps main's behavior and is never
 * withdrawn here.
 *
 * After main's cycle, a capable scheduled check that main ran to completion may
 * remove an earlier notice only when this backend recorded the exact instances it
 * was announced for, the check lists none of them, and one dpkg snapshot shows
 * every one installed, configured and not held at or above its candidate. The
 * removal reaches only the sessions authenticated before the check began.
 * Startup, login and an install's exit never remove anything here.
 */
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

const recordSchema = z
	.object({
		version: z.literal(1),
		// Each announced id and the exact instances it stands for; null when one showing had none.
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
type NoticeRecord = z.infer<typeof recordSchema>;

type Store = {
	readonly path: string;
	readonly run: typeof spawnWithTimeout;
};

export type ScheduledPackageNoticeOptions = {
	readonly path?: string;
	readonly run?: typeof spawnWithTimeout;
};

const empty = (): NoticeRecord => ({ version: 1, notices: [] });
// Inert until startup opts in, so a process that never initializes writes and runs nothing.
let store: Store | undefined;
let record: NoticeRecord = empty();
// Showings this process made with a receipt: notice name -> its release revision.
const issued = new Map<string, number>();

const noticeName = (id: string) => `update:updates-available:${id}`;
const bare = (name: string) => name.split(":")[0] ?? name;
const sameInstance = (a: OfferedPackage, b: OfferedPackage) =>
	a.name === b.name && a.arch === b.arch && a.version === b.version;

/** Loads the receipts for this process; it announces, removes and runs nothing. */
export function initScheduledPackageNotice(
	options: ScheduledPackageNoticeOptions = {},
): void {
	store = {
		path: options.path ?? RECORD_FILE,
		run: options.run ?? spawnWithTimeout,
	};
	issued.clear();
	try {
		const text = readStoredStateFileSync(store.path, RECORD_LIMIT);
		record =
			text === null ? empty() : recordSchema.parse(parseAuthorityJson(text));
	} catch (error) {
		record = empty();
		logger.warn("Scheduled package notice record ignored", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function commit(notices: NoticeRecord["notices"]): boolean {
	if (store === undefined) return false;
	const next: NoticeRecord = {
		version: 1,
		notices: notices.slice(-RECEIPT_LIMIT),
	};
	let text = JSON.stringify(next);
	while (Buffer.byteLength(text) > RECORD_LIMIT && next.notices.length > 0) {
		next.notices.shift();
		text = JSON.stringify(next);
	}
	try {
		writeFileAtomicSync(store.path, text);
	} catch (error) {
		logger.warn("Scheduled package notice record unchanged: not persisted", {
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
	record = next;
	return true;
}

function exactOffer(
	rows: readonly UpdatePackage[] | undefined,
	evidence: ScheduledPackageEvidence | undefined,
): readonly OfferedPackage[] | null {
	const actionable = (rows ?? [])
		.filter(({ actionable }) => actionable)
		.map(({ name }) => name);
	const offer = evidence?.offer ?? null;
	return offer !== null &&
		offer.length === actionable.length &&
		offer.every(({ name }) => actionable.includes(name))
		? offer
		: null;
}

/**
 * Records what main's announcement of `id` stands for, after it was made. A
 * showing with this capable check's exact offer is a receipt; a showing without
 * one makes the id unprovable. A copy main left as it was (still shown, or
 * dismissed) only gains this check's exact offer when it already has a receipt.
 * Changes no notice.
 */
export function recordPackageAnnouncement(
	id: string,
	shown: boolean,
	rows: readonly UpdatePackage[] | undefined,
	evidence: ScheduledPackageEvidence | undefined,
): void {
	if (store === undefined) return;
	const name = noticeName(id);
	const offer = exactOffer(rows, evidence);
	const prior = record.notices.find((notice) => notice.id === id);
	const merged = (targets: readonly OfferedPackage[]) => [
		...targets,
		...(offer ?? []).filter(
			(target) => !targets.some((known) => sameInstance(known, target)),
		),
	];
	const write = (targets: OfferedPackage[] | null) =>
		commit([
			...record.notices.filter((notice) => notice.id !== id),
			{ id, targets },
		]);
	if (shown) {
		const targets =
			offer === null || prior?.targets === null
				? null
				: merged(prior?.targets ?? []);
		const live = notificationExists(name);
		if (write(targets) && targets !== null && live)
			issued.set(name, live.releaseRevision);
		else issued.delete(name);
		return;
	}
	if (
		offer !== null &&
		prior?.targets &&
		notificationExists(name) &&
		merged(prior.targets).length > prior.targets.length
	)
		write(merged(prior.targets));
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
	if (store === undefined || !evidence?.listed) return;
	const listed = new Set([...evidence.listed].map(bare));
	const candidates = record.notices.flatMap(({ id, targets }) => {
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
	if (
		!hasLateSessions &&
		!commit(
			record.notices.filter(
				({ id }) => !proven.some((notice) => notice.id === id),
			),
		)
	)
		logger.warn(
			"Scheduled package notices withdrawn but still recorded: a later check sends the removal again",
		);
}
