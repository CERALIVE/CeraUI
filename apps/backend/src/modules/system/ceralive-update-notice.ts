/*
 * The "A CeraLive update is available" notice (`ceralive_update`).
 *
 * Only a conclusive check may change it, and only after its verdict is
 * durable: every first-party candidate must be verified, and the verdict is
 * written before anything is broadcast, together with the hash of the one
 * evidence snapshot the verdict was derived from. A recorded withdrawal reaches a
 * tab only while the evidence read at that moment hashes the same. An empty verdict also needs CeraLive's verified source in the
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
	removalFrames,
	setAuthenticatedReplay,
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
// for none) and `inputs`, the hash of the one evidence snapshot it was derived
// from (see readOfferSnapshot). No counter or identity to rewind.
const recordSchema = z
	.object({
		version: z.literal(5),
		inputs: z.string().regex(/^[0-9a-f]{64}$/),
		offer: offerSchema.min(1).nullable(),
	})
	.strict();
type OfferRecord = z.infer<typeof recordSchema>;

/** One read of the local evidence an offer verdict depends on. */
export type OfferSnapshot = {
	// The verified CeraLive package files APT lists (suite and architecture).
	readonly sources: readonly string[];
	readonly packages: readonly {
		readonly name: string;
		// dpkg's "want ok state" and version; empty when dpkg does not know the package.
		readonly status: string;
		readonly installed: string;
		// APT's view, with the candidate's version-table lines (priority and package file).
		readonly policyInstalled: string;
		readonly candidate: string;
		readonly candidateFrom: readonly string[];
		readonly held: boolean;
	}[];
};

type Store = {
	readonly path: string;
	readonly write: (path: string, text: string) => void;
	readonly snapshot: () => Promise<OfferSnapshot | undefined>;
};

export type CeraliveUpdateNoticeOptions = {
	readonly path?: string;
	readonly write?: (path: string, text: string) => void;
	// Reads the current evidence; a replay happens only when it hashes to the record's.
	readonly snapshot?: () => Promise<OfferSnapshot | undefined>;
};

// Inert until startup opts in, so a process that never initializes writes nothing.
let store: Store | undefined;
let latest: OfferRecord | undefined;
let persisted: string | undefined;
let reading: Promise<OfferSnapshot | undefined> | undefined;

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
 * Reads, once, everything an offer verdict depends on: the verified CeraLive
 * package files, each roster package's APT policy (installed, candidate and the
 * candidate's version-table lines), the APT holds, and dpkg's status. All local;
 * any failure yields no snapshot, which never authorizes a change.
 */
export async function readOfferSnapshot(
	run: AptRun,
	// The source inventory when the caller already read it in this check.
	read?: string,
): Promise<OfferSnapshot | undefined> {
	try {
		const [inventory, policy, holds, dpkg] = await Promise.all([
			read ??
				run(["/usr/bin/apt-cache", "policy"]).then((result) =>
					result.exitCode === 0 ? result.stdout : undefined,
				),
			run(["/usr/bin/apt-cache", "policy", ...ceralivePackageList]),
			run(["/usr/bin/apt-mark", "showhold"]),
			run([
				"/usr/bin/dpkg-query",
				"-W",
				"-f",
				"$" + "{Package}\t$" + "{Status}\t$" + "{Version}\n",
				...ceralivePackageList,
			]),
		]);
		// dpkg-query exits 1 when some names are unknown; it still lists the known ones.
		if (
			inventory === undefined ||
			policy.exitCode !== 0 ||
			holds.exitCode !== 0 ||
			dpkg.exitCode > 1
		)
			return undefined;
		const sources = [...policySources(inventory)]
			.filter(([, origin]) => origin === FIRST_PARTY_APT_HOST)
			.map(([source]) => source)
			.sort();
		const held = new Set(holds.stdout.split(/\s+/).filter(Boolean));
		const status = new Map(
			dpkg.stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [name = "", state = "", version = ""] = line.split("\t");
					return [name, [state, version]] as const;
				}),
		);
		const blocks = new Map(
			policy.stdout
				.split(/^(?=\S+:$)/m)
				.map((block) => [block.slice(0, block.indexOf(":")), block] as const),
		);
		const packages = ceralivePackageList.map((name) => {
			const block = blocks.get(name) ?? "";
			const policyInstalled = /^\s+Installed: (\S+)$/m.exec(block)?.[1] ?? "";
			const candidate = /^\s+Candidate: (\S+)$/m.exec(block)?.[1] ?? "";
			const [state = "", installed = ""] = status.get(name) ?? [];
			return {
				name,
				status: state,
				installed,
				policyInstalled,
				candidate,
				candidateFrom: versionTableLines(block, candidate),
				held: held.has(name),
			};
		});
		return { sources, packages };
	} catch (error) {
		logger.warn("CeraLive update notice: APT evidence unreadable", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

// The "priority package-file" lines listed under `version` in a policy version table.
function versionTableLines(block: string, version: string): string[] {
	const lines: string[] = [];
	let inside = false;
	for (const line of block.split("\n")) {
		const entry = /^ (?:\*\*\*| {3}) (\S+) -?\d+$/.exec(line);
		if (entry) inside = entry[1] === version;
		else if (inside && /^ {8}-?\d+ /.test(line)) lines.push(line.trim());
	}
	return lines;
}

/**
 * The verdict a snapshot alone supports: an offer row for every installed,
 * unheld roster package whose candidate differs and comes from a verified
 * CeraLive package file, sorted by name. Unknown without a CeraLive source, for a package dpkg
 * has half-installed, when dpkg and APT disagree, or for a candidate from elsewhere.
 */
export function snapshotOffer(snapshot: OfferSnapshot): CeraliveOffer {
	if (snapshot.sources.length === 0) return "unknown";
	const offer: PinnedAptPackage[] = [];
	for (const pkg of snapshot.packages) {
		const state = pkg.status.split(" ")[2] ?? "";
		if (
			pkg.status === "" ||
			state === "not-installed" ||
			state === "config-files"
		)
			continue;
		if (state !== "installed" || pkg.installed !== pkg.policyInstalled)
			return "unknown";
		const selectedHold = pkg.status.startsWith("hold ");
		if (pkg.held || selectedHold || pkg.candidate === pkg.installed) continue;
		if (pkg.candidate === "(none)") continue;
		const fromCeralive = pkg.candidateFrom.some((line) =>
			snapshot.sources.includes(line.replace(/^-?\d+ /, "")),
		);
		if (!fromCeralive) return "unknown";
		offer.push({ name: pkg.name, version: pkg.candidate });
	}
	return offer.sort((a, b) => compareAptPackageNames(a.name, b.name));
}

function fingerprint(snapshot: OfferSnapshot): string {
	return new Bun.CryptoHasher("sha256")
		.update(JSON.stringify(snapshot))
		.digest("hex");
}

function sameOffer(
	a: readonly PinnedAptPackage[],
	b: readonly PinnedAptPackage[],
): boolean {
	return (
		a.length === b.length &&
		a.every(
			(row, i) => row.name === b[i]?.name && row.version === b[i]?.version,
		)
	);
}

function publish(offer: readonly PinnedAptPackage[]): void {
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
			offer: record.offer === null ? "none" : dismissalKey(record.offer),
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
 * Applies a conclusive check's verdict together with the evidence snapshot read
 * after it. Only a verdict the snapshot alone supports is committed, with the
 * snapshot's hash in the same record; `unknown`, a missing snapshot or a
 * disagreement (the state moved between the reads) change nothing.
 */
export function reconcileCeraliveUpdateNotice(
	verdict: CeraliveOffer,
	snapshot: OfferSnapshot | undefined,
): void {
	if (verdict === "unknown" || snapshot === undefined) return;
	const offer = [...verdict].sort((a, b) =>
		compareAptPackageNames(a.name, b.name),
	);
	const supported = snapshotOffer(snapshot);
	if (supported === "unknown" || !sameOffer(supported, offer)) {
		logger.warn(
			"CeraLive update notice unchanged: verdict and evidence disagree",
		);
		return;
	}
	const record: OfferRecord = {
		version: 5,
		inputs: fingerprint(snapshot),
		offer: offer.length > 0 ? offer : null,
	};
	// A change that is not durable is not made, so no restart can act on an older verdict.
	if (!persist(record)) return;
	// Sent on every conclusive check, so a connected tab that missed one still hears it.
	if (record.offer === null) notificationWithdraw(NOTICE);
	else publish(record.offer);
}

// Delivers the recorded withdrawal only if the evidence read now hashes to the
// record's and no newer verdict arrived meanwhile. Re-evaluated on every call.
async function replay(deliver: () => void): Promise<void> {
	const record = latest;
	if (store === undefined || record === undefined) return;
	if (record.offer !== null && dismissed(record.offer) !== true) return;
	reading ??= store.snapshot().finally(() => {
		reading = undefined;
	});
	const current = await reading;
	if (current === undefined || latest !== record) return;
	if (fingerprint(current) !== record.inputs) return;
	deliver();
}

/**
 * Loads the last verdict. Every authenticating tab is then told of a recorded
 * withdrawal (none, or a dismissed offer) only while the current evidence is
 * exactly the one it was derived from; otherwise the record is ignored until a
 * fresh conclusive check. Startup never republishes an offer from the record.
 * Runs after the socket is bound, so it also tells tabs that authenticated early.
 */
export async function initCeraliveUpdateNotice(
	options: CeraliveUpdateNoticeOptions = {},
): Promise<void> {
	store = {
		path: options.path ?? RECORD_FILE,
		write: options.write ?? writeFileAtomicSync,
		snapshot: options.snapshot ?? (async () => undefined),
	};
	const record = readRecord(store.path);
	latest = record;
	persisted = record === undefined ? undefined : JSON.stringify(record);
	setAuthenticatedReplay((send) =>
		replay(() => {
			for (const frame of removalFrames(NOTICE)) send(frame);
		}),
	);
	await replay(() => notificationWithdraw(NOTICE));
}
