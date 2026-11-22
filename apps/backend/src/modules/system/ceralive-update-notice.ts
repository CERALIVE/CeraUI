/*
 * The "A CeraLive update is available" notice (`ceralive_update`).
 *
 * Only a conclusive check may change it, and only with a verdict the
 * installer's own decision procedure (the simulated install plan and its
 * verified first-party rows) computes from command transcripts that read the
 * same twice in a row. The verdict is written with the SHA-256 of those
 * transcripts before anything is broadcast. A recorded withdrawal reaches a tab
 * only through an evidence read that started after the tab logged in and hashes
 * the same. A command that failed, timed out or answered incompletely makes the
 * read inconclusive: the offer stays and nothing is stored. Contract:
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
	buildAptAllDiscoveryArgs,
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
const INVENTORY = ["/usr/bin/apt-cache", "policy"];
const DPKG_ROSTER = [
	"/usr/bin/dpkg-query",
	"-W",
	"-f",
	"$" + "{Package}\t$" + "{Status}\t$" + "{Version}\n",
	...ceralivePackageList,
];
// dpkg-query's own words for a name it does not know; its only exit-1 answer that is evidence.
const DPKG_ABSENT = /^dpkg-query: no packages found matching (\S+)$/;

/** The first-party packages Install would take; an empty list proves none remain. */
export type CeraliveOffer = readonly PinnedAptPackage[] | "unknown";

/** A conclusive evidence read: the offer it derives and the hash of everything read. */
export type OfferEvidence = {
	readonly offer: readonly PinnedAptPackage[];
	readonly inputs: string;
};

export type AptRun = (argv: string[]) => Promise<SpawnWithTimeoutResult>;

/** What one tab's (or startup's) replay did, for observers. */
export type ReplayOutcome = "sent" | "declined";

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
// for none) and `inputs`, the hash of the transcripts it was computed from (see
// collectOfferEvidence). No counter or identity to rewind.
const recordSchema = z
	.object({
		version: z.literal(6),
		inputs: z.string().regex(/^[0-9a-f]{64}$/),
		offer: offerSchema.min(1).nullable(),
	})
	.strict();
type OfferRecord = z.infer<typeof recordSchema>;

type Store = {
	readonly path: string;
	readonly write: (path: string, text: string) => void;
	readonly evidence: () => Promise<OfferEvidence | undefined>;
	readonly observe: (outcome: ReplayOutcome) => void;
};

export type CeraliveUpdateNoticeOptions = {
	readonly path?: string;
	readonly write?: (path: string, text: string) => void;
	// Reads the current evidence; a replay happens only when it hashes to the record's.
	readonly evidence?: () => Promise<OfferEvidence | undefined>;
	readonly observe?: (outcome: ReplayOutcome) => void;
};

// Inert until startup opts in, so a process that never initializes writes nothing.
let store: Store | undefined;
let latest: OfferRecord | undefined;
let persisted: string | undefined;
// The evidence read running now, and the one queued to start after it.
let running: Promise<OfferEvidence | undefined> | undefined;
let queued: Promise<OfferEvidence | undefined> | undefined;

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

// A simulated plan's first-party rows, verified exactly as capable discovery verifies them.
async function verifiedPlanOffer(
	simulation: string,
	holds: string,
	inventory: string,
	run: AptRun,
): Promise<CeraliveOffer> {
	try {
		const { packages } = await discoverAptAllPackages(
			simulation,
			holds,
			async (name) => {
				const policy = await run(["/usr/bin/apt-cache", "policy", name]);
				if (policy.exitCode !== 0)
					throw new AptAllRefusalError("discovery_failed", "package-policy");
				return policy.stdout;
			},
			inventory,
		);
		return firstPartyOffer(packages, inventory);
	} catch (error) {
		if (error instanceof AptAllRefusalError) return "unknown";
		throw error;
	}
}

/** Capable: the installer's own `upgrade --with-new-pkgs` plan, new dependencies included. */
export async function capableCeraliveOffer(
	run: AptRun,
): Promise<CeraliveOffer> {
	const simulation = await run(buildAptAllDiscoveryArgs([]));
	if (simulation.exitCode !== 0) return "unknown";
	const holds = await run(["/usr/bin/apt-mark", "showhold"]);
	if (holds.exitCode !== 0) return "unknown";
	const inventory = await run(INVENTORY);
	if (inventory.exitCode !== 0) return "unknown";
	return verifiedPlanOffer(
		simulation.stdout,
		holds.stdout,
		inventory.stdout,
		run,
	);
}

/** Legacy: verify the exact install plan's first-party rows the way capable discovery does. */
export async function legacyCeraliveOffer(
	names: readonly string[],
	plan: readonly string[],
	run: AptRun,
): Promise<CeraliveOffer> {
	const inventory = await run(INVENTORY);
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
	const offer = await verifiedPlanOffer(
		simulation.stdout,
		"",
		inventory.stdout,
		run,
	);
	// The plan must take every first-party package discovery listed.
	return offer !== "unknown" &&
		names.every((name) => offer.some((row) => row.name === name))
		? offer
		: "unknown";
}

// Runs each distinct command once per read and keeps what it answered, in order.
function recording(
	run: AptRun,
	seeded: ReadonlyMap<string, SpawnWithTimeoutResult>,
) {
	const transcript: [string, number, string][] = [];
	const answers = new Map<string, Promise<SpawnWithTimeoutResult>>(
		[...seeded].map(([command, result]) => [command, Promise.resolve(result)]),
	);
	const recorded = new Set<string>();
	const record: AptRun = async (argv) => {
		const command = argv.join(" ");
		let answer = answers.get(command);
		if (answer === undefined) {
			answer = run(argv);
			answers.set(command, answer);
		}
		const result = await answer;
		if (!recorded.has(command)) {
			recorded.add(command);
			transcript.push([command, result.exitCode, result.stdout]);
		}
		return result;
	};
	return { transcript, run: record };
}

// APT's "Installed:" per package block of a multi-name policy; undefined on a repeated block.
function installedVersions(policy: string): Map<string, string> | undefined {
	const versions = new Map<string, string>();
	let name: string | undefined;
	for (const line of policy.split("\n")) {
		const header = /^(\S+):$/.exec(line)?.[1];
		if (header !== undefined) {
			if (versions.has(header)) return undefined;
			name = header;
			versions.set(header, "");
			continue;
		}
		const installed = /^ {2}Installed: (\S+)$/.exec(line)?.[1];
		if (installed !== undefined && name !== undefined)
			versions.set(name, installed);
	}
	return versions;
}

/**
 * dpkg's roster answer is evidence only when the query ran and accounted for
 * every name exactly once: exit 0, or exit 1 with nothing on stderr but dpkg's
 * own "no packages found" lines. A failed launch, timeout or abort (which the
 * runner reports as exit 1 with a diagnostic), a signal, a silent exit 1,
 * partial or repeated rows, a reinstall-required flag or a package mid-change
 * are not.
 */
function settledRoster(dpkg: SpawnWithTimeoutResult, policy: string): boolean {
	const absent = dpkg.stderr
		.split("\n")
		.filter(Boolean)
		.map((line) => DPKG_ABSENT.exec(line)?.[1]);
	if (
		absent.includes(undefined) ||
		dpkg.exitCode !== (absent.length > 0 ? 1 : 0)
	)
		return false;
	const rows = dpkg.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t"));
	const named = [...rows.map(([name]) => name), ...absent];
	if (
		named.length !== ceralivePackageList.length ||
		ceralivePackageList.some((name) => !named.includes(name))
	)
		return false;
	const installed = installedVersions(policy);
	return (
		installed !== undefined &&
		rows.every(([name = "", status = "", version = "", ...extra]) => {
			const [, flag, state] = status.split(" ");
			if (extra.length > 0 || flag !== "ok") return false;
			if (state === "installed") return installed.get(name) === version;
			return state === "not-installed" || state === "config-files";
		})
	);
}

/**
 * One read of the evidence the offer is decided from: `decide` runs the
 * installer's own procedure, then APT's roster policy, the holds and dpkg's
 * status are read. Every command is recorded; the hash covers all of them, so a
 * changed plan, hold, pin, origin or package state changes it. Undefined, which
 * changes nothing, when any answer is incomplete or the procedure is unsure.
 */
export async function collectOfferEvidence(
	run: AptRun,
	decide: (run: AptRun) => Promise<CeraliveOffer>,
	// The source inventory when the caller already read it in this check.
	inventory?: string,
): Promise<OfferEvidence | undefined> {
	const recorder = recording(
		run,
		new Map(
			inventory === undefined
				? []
				: [
						[
							INVENTORY.join(" "),
							{ exitCode: 0, stdout: inventory, stderr: "" },
						],
					],
		),
	);
	try {
		const offer = await decide(recorder.run);
		if (offer === "unknown") return undefined;
		const policy = await recorder.run([
			"/usr/bin/apt-cache",
			"policy",
			...ceralivePackageList,
		]);
		const holds = await recorder.run(["/usr/bin/apt-mark", "showhold"]);
		const dpkg = await recorder.run(DPKG_ROSTER);
		if (
			policy.exitCode !== 0 ||
			holds.exitCode !== 0 ||
			!settledRoster(dpkg, policy.stdout)
		)
			return undefined;
		return {
			offer: [...offer].sort((a, b) => compareAptPackageNames(a.name, b.name)),
			inputs: new Bun.CryptoHasher("sha256")
				.update(JSON.stringify(recorder.transcript))
				.digest("hex"),
		};
	} catch (error) {
		logger.warn("CeraLive update notice: APT evidence unreadable", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
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
 * Applies a conclusive check: `read` is taken twice, and only when both reads
 * are conclusive and hash the same (nothing moved while the check looked) is
 * the verdict committed, with that hash, before it is broadcast.
 */
export async function reconcileCeraliveUpdateNotice(
	read: () => Promise<OfferEvidence | undefined>,
): Promise<void> {
	const first = await read();
	const second = first === undefined ? undefined : await read();
	if (first === undefined || second === undefined) {
		logger.warn("CeraLive update notice unchanged: evidence inconclusive");
		return;
	}
	if (second.inputs !== first.inputs) {
		logger.warn("CeraLive update notice unchanged: evidence moved");
		return;
	}
	const record: OfferRecord = {
		version: 6,
		inputs: first.inputs,
		offer: first.offer.length > 0 ? [...first.offer] : null,
	};
	// A change that is not durable is not made, so no restart can act on an older verdict.
	if (!persist(record)) return;
	// Sent on every conclusive check, so a connected tab that missed one still hears it.
	if (record.offer === null) notificationWithdraw(NOTICE);
	else publish(record.offer);
}

// An evidence read that starts no earlier than this call: callers that arrive
// while one runs share the next one instead of joining it.
function readStartingNow(
	evidence: () => Promise<OfferEvidence | undefined>,
): Promise<OfferEvidence | undefined> {
	if (running === undefined) {
		running = evidence().finally(() => {
			running = undefined;
		});
		return running;
	}
	const next = (): Promise<OfferEvidence | undefined> => {
		queued = undefined;
		return readStartingNow(evidence);
	};
	queued ??= running.then(next, next);
	return queued;
}

function withdrawn(record: OfferRecord | undefined): record is OfferRecord {
	return (
		record !== undefined &&
		latest === record &&
		(record.offer === null || dismissed(record.offer) === true)
	);
}

// Delivers the recorded withdrawal only if a read that started now derives the
// record's own verdict from evidence that hashes the same.
async function replay(deliver: () => void): Promise<void> {
	const current = store;
	if (current === undefined) return;
	const record = latest;
	const evidence = withdrawn(record)
		? await readStartingNow(current.evidence)
		: undefined;
	const matches =
		evidence !== undefined &&
		withdrawn(record) &&
		evidence.inputs === record.inputs &&
		sameOffer(evidence.offer, record.offer ?? []);
	if (matches) deliver();
	current.observe(matches ? "sent" : "declined");
}

/**
 * Loads the last verdict. Every authenticating tab is then told of a recorded
 * withdrawal (none, or a dismissed offer) only while a fresh read of the
 * evidence is exactly the one it was derived from; otherwise the record is
 * ignored until a fresh conclusive check. Startup never republishes an offer
 * from the record. Runs after the socket is bound, so it also tells tabs that
 * authenticated early.
 */
export async function initCeraliveUpdateNotice(
	options: CeraliveUpdateNoticeOptions = {},
): Promise<void> {
	store = {
		path: options.path ?? RECORD_FILE,
		write: options.write ?? writeFileAtomicSync,
		evidence: options.evidence ?? (async () => undefined),
		observe: options.observe ?? (() => undefined),
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
