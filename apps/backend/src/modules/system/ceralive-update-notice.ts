/*
 * The "A CeraLive update is available" notice (`ceralive_update`).
 *
 * Only a conclusive check may change it, and only after its verdict is
 * durable: every first-party candidate must be verified, and the verdict is
 * written before anything is broadcast. A restart replays a recorded withdrawal
 * only while the local APT evidence still equals what that verdict was computed from. An empty verdict also needs CeraLive's verified source in the
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
import { ceralivePackageList, classifyPackageLayer } from "./package-layer.ts";
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
// The one durable state: the last conclusive verdict (`offer` rows, or `null`
// for none) and `inputs`, the fingerprint of the local evidence it was
// computed from (see readOfferInputs). No counter or identity to rewind.
const recordSchema = z
	.object({
		version: z.literal(4),
		inputs: z.string().regex(/^[0-9a-f]{64}$/),
		offer: offerSchema.min(1).nullable(),
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
	// The current inputs fingerprint; startup replays a verdict only when it still matches.
	readonly inputs?: () => Promise<string | undefined>;
};

// Inert until startup opts in, so a process that never initializes writes nothing.
let store: Store | undefined;
let persisted: string | undefined;
// Set once this process reaches its own conclusive verdict; a slower startup gate then yields.
let concluded = false;

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

/**
 * The local evidence a verdict is a pure function of: the CeraLive package
 * files APT lists (so suite and architecture) and every exact-roster package's
 * installed and candidate versions. Any install, rollback, source change or
 * refresh that brings a new candidate changes the fingerprint.
 */
export async function readOfferInputs(
	run: AptRun,
): Promise<string | undefined> {
	const [inventory, policy] = await Promise.all([
		run(["/usr/bin/apt-cache", "policy"]),
		run(["/usr/bin/apt-cache", "policy", ...ceralivePackageList]),
	]);
	if (inventory.exitCode !== 0 || policy.exitCode !== 0) return undefined;
	const sources = [...policySources(inventory.stdout)]
		.filter(([, origin]) => origin === FIRST_PARTY_APT_HOST)
		.map(([source]) => source)
		.sort();
	const versions = new Map<string, string[]>();
	for (const [, name, installed, candidate] of policy.stdout.matchAll(
		/^(\S+):\n\s+Installed: (\S+)\n\s+Candidate: (\S+)$/gm,
	))
		versions.set(name ?? "", [installed ?? "", candidate ?? ""]);
	const packages = ceralivePackageList.map((name) => [
		name,
		...(versions.get(name) ?? []),
	]);
	return new Bun.CryptoHasher("sha256")
		.update(JSON.stringify({ sources, packages }))
		.digest("hex");
}

function withdraw(): void {
	notificationWithdraw(NOTICE);
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
	if (store === undefined || text === persisted) return true;
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
		offer: record.offer === null ? "none" : dismissalKey(record.offer),
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

/**
 * Applies a conclusive check's verdict and the fingerprint of the inputs it was
 * computed from; `unknown`, or inputs that could not be read, change nothing.
 */
export function reconcileCeraliveUpdateNotice(
	verdict: CeraliveOffer,
	inputs: string | undefined,
): void {
	if (verdict === "unknown" || inputs === undefined) return;
	const offer = [...verdict].sort((a, b) =>
		compareAptPackageNames(a.name, b.name),
	);
	const record: OfferRecord = {
		version: 4,
		inputs,
		offer: offer.length > 0 ? offer : null,
	};
	// A change that is not durable is not made, so no restart can act on an older verdict.
	if (!persist(record)) return;
	concluded = true;
	// Sent on every conclusive check, so a tab that missed one still hears it.
	if (record.offer === null) withdraw();
	else publish(record.offer);
}

/**
 * Startup replays the recorded withdrawal (none, or a dismissed offer) to every
 * authenticating tab, but only while the local evidence is exactly what that
 * verdict was computed from. Otherwise the record is ignored until a fresh
 * conclusive check: it can never erase an offer shown under other evidence.
 * Startup never republishes an offer from the record.
 */
export async function initCeraliveUpdateNotice(
	options: CeraliveUpdateNoticeOptions = {},
): Promise<void> {
	store = {
		path: options.path ?? RECORD_FILE,
		write: options.write ?? writeFileAtomicSync,
	};
	persisted = undefined;
	concluded = false;
	const record = readRecord(store.path);
	if (record === undefined) return;
	persisted = JSON.stringify(record);
	if (record.offer !== null && dismissed(record.offer) !== true) return;
	const current = await options.inputs?.();
	if (concluded || current !== record.inputs) return;
	withdraw();
}
