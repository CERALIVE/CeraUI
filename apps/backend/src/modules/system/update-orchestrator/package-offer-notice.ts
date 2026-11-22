/*
 * The orchestrator's package notice, `update:updates-available:<id>` ("Updates
 * are available. Review them in Software Updates."), has two separate paths.
 *
 * Announce stays main's: runtime computes main's display id, and notifyUpdate
 * dedupes, dismisses and shows it unchanged. The one exception is legacy
 * images, whose display id names packages without versions: when an actionable
 * package's candidate is newer than the one its display set was last announced
 * for, `packageNoticeId` gives the notice a distinct id. An unknown, equal or
 * lower candidate keeps the id the display set has, so a failed read, a
 * restart or an upgrade from main never mints a second copy.
 *
 * Withdrawal is additive and strict. After main's cycle, a scheduled check that
 * main ran to completion may remove an earlier notice only when this process
 * recorded the exact instances that notice was announced for, the check lists
 * none of them, and one dpkg snapshot shows every one installed, configured
 * and not held at or above its candidate. The removal reaches only the
 * sessions authenticated before the check began. Startup, login and an
 * install's exit never remove anything here.
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
// Oldest entries go first past this; a dropped entry only leaves its notice as main would.
const ENTRY_LIMIT = 64;
const COMPARE_TIMEOUT_MS = 5_000;

const nameSchema = z.string().regex(APT_PACKAGE_NAME_RE);
const versionSchema = z.string().regex(APT_SIMULATION_VERSION_RE);
const idSchema = z.string().min(1).max(8192);
const recordSchema = z
	.object({
		version: z.literal(1),
		// Legacy: the id each display set was last announced under, and its candidates.
		displays: z
			.array(
				z
					.object({
						display: idSchema,
						id: idSchema,
						versions: z.record(nameSchema, versionSchema),
					})
					.strict(),
			)
			.max(ENTRY_LIMIT),
		// Each announced id and the exact instances it stands for; null when one showing had none.
		notices: z
			.array(
				z
					.object({
						id: idSchema,
						targets: z
							.array(
								z
									.object({
										name: nameSchema,
										arch: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
										version: versionSchema,
									})
									.strict(),
							)
							.min(1)
							.nullable(),
					})
					.strict(),
			)
			.max(ENTRY_LIMIT),
	})
	.strict();
type NoticeRecord = z.infer<typeof recordSchema>;
type DisplayEntry = NoticeRecord["displays"][number];

type Store = {
	readonly path: string;
	readonly write: (path: string, text: string) => void;
	readonly run: typeof spawnWithTimeout;
};

export type ScheduledPackageNoticeOptions = {
	readonly path?: string;
	readonly write?: (path: string, text: string) => void;
	readonly run?: typeof spawnWithTimeout;
};

const empty = (): NoticeRecord => ({ version: 1, displays: [], notices: [] });
// Inert until startup opts in, so a process that never initializes writes and runs nothing.
let store: Store | undefined;
let record: NoticeRecord = empty();
// Showings this process made with a receipt: notice name -> its release revision.
const issued = new Map<string, number>();

const noticeName = (id: string) => `update:updates-available:${id}`;
const bare = (name: string) => name.split(":")[0] ?? name;
const sameInstance = (a: OfferedPackage, b: OfferedPackage) =>
	a.name === b.name && a.arch === b.arch && a.version === b.version;

/** Loads the record for this process; it announces, removes and runs nothing. */
export function initScheduledPackageNotice(
	options: ScheduledPackageNoticeOptions = {},
): void {
	store = {
		path: options.path ?? RECORD_FILE,
		write: options.write ?? writeFileAtomicSync,
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

function commit(next: NoticeRecord): boolean {
	if (store === undefined) return false;
	const bounded: NoticeRecord = {
		version: 1,
		displays: next.displays.slice(-ENTRY_LIMIT),
		notices: next.notices.slice(-ENTRY_LIMIT),
	};
	let text = JSON.stringify(bounded);
	while (
		Buffer.byteLength(text) > RECORD_LIMIT &&
		bounded.displays.length + bounded.notices.length > 0
	) {
		if (bounded.notices.length >= bounded.displays.length)
			bounded.notices.shift();
		else bounded.displays.shift();
		text = JSON.stringify(bounded);
	}
	if (!recordSchema.safeParse(bounded).success) {
		logger.warn("Scheduled package notice record unchanged: invalid entry");
		return false;
	}
	try {
		store.write(store.path, text);
	} catch (error) {
		logger.warn("Scheduled package notice record unchanged: not persisted", {
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
	record = bounded;
	return true;
}

// Main's display id with these candidates in place of `unknown`, in main's order.
function versionedId(display: string, versions: Record<string, string>) {
	return display
		.split(",")
		.map((item) => {
			const name = item.slice(0, item.lastIndexOf("="));
			const version = versions[name];
			return version === undefined ? item : `${name}=${version}`;
		})
		.sort()
		.join(",");
}

async function someNewer(
	offer: readonly OfferedPackage[],
	carried: Readonly<Record<string, string>>,
): Promise<boolean> {
	for (const { name, version } of offer) {
		const before = carried[name];
		if (before === undefined || before === version || store === undefined)
			continue;
		const compared = await store
			.run(["dpkg", "--compare-versions", version, "gt", before], {
				timeoutMs: COMPARE_TIMEOUT_MS,
			})
			.catch(() => null);
		if (compared?.exitCode === 0) return true;
	}
	return false;
}

function rememberDisplay(entry: DisplayEntry): void {
	commit({
		...record,
		displays: [
			...record.displays.filter(({ display }) => display !== entry.display),
			entry,
		],
	});
}

/**
 * The id for main's display id `display`. Capable images, and any check
 * without this process's store, keep main's id. On legacy it is the id the
 * display set was last announced under (main's id the first time), replaced by
 * a new id only when an actionable candidate this check read exactly is newer
 * than the one that id carries. Never throws.
 */
export async function packageNoticeId(
	display: string,
	evidence: ScheduledPackageEvidence | undefined,
): Promise<string> {
	if (store === undefined || evidence?.image !== "legacy") return display;
	const prior = record.displays.find((entry) => entry.display === display);
	const offer = evidence.offer;
	if (offer === null) return prior?.id ?? display;
	const versions = Object.fromEntries(
		offer.map(({ name, version }) => [name, version]),
	);
	if (prior === undefined) {
		rememberDisplay({ display, id: display, versions });
		return display;
	}
	if (!(await someNewer(offer, prior.versions))) {
		// A name the entry did not carry yet is adopted, never compared away.
		if (offer.some(({ name }) => prior.versions[name] === undefined))
			rememberDisplay({
				...prior,
				versions: { ...versions, ...prior.versions },
			});
		return prior.id;
	}
	const id = versionedId(display, versions);
	rememberDisplay({ display, id, versions });
	return id;
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
 * showing with this check's exact offer is a receipt; a showing without one
 * makes the id unprovable. A copy main left as it was (still shown, or
 * dismissed) only gains this check's exact offer when it already has a
 * receipt. Changes no notice.
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
		commit({
			...record,
			notices: [
				...record.notices.filter((notice) => notice.id !== id),
				{ id, targets },
			],
		});
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
 * Removes each recorded notice this complete check proves installed: the
 * check lists none of its instances, one dpkg snapshot shows every one
 * configured, not held, at or above its candidate, and its live copy (if any)
 * is the showing this process recorded. Only sessions in `audience` are told.
 * When a session authenticated during the check, the receipt is kept so a
 * later check proves it again for that session.
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
		!commit({
			...record,
			notices: record.notices.filter(
				({ id }) => !proven.some((notice) => notice.id === id),
			),
		})
	)
		logger.warn(
			"Scheduled package notices withdrawn but still recorded: a later check sends the removal again",
		);
}
