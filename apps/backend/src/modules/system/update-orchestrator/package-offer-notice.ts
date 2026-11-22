import { createHash } from "node:crypto";
import { z } from "zod";
import { writeFileAtomicSync } from "../../../helpers/config-loader.ts";
import { logger } from "../../../helpers/logger.ts";
import type { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { notificationWithdraw } from "../../ui/notifications.ts";
import { compareAptPackageNames } from "../apt-package-name.ts";
import {
	type OfferedPackage,
	packageOfferSchema,
} from "../ceralive-update-notice.ts";
import {
	targetsAttained,
	UPDATE_OUTCOME_DEADLINE_MS,
} from "../software-update-outcome.ts";
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

/**
 * The stored list contains offers, never proof. Only a conclusive check reaches
 * this owner. Exact notice names allow a live removal even after process restart
 * without removing another release in either WebSocket decoder.
 */
export async function reconcileScheduledPackageOffer(
	offer: readonly OfferedPackage[],
	run: typeof spawnWithTimeout,
): Promise<void> {
	try {
		const text = readStoredStateFileSync(PATH, LIMIT);
		const record: Record =
			text === null
				? { version: 1, offers: [] }
				: schema.parse(parseAuthorityJson(text));
		if (offer.length > 0) {
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
		const pending: Record["offers"] = [];
		const attained: string[] = [];
		for (const standing of record.offers) {
			if (await targetsAttained(standing, { run, now: Date.now, deadline })) {
				attained.push(offerId(standing));
			} else {
				pending.push(standing);
			}
		}
		if (attained.length === 0) return;
		commit({ version: 1, offers: pending });
		for (const id of attained)
			notificationWithdraw(`update:updates-available:${id}`);
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
