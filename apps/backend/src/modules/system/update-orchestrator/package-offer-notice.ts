import { createHash } from "node:crypto";
import type { UpdateState } from "@ceraui/rpc/schemas";
import { z } from "zod";
import { writeFileAtomicSync } from "../../../helpers/config-loader.ts";
import { logger } from "../../../helpers/logger.ts";
import type { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import {
	captureNotificationAudience,
	hasLiveNotificationForDismissal,
	liveNotificationAudience,
	notificationExists,
	notificationWithdraw,
} from "../../ui/notifications.ts";
import { compareAptPackageNames } from "../apt-package-name.ts";
import {
	type OfferedPackage,
	type PackageOfferEvidence,
	packageOfferSchema,
} from "../ceralive-update-notice.ts";
import {
	targetsAttained,
	UPDATE_OUTCOME_DEADLINE_MS,
} from "../software-update-outcome.ts";
import { runSoftwareUpdateCheck } from "../software-updates.ts";
import { notifyUpdate } from "./notifications.ts";
import {
	readStoredStateFileSync,
	STORED_STATE_LIMITS,
} from "./stored-state-file.ts";
import { parseAuthorityJson } from "./strict-authority-json.ts";

const PATH = "scheduled_package_offers.json";
const LIMIT = STORED_STATE_LIMITS.agent;
const schema = z
	.object({
		version: z.literal(2),
		offers: z
			.array(
				z
					.object({
						id: z.string().regex(/^packages:[0-9a-f]{64}$/),
						display: z.string().optional(),
						offer: packageOfferSchema,
					})
					.strict()
					.refine(
						({ id, offer, display }) => id === deliveryId(offer, display),
					),
			)
			.max(32)
			.refine(
				(offers) => new Set(offers.map(({ id }) => id)).size === offers.length,
			),
	})
	.strict();
type Record = z.infer<typeof schema>;

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deliveryId(
	offer: readonly OfferedPackage[],
	display?: string,
): string {
	const vector = offer.map(({ name, arch, version }) => [name, arch, version]);
	return `packages:${digest(display === undefined ? vector : [display, vector])}`;
}

const noticeName = (id: string) => `update:updates-available:${id}`;
type Discovery = NonNullable<Parameters<typeof runSoftwareUpdateCheck>[0]>;

export function runScheduledPackageCheck(capture?: Discovery) {
	const audience = captureNotificationAudience();
	return runSoftwareUpdateCheck(async (identity, evidence, run) => {
		await capture?.(identity, evidence, run);
		if (evidence?.offer.length === 0)
			await withdrawInstalledPackageOffers(evidence, run, audience);
	});
}

export function preparePackageAnnouncement(
	wire: Extract<UpdateState, { kind: "available" }>,
	identity?: Parameters<Discovery>[0],
	proof?: PackageOfferEvidence,
) {
	const canonical =
		wire.packages
			?.map(({ name, version }) => `${name}=${version ?? "unknown"}`)
			.sort()
			.join(",") ?? wire.identity.version;
	const versions = identity?.versions ?? [];
	const dismissalId =
		versions.length > 0 ? `legacy:${digest([canonical, versions])}` : canonical;
	const matchesWire = (rows: readonly { name: string; version: string }[]) =>
		rows.length === wire.actionable_count &&
		rows.every(({ name, version }) =>
			wire.packages?.some(
				(row) =>
					row.actionable &&
					row.name === name &&
					(row.version === undefined || row.version === version),
			),
		);
	const targets = identity?.targets;
	const sorted =
		targets && matchesWire(targets)
			? [...targets].sort((a, b) => compareAptPackageNames(a.name, b.name))
			: undefined;
	const display =
		wire.packages?.length === sorted?.length ? undefined : canonical;
	const id = sorted ? deliveryId(sorted, display) : dismissalId;
	const qualified =
		sorted &&
		proof?.offer.length === sorted.length &&
		sorted.every(({ name, arch, version }) =>
			proof.offer.some(
				(row) =>
					row.name === name && row.arch === arch && row.version === version,
			),
		);
	// The legacy estimate can keep main's previous wire state even though the
	// original plan authorizes withdrawal. Don't re-show a copy just withdrawn.
	const alreadyLiveBeforeWithdrawal =
		proof?.offer.length === 0 &&
		hasLiveNotificationForDismissal(noticeName(dismissalId));
	return () => {
		if (alreadyLiveBeforeWithdrawal) return;
		const sent = notifyUpdate(
			{ kind: "updates-available", id: dismissalId },
			{ deliveryId: id },
		);
		if (sent && qualified && sorted) recordPackageOffer(id, sorted, display);
	};
}

function recordPackageOffer(
	id: string,
	offer: OfferedPackage[],
	display?: string,
): void {
	try {
		const record = readRecord();
		if (!record.offers.some((standing) => standing.id === id))
			commit({
				version: 2,
				offers: [...record.offers, { id, offer, display }],
			});
	} catch (error) {
		logger.warn("Scheduled package announcement has no withdrawal receipt", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function readRecord(): Record {
	const text = readStoredStateFileSync(PATH, LIMIT);
	return text === null
		? { version: 2, offers: [] }
		: schema.parse(parseAuthorityJson(text));
}

/**
 * The stored list contains offers, never proof. Only a conclusive check reaches
 * this owner. Exact notice names allow a live removal even after process restart
 * without removing another release in either WebSocket decoder.
 */
async function withdrawInstalledPackageOffers(
	{ held, keptBack }: PackageOfferEvidence,
	run: typeof spawnWithTimeout,
	audience: ReadonlySet<AbortSignal>,
): Promise<void> {
	try {
		const record = readRecord();
		const blocked = new Set([...held, ...keptBack]);
		const isBlocked = (set: readonly OfferedPackage[]) =>
			set.some(({ name, arch }) => {
				const bare = name.split(":")[0] ?? name;
				return blocked.has(bare) || blocked.has(`${bare}:${arch}`);
			});
		const deadline = Date.now() + UPDATE_OUTCOME_DEADLINE_MS;
		const proofs = new Map<
			string,
			{ readonly offer: readonly OfferedPackage[]; readonly issuance?: number }
		>();
		for (const { id, offer: standing } of record.offers) {
			if (isBlocked(standing)) continue;
			const name = noticeName(id);
			const issuance = notificationExists(name)?.releaseRevision;
			if (
				await targetsAttained(standing, {
					run,
					now: Date.now,
					deadline,
					requireUnheld: true,
					onHeldInstance: (name, arch) => blocked.add(`${name}:${arch}`),
				})
			) {
				proofs.set(name, {
					offer: standing,
					...(issuance === undefined ? {} : { issuance }),
				});
			}
		}
		for (const [name, { offer, issuance }] of proofs)
			if (
				isBlocked(offer) ||
				notificationExists(name)?.releaseRevision !== issuance
			)
				proofs.delete(name);
		if (proofs.size === 0) return;
		const { recipients, hasLateSessions } = liveNotificationAudience(audience);
		// Late sessions cannot consume this result; leave the offer available for a fresh check.
		if (!hasLateSessions)
			commit({
				version: 2,
				offers: record.offers.filter(({ id }) => !proofs.has(noticeName(id))),
			});
		for (const name of proofs.keys()) notificationWithdraw(name, recipients);
	} catch (error) {
		logger.warn("Scheduled package offer notices unchanged", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function commit(record: Record): void {
	const text = JSON.stringify(record);
	if (!schema.safeParse(record).success || Buffer.byteLength(text) > LIMIT)
		throw new RangeError("Scheduled package offer record exceeds its limits");
	writeFileAtomicSync(PATH, text);
}
