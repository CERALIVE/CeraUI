/*
 * The "A CeraLive update is available" notice (`ceralive_update`).
 *
 * The slot holds at most one offer: the exact package instances (name,
 * architecture, version) of this process's latest complete check. Only a
 * complete check replaces or retires it. An unknown, partial or incomplete
 * check changes nothing, and neither does a startup, a login, a stored record
 * or a recovered install. Each new release reaches every connected tab, and a
 * login is sent the slot's copy, so every connected tab holds the slot's copy.
 * Every shipped frontend removes this notice by name, whatever release a tab
 * shows, so a removal is sent only live, to the tabs connected then, never at
 * login:
 * - after the update's own successful result, when the slot still holds the
 *   offer the update was taken against (nothing wrote it meanwhile) and dpkg
 *   shows it installed at or above its offered version (the readback
 *   `system.updateOutcome` uses);
 * - when a complete check finds none pending (dpkg showing any stored offer
 *   installed) or exactly the set the user dismissed: then no copy any tab
 *   holds can be of another pending offer.
 * Unknown always keeps the offer. Only a check writes the record. Contract:
 * apps/backend/docs/agents/a-persistent-notification-must-be-retractable.md.
 */
import type { UpdatePackage } from "@ceraui/rpc";
import type { UpdateTarget } from "@ceraui/rpc/schemas";
import { z } from "zod";

import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import { logger } from "../../helpers/logger.ts";
import {
	type SpawnWithTimeoutResult,
	spawnWithTimeout,
} from "../../helpers/spawn-policy.ts";
import { isNotificationDismissed } from "../ui/notification-dismissals.ts";
import {
	notificationBroadcast,
	notificationExists,
	notificationWithdraw,
} from "../ui/notifications.ts";
import {
	admittedTargets,
	candidateOrigin,
	isFirstPartyPackage,
} from "./apt-all-packages.ts";
import { policySources } from "./apt-all-source-policy.ts";
import {
	APT_PACKAGE_NAME_RE,
	compareAptPackageNames,
} from "./apt-package-name.ts";
import { APT_SIMULATION_VERSION_RE } from "./apt-simulation-row.ts";
import { FIRST_PARTY_APT_HOST } from "./apt-source-origins.ts";
import { classifyPackageLayer } from "./package-layer.ts";
import { targetsAttained } from "./software-update-outcome.ts";
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
export const ARCH_LIMIT = 16;

/** One package instance Install takes: its name, the candidate's architecture and version. */
export type OfferedPackage = Readonly<Required<Omit<UpdateTarget, "from">>>;

/**
 * A check's first-party verdict: the instances Install would take (an empty list
 * says none remain) when the check is conclusive and saw every first-party
 * package it plans or keeps back; anything less is unknown.
 */
export type CeraliveVerdict = readonly OfferedPackage[] | "unknown";
export type PackageOfferEvidence = {
	readonly offer: readonly OfferedPackage[];
	readonly held: ReadonlySet<string>;
	readonly keptBack: readonly string[];
};
export type ReportPackageOffer = (evidence: PackageOfferEvidence) => void;

export function readPackageHolds(stdout: string): ReadonlySet<string> | null {
	const names = stdout.trim().split(/\s+/).filter(Boolean);
	return names.every((name) => APT_PACKAGE_NAME_RE.test(name))
		? new Set(names)
		: null;
}

export type AptRun = (argv: string[]) => Promise<SpawnWithTimeoutResult>;

export const packageOfferSchema = z
	.array(
		z
			.object({
				name: z.string().regex(APT_PACKAGE_NAME_RE),
				arch: z
					.string()
					.max(ARCH_LIMIT)
					.regex(/^[a-z0-9][a-z0-9-]*$/),
				version: z
					.string()
					.max(OFFER_VERSION_LIMIT)
					.regex(APT_SIMULATION_VERSION_RE),
			})
			.strict(),
	)
	.min(1)
	.refine((rows) =>
		rows.every(
			(row, i) =>
				i === 0 ||
				compareAptPackageNames(rows[i - 1]?.name ?? "", row.name) < 0,
		),
	);
// The one durable state, written only by a check: the current offer, or `null` for none.
const recordSchema = z
	.object({
		version: z.literal(8),
		offer: packageOfferSchema
			.refine((rows) => rows.every(({ name }) => isFirstPartyPackage(name)))
			.nullable(),
	})
	.strict();
type OfferRecord = z.infer<typeof recordSchema>;

type Store = {
	readonly path: string;
	readonly write: (path: string, text: string) => void;
	readonly run: typeof spawnWithTimeout;
};

export type CeraliveUpdateNoticeOptions = {
	readonly path?: string;
	readonly write?: (path: string, text: string) => void;
	readonly run?: typeof spawnWithTimeout;
};

// Inert until startup opts in, so a process that never initializes writes nothing.
let store: Store | undefined;
let latest: OfferRecord | undefined;
let persisted: string | undefined;
// Counts every write to the slot, so a read that outlived one cannot act on it.
let slotGeneration = 0;

// Named for a first-party package, of any architecture.
// Legacy: the roster legacy Install takes and main's legacy check announced.
const rosterName = (name: string) =>
	classifyPackageLayer(name.split(":")[0] ?? "") === "app";
// Capable: the first-party set the capable path already refuses to hold, which
// contains main's capable announcement rule (`ceralive-*`, `cerastream`) and the roster.
const capableFirstParty = (name: string) =>
	isFirstPartyPackage(name.split(":")[0] ?? "");

/**
 * The refresh hit or fetched the index of every CeraLive source the check's own
 * inventory lists (the same URI and suite), and skipped none of them.
 */
function refreshedEverySource(
	refresh: string,
	sources: ReadonlyMap<string, string | null>,
	scope: "first-party" | "packages",
): boolean {
	if (![...sources.values()].includes(FIRST_PARTY_APT_HOST)) return false;
	const selected = [...sources]
		.filter(
			([, origin]) => scope === "packages" || origin === FIRST_PARTY_APT_HOST,
		)
		.map(([source]) => source.split(/\s+/));
	return (
		selected.length > 0 &&
		selected.every(([uri = "", dist = ""]) => {
			const suite = dist === "./" ? dist : (dist.split("/")[0] ?? "");
			const lines = refresh
				.split("\n")
				.filter((line) => line.split(/\s+/)[1] === uri);
			return (
				lines.some((line) =>
					new RegExp(
						`^(?:Hit|Get):\\d+ \\S+ ${suite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (?:In)?Release(?: \\[.*\\])?$`,
					).test(line),
				) && !lines.some((line) => /^(?:Ign|Err):/.test(line))
			);
		})
	);
}

/**
 * Capable: the check's verified first-party rows, each the exact instance its own
 * complete simulation plans. One unverified row, or a first-party package the
 * simulation keeps back, means unknown. `keptBack` is the simulation's kept-back
 * list when it names exactly what it counts, else null.
 */
export function capableOffer(
	check: {
		readonly packages: readonly UpdatePackage[];
		readonly sourcePolicy: string;
		readonly simulation: string;
		readonly refresh: string;
		readonly keptBack: readonly string[] | null;
	},
	scope: "first-party" | "packages",
): CeraliveVerdict {
	const { packages, sourcePolicy, simulation, refresh, keptBack } = check;
	const all = scope === "packages";
	if (
		keptBack === null ||
		(!all && keptBack.some(capableFirstParty)) ||
		(all && !/^Pinned packages:$/m.test(sourcePolicy)) ||
		!refreshedEverySource(refresh, policySources(sourcePolicy), scope) ||
		!completePlan(simulation)
	)
		return "unknown";
	const instances = admittedTargets(simulation);
	if (instances === null) return "unknown";
	if (all) {
		// A configure-only row is unfinished work even without the count line.
		const names = new Set(instances.map(({ name }) => name));
		for (const [, name] of simulation.matchAll(/^Conf (\S+)/gm))
			if (!name || !names.has(name)) return "unknown";
	}
	const offer: OfferedPackage[] = [];
	for (const { name, version, origin, actionable } of packages) {
		if (!all && !capableFirstParty(name)) continue;
		const instance = instances.find(
			(row) => row.name === name && row.version === version,
		);
		// Another architecture's instance of a first-party package is not an offer Install takes.
		if (
			name.includes(":") ||
			!actionable ||
			(!all && origin !== FIRST_PARTY_APT_HOST) ||
			!instance
		)
			return "unknown";
		offer.push({ name, arch: instance.arch, version: instance.version });
	}
	return offer;
}

const PLAN_SUMMARY =
	/^(\d+) upgraded, (\d+) newly installed, (\d+) to remove and \d+ not upgraded\.$/gm;

export function hasOnePlanSummary(output: string): boolean {
	return [...output.matchAll(PLAN_SUMMARY)].length === 1;
}

/**
 * APT's own count, printed after its summary only when nonzero, of packages a
 * transaction left unpacked or not configured: their setup is still pending
 * (configure-only work has no `Inst` row and needs no newer candidate).
 */
export function unfinishedAptWork(output: string): boolean {
	return /^[1-9]\d* not fully installed or removed\.$/m.test(output);
}

/**
 * A simulated plan is complete only with APT's single summary line, no package
 * left unfinished, and exactly the Inst and Remv rows it counts (APT prints the
 * summary before the rows, so a cut or partial answer loses rows the summary
 * still counts).
 */
function completePlan(simulation: string): boolean {
	if (unfinishedAptWork(simulation)) return false;
	const summaries = [...simulation.matchAll(PLAN_SUMMARY)];
	const summary = summaries[0];
	if (summaries.length !== 1 || summary === undefined) return false;
	const rows = (verb: string) =>
		simulation.split("\n").filter((line) => line.startsWith(`${verb} `)).length;
	return (
		rows("Inst") === Number(summary[1]) + Number(summary[2]) &&
		rows("Remv") === Number(summary[3])
	);
}

/**
 * Legacy: the check's actionable first-party names, each with its candidate from
 * CeraLive's own source and that candidate's architecture. `planned` is every
 * name the plan's upgrade, NEW, REMOVED and DOWNGRADED lists carry, `keptBack` the kept-back list when it
 * names exactly what the summary counts (else null). A first-party name either
 * carries that is not offered (a new install, another architecture, a held
 * package) makes the verdict unknown. Read-only `apt-cache`.
 */
export async function legacyOffer(
	check: {
		readonly names: readonly string[];
		readonly planned: readonly string[];
		readonly keptBack: readonly string[] | null;
		readonly refresh: string;
		readonly run: AptRun;
	},
	reportPackageOffer?: ReportPackageOffer,
): Promise<CeraliveVerdict> {
	const { names, planned, keptBack, refresh, run } = check;
	if (
		keptBack === null ||
		planned.some((name) => rosterName(name) && !names.includes(name))
	)
		return "unknown";
	const firstPartyComplete = !keptBack.some(
		(name) => rosterName(name) && !names.includes(name),
	);
	if (!firstPartyComplete && !reportPackageOffer) return "unknown";
	const inventory = await run(["/usr/bin/apt-cache", "policy"]);
	const sources = policySources(inventory.stdout);
	if (
		inventory.exitCode !== 0 ||
		!refreshedEverySource(refresh, sources, "first-party")
	)
		return "unknown";
	let packagePlanComplete =
		reportPackageOffer !== undefined &&
		inventory.stderr === "" &&
		/^Pinned packages:$/m.test(inventory.stdout) &&
		refreshedEverySource(refresh, sources, "packages");
	const offer: OfferedPackage[] = [];
	for (const name of names) {
		const policy = await run(["/usr/bin/apt-cache", "policy", name]);
		const candidate = /^\s*Candidate:\s*(\S+)/m.exec(policy.stdout)?.[1];
		if (
			policy.exitCode !== 0 ||
			candidate === undefined ||
			candidateOrigin(policy.stdout, candidate, sources) !==
				FIRST_PARTY_APT_HOST
		)
			return "unknown";
		const record = await run([
			"/usr/bin/apt-cache",
			"show",
			"--no-all-versions",
			name,
		]);
		const arch =
			record.exitCode === 0
				? candidateArch(record.stdout, name, candidate)
				: undefined;
		if (arch === undefined) return "unknown";
		const installed = /^\s*Installed:\s*(\S+)/m.exec(policy.stdout)?.[1];
		packagePlanComplete &&=
			policy.stderr === "" &&
			record.stderr === "" &&
			installed !== undefined &&
			APT_SIMULATION_VERSION_RE.test(installed) &&
			installed !== candidate;
		offer.push({ name, arch, version: candidate });
	}
	if (packagePlanComplete && reportPackageOffer) {
		const holds = await run(["/usr/bin/apt-mark", "showhold"]);
		if (holds.exitCode === 0 && holds.stderr === "") {
			const held = readPackageHolds(holds.stdout);
			if (held !== null) reportPackageOffer({ offer, held, keptBack });
		}
	}
	return firstPartyComplete ? offer : "unknown";
}

// The architecture of the candidate's one package record; anything else is no answer.
export function candidateArch(
	record: string,
	name: string,
	candidate: string,
): string | undefined {
	const field = (key: string) =>
		[...record.matchAll(new RegExp(`^${key}: (\\S+)$`, "gm"))].map(
			(match) => match[1],
		);
	const [packages, versions, arches] = [
		field("Package"),
		field("Version"),
		field("Architecture"),
	];
	return packages.length === 1 &&
		packages[0] === name &&
		versions.length === 1 &&
		versions[0] === candidate &&
		arches.length === 1
		? arches[0]
		: undefined;
}

// The offer's identity: every exact instance and its version.
function dismissalKey(offer: readonly OfferedPackage[]): string {
	return updateDismissalKey({
		version: offer
			.map(({ name, arch, version }) => `${name}:${arch}=${version}`)
			.join(","),
		packages: offer.map(({ name }) => name),
	});
}

function dismissed(offer: readonly OfferedPackage[]): boolean | undefined {
	try {
		return isNotificationDismissed(dismissalKey(offer));
	} catch (error) {
		logger.warn("CeraLive update notice unchanged: dismissals unreadable", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function withdraw(why: string): void {
	slotGeneration++;
	logger.info("CeraLive update notice withdrawn", { why });
	notificationWithdraw(NOTICE);
}

function publish(offer: readonly OfferedPackage[]): void {
	const acknowledged = dismissed(offer);
	if (acknowledged === undefined) return;
	// The complete set found is dismissed: no copy on screen can be of another pending offer.
	if (acknowledged) {
		withdraw("the complete set found is dismissed");
		return;
	}
	slotGeneration++;
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

function persist(offer: OfferedPackage[] | null): boolean {
	const record: OfferRecord = { version: 8, offer };
	const text = JSON.stringify(record);
	// The writer applies the reader's own checks, so it never commits a record a restart refuses.
	if (
		!recordSchema.safeParse(record).success ||
		Buffer.byteLength(text) > RECORD_LIMIT
	) {
		logger.warn(
			"CeraLive update notice unchanged: verdict exceeds the record",
			{ bytes: Buffer.byteLength(text) },
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
			offer: offer === null ? "none" : dismissalKey(offer),
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
 * Applies a check's own verdict. Only a complete check changes the slot or the
 * record: "unknown" changes nothing. The verdict is committed before it is
 * broadcast.
 */
export async function reconcileCeraliveUpdateNotice(
	verdict: CeraliveVerdict,
): Promise<void> {
	if (verdict === "unknown") {
		logger.warn("CeraLive update notice unchanged: check not complete");
		return;
	}
	if (verdict.length === 0) {
		const standing = latest?.offer;
		// "None pending" proves nothing about an offer dpkg does not show installed
		// (held back, pinned away, withdrawn from the archive): it stays.
		if (standing && !(await provenInstalled(standing))) return;
		if (!persist(null)) return;
		// Sent on every complete check, so a connected tab that missed one still hears it.
		withdraw("a complete check found none pending");
		return;
	}
	const sorted = [...verdict].sort((a, b) =>
		compareAptPackageNames(a.name, b.name),
	);
	// A change that is not durable is not made, so no restart can act on an older verdict.
	if (!persist(sorted)) return;
	publish(sorted);
}

/** The offer an update taken now is proven against, or null when none stands. */
export function standingCeraliveOffer(): readonly OfferedPackage[] | null {
	return latest?.offer ?? null;
}

// The slot holds `offer`: every connected tab was sent this copy (a new release is never
// rate-limited, and a login is sent the slot's copy).
function showing(offer: readonly OfferedPackage[]): boolean {
	return notificationExists(NOTICE)?.dismissalKey === dismissalKey(offer);
}

// dpkg shows every instance of `offer` configured at or above its offered
// version, and `offer` is still the current one. Never throws.
async function provenInstalled(
	offer: readonly OfferedPackage[],
): Promise<boolean> {
	let proven = false;
	try {
		proven =
			store !== undefined &&
			(await targetsAttained(offer, { run: store.run, now: Date.now }));
	} catch (error) {
		logger.warn("CeraLive update notice: dpkg unreadable", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	if (!proven)
		logger.info("CeraLive update notice kept: dpkg does not show the offer", {
			offer: dismissalKey(offer),
		});
	// A check that recorded a newer verdict while dpkg was read wins.
	return proven && latest?.offer === offer;
}

/**
 * The update's own successful result: when the slot holds the offer it was taken
 * against, nothing wrote the slot while dpkg was read, and dpkg shows the offer
 * installed, connected tabs drop it. A tab that logs in later is not told (its
 * copy may be another release's); the record keeps the offer for the next
 * complete check. Never throws.
 */
export async function withdrawCeraliveOfferIfInstalled(
	offer: readonly OfferedPackage[] | null,
): Promise<void> {
	if (offer === null || !showing(offer)) return;
	const generation = slotGeneration;
	if (
		!(await provenInstalled(offer)) ||
		generation !== slotGeneration ||
		!showing(offer)
	)
		return;
	withdraw("dpkg shows the install's offer");
}

/**
 * Loads the last verdict, for a check to read back against dpkg. It announces,
 * removes and runs nothing: only this process's own complete check writes the slot.
 */
export function initCeraliveUpdateNotice(
	options: CeraliveUpdateNoticeOptions = {},
): void {
	store = {
		path: options.path ?? RECORD_FILE,
		write: options.write ?? writeFileAtomicSync,
		run: options.run ?? spawnWithTimeout,
	};
	latest = readRecord(store.path);
	persisted = latest === undefined ? undefined : JSON.stringify(latest);
}
