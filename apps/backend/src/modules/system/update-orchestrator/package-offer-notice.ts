import { createHash } from "node:crypto";
import { z } from "zod";
import { writeFileAtomicSync } from "../../../helpers/config-loader.ts";
import { logger } from "../../../helpers/logger.ts";
import type { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import {
	captureNotificationAudience,
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
		version: z.literal(1),
		offers: z.array(packageOfferSchema).max(32),
	})
	.strict();
type Record = z.infer<typeof schema>;

function offerId(offer: readonly OfferedPackage[]): string {
	const vector = offer.map(({ name, arch, version }) => [name, arch, version]);
	return `packages:${createHash("sha256").update(JSON.stringify(vector)).digest("hex")}`;
}

export function runScheduledPackageCheck() {
	const audience = captureNotificationAudience();
	return runSoftwareUpdateCheck((evidence, run) =>
		reconcileScheduledPackageOffer(evidence, run, audience),
	);
}

/**
 * The stored list contains offers, never proof. Only a conclusive check reaches
 * this owner. Exact notice names allow a live removal even after process restart
 * without removing another release in either WebSocket decoder.
 */
async function reconcileScheduledPackageOffer(
	{ offer, held, keptBack }: PackageOfferEvidence,
	run: typeof spawnWithTimeout,
	audience: ReadonlySet<AbortSignal>,
): Promise<void> {
	try {
		const text = readStoredStateFileSync(PATH, LIMIT);
		const record: Record =
			text === null
				? { version: 1, offers: [] }
				: schema.parse(parseAuthorityJson(text));
		const blocked = new Set([...held, ...keptBack]);
		const isBlocked = (set: readonly OfferedPackage[]) =>
			set.some(
				({ name, arch }) => blocked.has(name) || blocked.has(`${name}:${arch}`),
			);
		if (offer.length > 0) {
			if (isBlocked(offer) || record.offers.some(isBlocked)) return;
			const sorted = [...offer].sort((a, b) =>
				compareAptPackageNames(a.name, b.name),
			);
			const id = offerId(sorted);
			if (!record.offers.some((standing) => offerId(standing) === id)) {
				commit({ version: 1, offers: [...record.offers, sorted] });
			}
			notifyUpdate({ kind: "updates-available", id });
			return;
		}
		const deadline = Date.now() + UPDATE_OUTCOME_DEADLINE_MS;
		const proofs = new Map<string, number | undefined>();
		for (const standing of record.offers) {
			if (isBlocked(standing)) continue;
			const name = `update:updates-available:${offerId(standing)}`;
			const issuance = notificationExists(name)?.releaseRevision;
			if (await targetsAttained(standing, { run, now: Date.now, deadline })) {
				proofs.set(name, issuance);
			}
		}
		for (const [name, issuance] of proofs)
			if (notificationExists(name)?.releaseRevision !== issuance)
				proofs.delete(name);
		if (proofs.size === 0) return;
		const { recipients, hasLateSessions } = liveNotificationAudience(audience);
		// Late sessions cannot consume this result; leave the offer available for a fresh check.
		if (!hasLateSessions)
			commit({
				version: 1,
				offers: record.offers.filter(
					(standing) =>
						!proofs.has(`update:updates-available:${offerId(standing)}`),
				),
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
