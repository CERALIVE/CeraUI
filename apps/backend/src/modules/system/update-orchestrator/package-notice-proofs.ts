import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { EVENT_TEXT_LIMIT } from "@ceraui/rpc/events";
import { z } from "zod";
import { APT_PACKAGE_NAME_RE } from "../apt-package-name.ts";
import { APT_SIMULATION_VERSION_RE } from "../apt-simulation-row.ts";
import { writePrivateUpdateRecord } from "./credential-ledger-io.ts";
import { orchestratorStateFilePath } from "./persistence.ts";
import { readStoredStateFileSync } from "./stored-state-file.ts";
import { parseAuthorityJson } from "./strict-authority-json.ts";

export const COMPACT_ID = /^sha256:[0-9a-f]{8}(?:-[0-9a-f]{8}){7}$/;
export const ANNOUNCED_WINDOW = 32;
// Protect the existing window even if the impending announcement is not recorded.
const CAPACITY = ANNOUNCED_WINDOW + 1;
const MAX_OFFER_LENGTH = 64 * 1024;
const MAX_FILE_BYTES = CAPACITY * (MAX_OFFER_LENGTH + 128);
// Same target budget as the software update outcome.
const MAX_TARGETS = 512;
export const PACKAGE_ARCH = /^[a-z0-9][a-z0-9-]*$/;

export type NoticeTarget = {
	readonly pkg: string;
	// null is the native or `all` instance.
	readonly arch: string | null;
	readonly version: string;
};

/** Parse every identity row without conflating bare and explicitly qualified targets. */
export function noticeTargets(offer: string): readonly NoticeTarget[] | null {
	const targets: NoticeTarget[] = [];
	const seen = new Set<string>();
	for (const item of offer.split(",")) {
		const [, name = "", version = ""] = /^([^=]+)=([^=]+)$/.exec(item) ?? [];
		const [pkg = "", arch = null, extra] = name.split(":");
		if (
			!APT_PACKAGE_NAME_RE.test(name) ||
			!APT_SIMULATION_VERSION_RE.test(version) ||
			extra !== undefined ||
			(arch !== null && !PACKAGE_ARCH.test(arch)) ||
			seen.has(name)
		)
			return null;
		seen.add(name);
		targets.push({ pkg, arch, version });
	}
	return targets.length > 0 ? targets : null;
}

export function compactId(offer: string): string {
	const hex = createHash("sha256").update(offer).digest("hex");
	// Ungrouped hex can contain a device-ID-shaped digit run in a structured log.
	return `sha256:${hex.replace(/.{8}(?=.)/g, "$&-")}`;
}

export function canRetainCompactOffer(offer: string): boolean {
	if (offer.length <= EVENT_TEXT_LIMIT || offer.length > MAX_OFFER_LENGTH)
		return false;
	const rows = offer.split(",", MAX_TARGETS + 1);
	return (
		rows.length <= MAX_TARGETS &&
		rows.sort().join(",") === offer &&
		noticeTargets(offer) !== null
	);
}

const proofSchema = z
	.strictObject({
		id: z.string().regex(COMPACT_ID),
		offer: z
			.string()
			.min(EVENT_TEXT_LIMIT + 1)
			.max(MAX_OFFER_LENGTH),
	})
	.refine(
		({ id, offer }) => canRetainCompactOffer(offer) && compactId(offer) === id,
	);
const fileSchema = z
	.strictObject({
		schema: z.literal(1),
		offers: z.array(proofSchema).max(CAPACITY),
	})
	.refine(
		({ offers }) => new Set(offers.map(({ id }) => id)).size === offers.length,
	);

const proofPath = () =>
	join(dirname(orchestratorStateFilePath()), "scheduled-package-notices.json");

export function readCompactOffers(): Map<string, string> {
	const text = readStoredStateFileSync(proofPath(), MAX_FILE_BYTES);
	const offers =
		text === null ? [] : fileSchema.parse(parseAuthorityJson(text)).offers;
	return new Map(offers.map(({ id, offer }) => [id, offer]));
}

/** Store offer inputs only. Neither this file nor its absence proves installation. */
export function rememberCompactOffer(
	id: string,
	offer: string,
	announcedIds: () => ReadonlySet<string>,
): void {
	const previous = readCompactOffers();
	if (previous.get(id) === offer) return;
	if (previous.size >= CAPACITY && !previous.has(id)) {
		const protectedIds = announcedIds();
		for (const old of previous.keys()) {
			if (!protectedIds.has(old)) {
				previous.delete(old);
				break;
			}
		}
	}
	previous.set(id, offer);
	const record = fileSchema.parse({
		schema: 1,
		offers: [...previous].map(([id, offer]) => ({ id, offer })),
	});
	const text = JSON.stringify(record);
	if (Buffer.byteLength(text) > MAX_FILE_BYTES)
		throw new RangeError(
			"scheduled package notice proof file exceeds its bound",
		);
	writePrivateUpdateRecord(proofPath(), text);
}
