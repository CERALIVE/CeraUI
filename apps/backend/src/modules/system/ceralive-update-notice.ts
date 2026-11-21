/*
 * The "A CeraLive update is available" notice (`ceralive_update`).
 *
 * Only a conclusive check may change it, and only after its verdict is
 * durable: every first-party candidate must be verified, and the verdict is
 * written (with this boot's id) before anything is broadcast. Contract:
 * apps/backend/docs/agents/a-persistent-notification-must-be-retractable.md.
 */
import { readFileSync } from "node:fs";
import type { UpdatePackage } from "@ceraui/rpc";
import { z } from "zod";

import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import { logger } from "../../helpers/logger.ts";
import type { SpawnWithTimeoutResult } from "../../helpers/spawn-policy.ts";
import { isNotificationDismissed } from "../ui/notification-dismissals.ts";
import {
	notificationBroadcast,
	notificationExists,
	notificationWithdraw,
} from "../ui/notifications.ts";
import {
	AptAllRefusalError,
	discoverAptAllPackages,
	type PinnedAptPackage,
} from "./apt-all-packages.ts";
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
import { updateDismissalKey } from "./update-state.ts";

const NOTICE = "ceralive_update";
const RECORD_FILE = "ceralive_update_offer.json";
const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";

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
				version: z.string().regex(APT_SIMULATION_VERSION_RE),
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
const recordSchema = z
	.object({
		version: z.literal(1),
		boot: z.string().min(1),
		offer: offerSchema,
	})
	.strict();

type Store = {
	readonly path: string;
	readonly boot: string | undefined;
	readonly write: (path: string, text: string) => void;
};

export type CeraliveUpdateNoticeOptions = {
	readonly path?: string;
	readonly boot?: string | undefined;
	readonly write?: (path: string, text: string) => void;
};

// Inert until startup opts in, so a process that never initializes writes nothing.
let store: Store | undefined;
let persisted: string | undefined;
let withdrawn = false;

export function firstPartyOffer(
	packages: readonly UpdatePackage[],
): CeraliveOffer {
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

/** Legacy: verify the exact install plan's first-party rows the way capable discovery does. */
export async function legacyCeraliveOffer(
	names: readonly string[],
	plan: readonly string[],
	run: AptRun,
): Promise<CeraliveOffer> {
	if (names.length === 0) return [];
	const simulation = await run([
		"/usr/bin/apt-get",
		"-s",
		"-o",
		"Debug::NoLocking=1",
		...plan,
	]);
	const inventory = await run(["/usr/bin/apt-cache", "policy"]);
	if (simulation.exitCode !== 0 || inventory.exitCode !== 0) return "unknown";
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
		const offer = firstPartyOffer(packages);
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

function withdraw(): void {
	if (withdrawn && notificationExists(NOTICE) === undefined) return;
	notificationWithdraw(NOTICE);
	withdrawn = true;
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
	withdrawn = false;
}

function recordText(boot: string, offer: readonly PinnedAptPackage[]): string {
	return JSON.stringify({ version: 1, boot, offer });
}

function persist(offer: readonly PinnedAptPackage[]): boolean {
	if (store === undefined) return true;
	const text = recordText(store.boot ?? "", offer);
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
	logger.info("CeraLive update notice verdict", {
		offer: offer.length > 0 ? dismissalKey(offer) : "none",
	});
	return true;
}

function readRecord(path: string) {
	try {
		const text = readStoredStateFileSync(path, STORED_STATE_LIMITS.scalar);
		return text === null ? undefined : recordSchema.parse(JSON.parse(text));
	} catch (error) {
		logger.warn("CeraLive update offer record ignored", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function readBootId(): string | undefined {
	try {
		return readFileSync(BOOT_ID_FILE, "utf8").trim() || undefined;
	} catch (error) {
		logger.warn("CeraLive update notice: boot id unreadable", {
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
	// A change that is not durable is not made, so no restart can act on an older verdict.
	if (!persist(offer)) return;
	if (offer.length === 0) withdraw();
	else publish(offer);
}

/** Startup restores only withdrawals proven by this boot's latest durable verdict. */
export function initCeraliveUpdateNotice(
	options: CeraliveUpdateNoticeOptions = {},
): void {
	store = {
		path: options.path ?? RECORD_FILE,
		boot: "boot" in options ? options.boot : readBootId(),
		write: options.write ?? writeFileAtomicSync,
	};
	persisted = undefined;
	withdrawn = false;
	const record = readRecord(store.path);
	if (record === undefined) return;
	persisted = recordText(record.boot, record.offer);
	if (record.boot !== store.boot) return;
	if (record.offer.length === 0 || dismissed(record.offer) === true) withdraw();
}
